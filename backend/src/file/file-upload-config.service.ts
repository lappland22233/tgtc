import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { parseFileSize } from './file-utils';

/**
 * 上传配置与文件类型/大小校验（M6 拆分：从 FileService 抽出）。
 *
 * 职责边界：
 * - 热更新上传配置：最大文件大小、类型过滤模式（blacklist/whitelist）与过滤清单；
 * - 类型校验：magic bytes 优先、失败时按后缀回退（兼容历史行为）；
 * - 样本读取：内存存储与磁盘存储两种 Multer 形态。
 *
 * 不负责：访问次数默认值（FILE_ACCESS_COUNT_* 仍在 FileService，属于上传业务参数
 * 而非类型/大小校验规则）。
 *
 * 数据来源：启动时读 ConfigService 作为兜底，运行期以 ConfigCacheService 热更新为准。
 */

/** 已知复合扩展名列表（优先匹配，防止 .tar.gz 被错误识别为 .gz） */
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz'] as const;

/** magic bytes 采样长度 */
const FILE_SAMPLE_BYTES = 4100;

@Injectable()
export class FileUploadConfigService implements OnModuleInit {
  private readonly logger = new Logger(FileUploadConfigService.name);
  private maxFileSize: number;
  private fileTypeMode: 'blacklist' | 'whitelist' = 'blacklist';
  private fileTypeFilter: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly configCacheService: ConfigCacheService,
  ) {
    this.maxFileSize = parseFileSize(this.configService.get<string>('MAX_FILE_SIZE'));
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** 从配置缓存重新加载（启动时与 config.changed 事件触发） */
  async reload(): Promise<void> {
    const [maxFileSize, fileTypeMode, fileTypeFilter] = await Promise.all([
      this.configCacheService.get('MAX_FILE_SIZE', '20971520'),
      this.configCacheService.get('FILE_TYPE_MODE', 'blacklist'),
      this.configCacheService.get('FILE_TYPE_FILTER', ''),
    ]);
    this.maxFileSize = parseFileSize(maxFileSize);
    this.fileTypeMode = (fileTypeMode === 'whitelist' ? 'whitelist' : 'blacklist');
    this.fileTypeFilter = fileTypeFilter
      ? fileTypeFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];
  }

  /** 当前最大文件大小（同步读取，热更新后即时生效） */
  get maxFileSizeBytes(): number {
    return this.maxFileSize;
  }

  async getMaxFileSize(): Promise<number> {
    return this.maxFileSize;
  }

  async getFileTypeConfig(): Promise<{
    fileTypeMode: 'blacklist' | 'whitelist';
    fileTypeFilter: string[];
  }> {
    return {
      fileTypeMode: this.fileTypeMode,
      fileTypeFilter: [...this.fileTypeFilter],
    };
  }

  /**
   * 从 Multer 文件对象中提取前 maxBytes 字节用于 magic bytes 检测。
   * 同时支持内存存储 (buffer) 和磁盘存储 (path) 模式。
   */
  getFileSample(
    file: Express.Multer.File,
    maxBytes: number = FILE_SAMPLE_BYTES,
  ): Buffer {
    if (file.buffer && file.buffer.length > 0) {
      const end = Math.min(file.buffer.length, maxBytes);
      return file.buffer.subarray(0, end);
    }

    if (file.path && fs.existsSync(file.path)) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(file.path, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        return bytesRead === 0 ? Buffer.alloc(0) : buffer.subarray(0, bytesRead);
      } finally {
        if (fd !== undefined) {
          fs.closeSync(fd);
        }
      }
    }

    return Buffer.alloc(0);
  }

  /**
   * 从文件路径读取前 maxBytes 字节（供分片上传合并后使用）
   */
  getFileSampleFromPath(
    filePath: string,
    maxBytes: number = FILE_SAMPLE_BYTES,
  ): Buffer {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return bytesRead === 0 ? Buffer.alloc(0) : buffer.subarray(0, bytesRead);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  /**
   * 检查文件类型是否被允许（含 magic bytes 检测）
   *
   * - 有 buffer → 使用 fileTypeFromBuffer() 检测 magic bytes
   *   - 检测到类型 → 使用检测结果进行过滤
   *   - 未检测到 → 白名单直接拒绝，黑名单回退到文件名后缀匹配
   * - 无 buffer → 回退到后缀规则（向后兼容）
   */
  async isFileTypeAllowed(
    filename: string,
    buffer?: Buffer,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // === 阶段 1: Magic bytes 检测 ===
    let detectedExt: string | null = null;

    if (buffer && buffer.length > 0) {
      const lowerName = filename.toLowerCase();
      const hasZipSignature = buffer.length >= 4
        && buffer[0] === 0x50
        && buffer[1] === 0x4b
        && (
          (buffer[2] === 0x03 && buffer[3] === 0x04)
          || (buffer[2] === 0x05 && buffer[3] === 0x06)
          || (buffer[2] === 0x07 && buffer[3] === 0x08)
        );

      // file-type 会深入遍历 ZIP entry。对仅含文件前缀的样本，首个 entry
      // 超出样本边界时会抛 EndOfStreamError；ZIP 文件只需验证容器签名即可。
      if (lowerName.endsWith('.zip') && hasZipSignature) {
        detectedExt = 'zip';
      } else {
        try {
          const result = await fileTypeFromBuffer(buffer);
          if (result) {
            detectedExt = result.ext;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`文件类型解析失败，按未识别类型处理: ${filename} (${message})`);
        }
      }
    }

    // === 阶段 2: 确定用于过滤的扩展名 ===
    let effectiveExt: string;

    if (detectedExt) {
      const dotExt = `.${detectedExt}`;
      let matchedCompound: string | null = null;
      for (const ce of COMPOUND_EXTENSIONS) {
        if (filename.toLowerCase().endsWith(ce) && ce.endsWith(dotExt)) {
          matchedCompound = ce;
          break;
        }
      }
      effectiveExt = matchedCompound || dotExt;
    } else if (this.fileTypeMode === 'whitelist') {
      return {
        allowed: false,
        reason: '无法识别文件类型，白名单模式下仅允许可明确识别的文件类型',
      };
    } else {
      // 黑名单模式：回退到文件名后缀匹配
      const lowerName = filename.toLowerCase();
      let ext = '(无扩展名)';
      for (const ce of COMPOUND_EXTENSIONS) {
        if (lowerName.endsWith(ce)) {
          ext = ce;
          break;
        }
      }
      if (ext === '(无扩展名)') {
        const lastDot = lowerName.lastIndexOf('.');
        ext = lastDot > 0 ? '.' + lowerName.slice(lastDot + 1) : '(无扩展名)';
      }
      effectiveExt = ext;
    }

    // === 阶段 3: 特殊规则 ===
    if (this.fileTypeMode === 'blacklist' && this.fileTypeFilter.length === 0) {
      return { allowed: true };
    }
    if (this.fileTypeMode === 'whitelist' && this.fileTypeFilter.length === 0) {
      return {
        allowed: false,
        reason: `文件类型 ${effectiveExt} 被拒绝：白名单模式未配置允许类型`,
      };
    }

    // === 阶段 4: 过滤器匹配 ===
    const matched = this.fileTypeFilter.includes(effectiveExt);

    if (this.fileTypeMode === 'blacklist') {
      if (matched) {
        return { allowed: false, reason: `文件类型 ${effectiveExt} 被拒绝：该类型在禁止列表中` };
      }
    } else {
      if (!matched) {
        return { allowed: false, reason: `文件类型 ${effectiveExt} 被拒绝：该类型不在允许列表中` };
      }
    }

    return { allowed: true };
  }
}
