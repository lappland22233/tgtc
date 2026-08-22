/**
 * 缩略图 / 视频封面服务（FileService 拆分出的 Nest provider）
 *
 * 职责：
 * - 图片缩略图：从 Telegram 下载原图，sharp 生成十分之一分辨率 WebP，原子发布。
 * - 视频标准/高清封面：FFmpeg 抽帧为 WebP（低清封面一次性升级高清）。
 * - 启动扫描补齐缺失缩略图（syncMissingThumbnails）。
 * - 缩略图文件读取 / 删除（覆盖、删除文件时联动清理）。
 * - 同文件构建去重（thumbnailBuilds / videoCoverBuilds），避免在线请求、上传回调和
 *   启动扫描并发竞写。
 *
 * 边界：
 * - 不涉及文件业务权限校验（由 FileService 的 getThumbnailStream 等负责）。
 * - 目录路径由 THUMBNAIL_DIR 配置决定，与 FileCacheService 的缓存目录独立。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { File } from '../common/entities/file.entity';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramStreamPathError } from '../telegram/telegram.errors';
import { FileCacheService } from './file-cache.service';

/** 视频标准封面最大宽度（FFmpeg scale 上限） */
const VIDEO_COVER_MAX_WIDTH = 480;
/** 高清视频封面最大宽度（前端检测到标准封面低于阈值时切换到高清接口） */
const VIDEO_HD_COVER_MAX_WIDTH = 1280;
/** 高清封面 WebP 质量 */
const VIDEO_HD_COVER_QUALITY = 75;
/** 视频封面远程回源的单文件大小上限（G4-09）：超过则跳过远程回源，避免整段下载写满缩略图盘 */
const REMOTE_SOURCE_MAX_BYTES = 500 * 1024 * 1024;
/** 远程回源前要求缩略图盘保留的最小余量（G4-09） */
const MIN_THUMBNAIL_DISK_FREE = 512 * 1024 * 1024;

export interface VideoCoverOptions {
  sourcePath?: string;
  sourceBuffer?: Buffer;
  allowRemoteSource?: boolean;
}

@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);
  private readonly thumbnailDir: string;
  /** 同一进程内按文件合并缩略图生成，避免在线请求、上传回调和启动扫描竞写。 */
  private readonly thumbnailBuilds = new Map<string, Promise<void>>();
  private readonly videoCoverBuilds = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(File)
    private readonly fileRepository: Repository<File>,
    private readonly telegramService: TelegramService,
    private readonly fileCacheService: FileCacheService,
    configService: ConfigService,
  ) {
    this.thumbnailDir = configService.get<string>('THUMBNAIL_DIR') || path.join(process.cwd(), 'tmp', 'thumbnails');
  }

  getThumbnailDir(): string {
    return this.thumbnailDir;
  }

  /** 确保缩略图目录存在（幂等） */
  ensureThumbnailDir(): void {
    if (!fs.existsSync(this.thumbnailDir)) {
      fs.mkdirSync(this.thumbnailDir, { recursive: true });
      this.logger.log(`缩略图目录已创建: ${this.thumbnailDir}`);
    }
  }

  /**
   * 启动时扫描数据库，为所有图片/视频补齐缩略图或封面。
   * 视频允许在后台实时回源生成；串行处理避免启动瞬间占满 Telegram 与 FFmpeg。
   */
  async syncMissingThumbnails(): Promise<void> {
    const batchSize = 25;
    let lastId: string | null = null;
    let totalProcessed = 0;

    // 使用主键游标遍历全部媒体，而不是只查 thumbnailPath=NULL：
    // 数据库路径存在但磁盘产物丢失时同样需要重新生成。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const query = this.fileRepository
        .createQueryBuilder('file')
        .select(['file.id', 'file.mimeType', 'file.telegramFileId', 'file.filename', 'file.thumbnailPath'])
        .where('file.isDeleted = false')
        .andWhere('(file.mimeType LIKE :imagePrefix OR file.mimeType LIKE :videoPrefix)', {
          imagePrefix: 'image/%',
          videoPrefix: 'video/%',
        })
        .orderBy('file.id', 'ASC')
        .take(batchSize);
      if (lastId) query.andWhere('file.id > :lastId', { lastId });
      const files = await query.getMany();

      if (files.length === 0) break;
      for (const file of files) {
        const expectedName = file.mimeType.startsWith('video/') ? `${file.id}.video.webp` : `${file.id}.webp`;
        const expectedPath = path.join(this.thumbnailDir, expectedName);
        if (!fs.existsSync(expectedPath)) {
          if (file.mimeType.startsWith('video/')) {
            await this.generateAndSaveVideoCover(file, { allowRemoteSource: true });
          } else {
            await this.generateAndSaveThumbnail(file);
          }
          totalProcessed++;
        } else if (file.thumbnailPath !== expectedName) {
          await this.fileRepository.update(
            { id: file.id },
            { thumbnailPath: expectedName },
          );
        }
      }
      lastId = files[files.length - 1].id;
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    if (totalProcessed > 0) {
      this.logger.log(`媒体缩略图同步完成: 处理了 ${totalProcessed} 个缺失产物`);
    }
  }

  /**
   * R6：从 Telegram 拉取原始媒体流用于缩略图/封面生成。
   * getFileStream 已具备安全打开能力（ENOENT 转 TelegramStreamPathError）；
   * 命中"路径失效可恢复"时单次重试回源（再次 getFileStream 会重新触发 getFile 刷新路径）。
   * 仍失败则抛出，由调用方按原 catch 记日志即可——缩略图缺失不应把原文件标 error。
   */
  private async fetchRemoteSource(file: File): Promise<Readable> {
    try {
      const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);
      return stream;
    } catch (error) {
      if (error instanceof TelegramStreamPathError) {
        this.logger.warn(`缩略图回源命中路径失效，单次重试回源 id=${file.id}`);
        const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);
        return stream;
      }
      throw error;
    }
  }

  /**
   * 缩略图盘剩余空间是否足够（G4-09）。
   * 用 bavail 计算无特权进程可用空间；statfs 失败时保守返回 false（跳过远程回源）。
   */
  private hasEnoughThumbnailDiskSpace(): boolean {
    try {
      const { statfsSync } = require('fs');
      const stats = statfsSync(this.thumbnailDir);
      const avail = stats.bsize * (stats.bavail > 0 ? stats.bavail : 0);
      return avail >= MIN_THUMBNAIL_DISK_FREE;
    } catch {
      return false;
    }
  }

  /**
   * 带大小上限的远程回源落盘（G4-09）：
   * pipeline 累计字节超过 maxBytes 即中止（销毁流），避免整段超大文件写满缩略图盘。
   */
  private async downloadRemoteWithLimit(stream: Readable, destPath: string, maxBytes: number): Promise<void> {
    const { Transform } = await import('stream');
    const { pipeline } = await import('stream/promises');
    let total = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) {
        total += chunk.length;
        if (total > maxBytes) {
          callback(new Error(`远程回源超过大小上限（${maxBytes} bytes）`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(stream, counter, fs.createWriteStream(destPath));
  }

  /** 生成视频标准封面（按文件合并去重） */
  async generateAndSaveVideoCover(
    file: File,
    options: VideoCoverOptions = {},
  ): Promise<void> {
    if (!file.mimeType?.startsWith('video/')) return;
    const existing = this.videoCoverBuilds.get(file.id);
    if (existing) return existing;

    const build = this.buildVideoCover(file, options).finally(() => {
      if (this.videoCoverBuilds.get(file.id) === build) this.videoCoverBuilds.delete(file.id);
    });
    this.videoCoverBuilds.set(file.id, build);
    return build;
  }

  private async buildVideoCover(
    file: File,
    options: VideoCoverOptions,
  ): Promise<void> {
    const coverFilename = `${file.id}.video.webp`;
    const coverPath = path.join(this.thumbnailDir, coverFilename);
    if (fs.existsSync(coverPath)) {
      if (file.thumbnailPath !== coverFilename) {
        await this.fileRepository.update(
          { id: file.id },
          { thumbnailPath: coverFilename },
        );
      }
      return;
    }

    const buildId = uuidv4();
    const tmpSource = path.join(this.thumbnailDir, `${file.id}.${buildId}.video.tmp`);
    const tmpCover = path.join(this.thumbnailDir, `${file.id}.${buildId}.cover.tmp.webp`);
    let sourcePath = options.sourcePath && fs.existsSync(options.sourcePath)
      ? options.sourcePath
      : this.fileCacheService.getCachedPath(file.id);
    try {
      if (!sourcePath && options.sourceBuffer?.length) {
        await fs.promises.writeFile(tmpSource, options.sourceBuffer);
        sourcePath = tmpSource;
      }
      if (!sourcePath && options.allowRemoteSource) {
        // G4-09：远程回源整段下载前做大小上限与磁盘余量检查，避免写满缩略图盘
        if (Number.isFinite(file.size) && file.size > REMOTE_SOURCE_MAX_BYTES) {
          this.logger.warn(`视频封面远程回源跳过超大文件 id=${file.id}（${file.size} bytes）`);
          return;
        }
        if (!this.hasEnoughThumbnailDiskSpace()) {
          this.logger.warn(`缩略图盘空间不足，跳过视频封面远程回源 id=${file.id}`);
          return;
        }
        const stream = await this.fetchRemoteSource(file);
        await this.downloadRemoteWithLimit(stream, tmpSource, REMOTE_SOURCE_MAX_BYTES);
        sourcePath = tmpSource;
      }
      if (!sourcePath) return; // 页面封面请求不得触发整视频回源
      const resolvedSourcePath: string = sourcePath;

      await this.extractVideoFrame(resolvedSourcePath, tmpCover, VIDEO_COVER_MAX_WIDTH, 65);
      await fs.promises.rename(tmpCover, coverPath);
      await this.fileRepository.update(
        { id: file.id },
        { thumbnailPath: coverFilename },
      );
    } catch (error) {
      this.logger.warn(`视频封面生成失败 id=${file.id}: ${(error as Error).message}`);
    } finally {
      await Promise.all([
        fs.promises.unlink(tmpSource).catch(() => {}),
        fs.promises.unlink(tmpCover).catch(() => {}),
      ]);
    }
  }

  /**
   * 抽取视频单帧为 WebP（标准/高清封面共用）。
   * 输出目录须由调用方保证存在；失败时抛出 FFmpeg stderr 摘要。
   */
  private async extractVideoFrame(
    sourcePath: string,
    outputPath: string,
    scaleWidth: number,
    quality: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', '1', '-i', sourcePath,
        '-frames:v', '1', '-vf', `scale=${scaleWidth}:-2:force_original_aspect_ratio=decrease`,
        '-c:v', 'libwebp', '-quality', String(quality), '-f', 'webp', outputPath,
      ], { windowsHide: true });
      const timeoutMs = 60 * 1000;
      let stderr = '';
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(() => {
        try { ffmpeg.kill('SIGKILL'); } catch { /* 子进程可能已退出 */ }
        settle(new Error(`FFmpeg 抽帧超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timeout.unref?.();
      ffmpeg.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
      ffmpeg.once('error', error => settle(error));
      ffmpeg.once('close', code => {
        if (code === 0) settle();
        else settle(new Error(stderr || `FFmpeg 退出码 ${code}`));
      });
    });
  }

  /** 生成高清视频封面（按文件合并去重）。仅从本地正式缓存提取，冷资源直接跳过。 */
  async generateAndSaveHdVideoCover(file: File): Promise<void> {
    if (!file.mimeType?.startsWith('video/')) return;
    const key = `hd:${file.id}`;
    const existing = this.videoCoverBuilds.get(key);
    if (existing) return existing;

    const build = this.buildHdVideoCover(file).finally(() => {
      if (this.videoCoverBuilds.get(key) === build) this.videoCoverBuilds.delete(key);
    });
    this.videoCoverBuilds.set(key, build);
    return build;
  }

  private async buildHdVideoCover(file: File): Promise<void> {
    const coverFilename = `${file.id}.video.hd.webp`;
    const coverPath = path.join(this.thumbnailDir, coverFilename);
    if (fs.existsSync(coverPath)) return;

    const sourcePath = this.fileCacheService.getCachedPath(file.id);
    if (!sourcePath) return; // 冷资源不生成高清封面（避免整视频回源）

    const buildId = uuidv4();
    const tmpCover = path.join(this.thumbnailDir, `${file.id}.${buildId}.hd-cover.tmp.webp`);
    try {
      await this.extractVideoFrame(sourcePath, tmpCover, VIDEO_HD_COVER_MAX_WIDTH, VIDEO_HD_COVER_QUALITY);
      await fs.promises.rename(tmpCover, coverPath);
    } catch (error) {
      this.logger.warn(`高清封面生成失败 id=${file.id}: ${(error as Error).message}`);
    } finally {
      await fs.promises.unlink(tmpCover).catch(() => {});
    }
  }

  /**
   * 从 Telegram 下载原图，用 sharp 生成十分之一分辨率缩略图，存到本地。
   * 成功后将缩略图路径写入 File 实体。
   */
  async generateAndSaveThumbnail(file: File): Promise<void> {
    if (!file.mimeType?.startsWith('image/')) return;

    const activeBuild = this.thumbnailBuilds.get(file.id);
    if (activeBuild) return activeBuild;

    const build = this.buildAndSaveThumbnail(file).finally(() => {
      if (this.thumbnailBuilds.get(file.id) === build) {
        this.thumbnailBuilds.delete(file.id);
      }
    });
    this.thumbnailBuilds.set(file.id, build);
    return build;
  }

  private async buildAndSaveThumbnail(file: File): Promise<void> {
    if (file.thumbnailPath) {
      const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
      if (fs.existsSync(fullPath)) return;
    }

    // 唯一临时文件 + 原子发布，避免并发任务或异常退出留下半成品。
    const buildId = uuidv4();
    const tmpSource = path.join(this.thumbnailDir, `${file.id}.${buildId}.src.tmp`);
    const tmpThumbnail = path.join(this.thumbnailDir, `${file.id}.${buildId}.webp.tmp`);
    const thumbFilename = `${file.id}.webp`;
    const thumbPath = path.join(this.thumbnailDir, thumbFilename);
    try {
      // G4-09：图片原图远程回源同样受大小上限与磁盘余量约束
      if (Number.isFinite(file.size) && file.size > REMOTE_SOURCE_MAX_BYTES) {
        this.logger.warn(`缩略图远程回源跳过超大文件 id=${file.id}（${file.size} bytes）`);
        return;
      }
      if (!this.hasEnoughThumbnailDiskSpace()) {
        this.logger.warn(`缩略图盘空间不足，跳过缩略图远程回源 id=${file.id}`);
        return;
      }
      const stream = await this.fetchRemoteSource(file);
      await this.downloadRemoteWithLimit(stream, tmpSource, REMOTE_SOURCE_MAX_BYTES);

      const metadata = await sharp(tmpSource).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      if (width <= 0 || height <= 0) throw new Error('无法读取图片尺寸');

      // 小图也统一生成 WebP，持久化完成状态，避免每次请求及每次启动重复回源探测。
      const isSmallImage = width < 300 && height < 300;
      const thumbWidth = isSmallImage ? width : Math.max(16, Math.round(width / 10));
      const thumbHeight = isSmallImage ? height : Math.max(16, Math.round(height / 10));

      await sharp(tmpSource)
        .resize(thumbWidth, thumbHeight, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 60 })
        .toFile(tmpThumbnail);
      await fs.promises.rename(tmpThumbnail, thumbPath);

      await this.fileRepository.update(
        { id: file.id },
        { thumbnailPath: thumbFilename },
      );
    } catch (err) {
      this.logger.warn(`缩略图生成失败 id=${file.id}: ${(err as Error).message}`);
    } finally {
      await Promise.all([
        fs.promises.unlink(tmpSource).catch(() => {}),
        fs.promises.unlink(tmpThumbnail).catch(() => {}),
      ]);
    }
  }

  /** 读取本地缩略图文件内容（异步，避免 readFileSync 阻塞事件循环）。 */
  async readLocalThumbnail(file: File): Promise<Buffer | null> {
    if (!file.thumbnailPath) return null;
    const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
    try {
      return await fs.promises.readFile(fullPath);
    } catch {
      // 文件不存在或读取失败
      return null;
    }
  }

  /** 读取已生成的高清视频封面文件内容，不存在返回 null。 */
  async readHdLocalThumbnail(file: File): Promise<Buffer | null> {
    const coverName = `${file.id}.video.hd.webp`;
    const fullPath = path.join(this.thumbnailDir, coverName);
    try {
      return await fs.promises.readFile(fullPath);
    } catch {
      return null;
    }
  }

  /** 删除本地缩略图文件（含标准与高清封面候选）。 */
  deleteLocalThumbnail(file: File): void {
    if (!file.thumbnailPath) return;
    const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch (err) {
      this.logger.warn(`删除缩略图文件失败: ${fullPath}, ${(err as Error).message}`);
    }
  }

  /**
   * 集中"按 fileId 枚举派生缩略图/封面文件名"（G4-08）：
   * 覆盖/删除文件时所有可能存在的产物都从这里列出，避免遗漏新派生类型
   * （如高清封面 ${fileId}.video.hd.webp）导致磁盘残留。
   */
  enumerateThumbnailDerivatives(fileId: string): string[] {
    return [
      `${fileId}.webp`,
      `${fileId}.video.webp`,
      `${fileId}.video.hd.webp`,
    ];
  }

  /** 按 fileId 删除该文件的所有缩略图派生产物（标准/视频/高清封面，覆盖与删除联动清理）。 */
  async deleteThumbnailsForFileId(fileId: string): Promise<void> {
    await Promise.all(
      this.enumerateThumbnailDerivatives(fileId).map(name =>
        fs.promises.unlink(path.join(this.thumbnailDir, name)).catch(() => {}),
      ),
    );
  }

  /** 获取已存在的缩略图文件路径（供推断缺失路径时复用）。 */
  getInferredThumbnailPath(fileId: string, kind: 'image' | 'video'): string {
    const name = kind === 'video' ? `${fileId}.video.webp` : `${fileId}.webp`;
    return path.join(this.thumbnailDir, name);
  }
}
