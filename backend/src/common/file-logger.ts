import { LoggerService } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 异步文件日志器（带时间分片与轮转）。
 *
 * 相对旧版的改进：
 * - 使用持久化的 fs.createWriteStream 异步写入，避免每条日志同步写盘阻塞事件循环。
 * - 目录创建延迟到首次写入并包裹 try/catch，避免模块 import 阶段因 mkdir 失败抛错。
 * - 按时间分片：日志按天（默认）或按小时写入独立文件（app-YYYY-MM-DD.log /
 *   app-YYYY-MM-DD-HH.log），便于快速定位某一天/某一时段的日志。
 * - 自动轮转：跨时间片时自动切换文件；单个文件超过大小阈值时归档为带递增序号的
 *   文件（app-YYYY-MM-DD.log.1 / .2 ...）。
 * - 保留期清理：定时扫描并删除超过保留天数的日志文件，防止磁盘写满。
 *
 * 配置项（均为可选，通过环境变量覆盖，读取时不缓存以便 .env 加载后生效）：
 * - LOG_DIR               日志目录，默认 <cwd>/tmp/logs
 * - LOG_ROTATION_INTERVAL 分片粒度：daily（默认）| hourly
 * - LOG_MAX_FILE_SIZE     单文件最大字节数，默认 20MB
 * - LOG_RETENTION_DAYS    保留天数，默认 7
 */
const DEFAULT_LOG_DIR = 'tmp/logs';
const DEFAULT_MAX_LOG_SIZE = 20 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_BUFFERED_LINES = 2000;
/** 轮转/清理兜底定时器间隔：即使无写入也按时切分并清理过期文件 */
const ROTATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

type RotationInterval = 'daily' | 'hourly';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function getLogDir(): string {
  const dir = process.env.LOG_DIR;
  return dir ? path.resolve(dir) : path.resolve(process.cwd(), DEFAULT_LOG_DIR);
}

function getRotationInterval(): RotationInterval {
  return process.env.LOG_ROTATION_INTERVAL === 'hourly' ? 'hourly' : 'daily';
}

function getMaxLogSize(): number {
  return parsePositiveInt(process.env.LOG_MAX_FILE_SIZE, DEFAULT_MAX_LOG_SIZE);
}

function getRetentionDays(): number {
  return parsePositiveInt(process.env.LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

/**
 * 当前时间片对应的日志文件名。
 * daily:  app-2026-08-17.log
 * hourly: app-2026-08-17-14.log
 */
function currentLogFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  if (getRotationInterval() === 'hourly') {
    const h = String(now.getHours()).padStart(2, '0');
    return `app-${y}-${m}-${d}-${h}.log`;
  }
  return `app-${y}-${m}-${d}.log`;
}

// ===== 运行时状态（模块级单例，与 Nest LoggerService 单一实例语义一致） =====
let stream: fs.WriteStream | null = null;
let streamFailed = false;
let backpressured = false;
const pendingLines: string[] = [];
let approximateSize = 0;
let currentFileName: string | null = null;
let rotationTimer: NodeJS.Timeout | null = null;

/** 将背压期间积压的日志写回当前流，直到再次背压或缓冲清空 */
function flushPending(): void {
  while (stream && pendingLines.length > 0 && !backpressured) {
    const line = pendingLines.shift()!;
    approximateSize += Buffer.byteLength(line, 'utf8');
    backpressured = !stream.write(line);
  }
}

/** 关闭当前流并重置相关状态。积压的 pending 保留，将写入下一个分片文件 */
function closeStream(): void {
  if (!stream) return;
  const s = stream;
  stream = null;
  backpressured = false;
  currentFileName = null;
  approximateSize = 0;
  try {
    s.end();
  } catch {
    // 关闭失败不阻断后续写入
  }
}

/** 惰性创建写入流，失败时标记 streamFailed 并降级为仅 console 输出 */
function ensureStream(): fs.WriteStream | null {
  if (stream) return stream;
  if (streamFailed) return null;
  try {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    currentFileName = currentLogFileName();
    const fullPath = path.join(dir, currentFileName);
    approximateSize = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
    const s = fs.createWriteStream(fullPath, { flags: 'a', encoding: 'utf-8' });
    s.on('drain', () => {
      // 仅当前活跃流可消费积压，避免已关闭旧流的 drain 事件串扰
      if (stream !== s) return;
      backpressured = false;
      flushPending();
    });
    // 写入错误不能让进程崩溃，标记失败后停止文件写入（console 仍可用）
    s.on('error', () => {
      streamFailed = true;
      stream = null;
      backpressured = false;
      currentFileName = null;
      pendingLines.length = 0;
    });
    stream = s;
    return s;
  } catch {
    streamFailed = true;
    return null;
  }
}

/** 单文件大小超限时，将当前文件归档为带递增序号的文件（app-YYYY-MM-DD.log.1 / .2 ...） */
function rotateBySize(): void {
  if (!stream || !currentFileName) return;
  const fileName = currentFileName;
  const oldPath = path.join(getLogDir(), fileName);
  closeStream();
  try {
    let max = 0;
    const prefix = fileName + '.';
    for (const f of fs.readdirSync(getLogDir())) {
      if (f.startsWith(prefix)) {
        const n = parseInt(f.slice(prefix.length), 10);
        if (Number.isFinite(n) && n >= max) max = n;
      }
    }
    fs.renameSync(oldPath, `${oldPath}.${max + 1}`);
  } catch {
    // 重命名失败时保留原文件，后续仍可继续追加
  }
}

/** 清理超过保留天数的日志文件（按修改时间判定，兼容旧命名 app.log / app.log.1） */
function cleanupOldLogs(): void {
  const cutoff = Date.now() - getRetentionDays() * 24 * 60 * 60 * 1000;
  try {
    const dir = getLogDir();
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.startsWith('app-') && f !== 'app.log' && !f.startsWith('app.log.')) continue;
      if (stream && f === currentFileName) continue;
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  } catch {
    // 清理失败不影响日志写入
  }
}

/** 启动兜底定时器：无写入时也能按时切分文件并清理过期日志 */
function startRotationTimer(): void {
  if (rotationTimer) return;
  rotationTimer = setInterval(() => {
    const expected = currentLogFileName();
    if (stream && currentFileName && currentFileName !== expected) {
      closeStream();
    }
    cleanupOldLogs();
  }, ROTATION_CHECK_INTERVAL_MS);
  rotationTimer.unref?.();
}

function formatLog(level: string, message: string, context?: string, trace?: string): string {
  const ts = new Date().toISOString();
  const ctx = context ? ` [${context}]` : '';
  let line = `${ts} ${level}${ctx} ${message}`;
  if (trace) {
    line += `\n${trace}`;
  }
  return line;
}

function appendLine(line: string): void {
  const serialized = line + '\n';
  const bytes = Buffer.byteLength(serialized, 'utf8');

  // 时间片切换：跨天/跨小时时关闭旧流，切换到新分片文件，并顺带清理过期日志
  const expected = currentLogFileName();
  if (stream && currentFileName && currentFileName !== expected) {
    closeStream();
    cleanupOldLogs();
  }

  // 单文件大小轮转（仅文件已有内容时触发，避免空文件被归档）
  if (stream && approximateSize > 0 && approximateSize + bytes >= getMaxLogSize()) {
    rotateBySize();
  }

  const s = ensureStream();
  if (!s) return;
  try {
    // 优先消费积压，避免跨片切换后旧日志长时间滞留内存
    if (!backpressured && pendingLines.length > 0) {
      flushPending();
    }
    if (backpressured) {
      if (pendingLines.length < MAX_BUFFERED_LINES) pendingLines.push(serialized);
      return;
    }
    approximateSize += bytes;
    backpressured = !s.write(serialized);
  } catch {
    // 静默失败，避免日志写入影响应用
  }
}

export class FileLogger implements LoggerService {
  constructor() {
    startRotationTimer();
  }

  log(message: any, context?: string): void {
    appendLine(formatLog('LOG', String(message), context));
    console.log(`[${context || 'Nest'}] ${message}`);
  }

  error(message: any, trace?: string, context?: string): void {
    appendLine(formatLog('ERROR', String(message), context, trace));
    console.error(`[${context || 'Nest'}] ${message}`, trace || '');
  }

  warn(message: any, context?: string): void {
    appendLine(formatLog('WARN', String(message), context));
    console.warn(`[${context || 'Nest'}] ${message}`);
  }

  debug(message: any, context?: string): void {
    appendLine(formatLog('DEBUG', String(message), context));
    console.debug(`[${context || 'Nest'}] ${message}`);
  }

  verbose(message: any, context?: string): void {
    appendLine(formatLog('VERBOSE', String(message), context));
    console.log(`[${context || 'Nest'}] ${message}`);
  }
}
