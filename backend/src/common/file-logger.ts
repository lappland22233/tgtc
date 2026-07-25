import { LoggerService } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'tmp', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_LOG_SIZE = 20 * 1024 * 1024;
const MAX_BUFFERED_LINES = 2000;

/**
 * 异步文件日志器。
 *
 * 改进点（相对旧版 appendFileSync）：
 * - 使用持久化的 fs.createWriteStream 异步写入，避免每条日志同步写盘阻塞事件循环。
 * - 目录创建延迟到首次写入并包裹 try/catch，避免模块 import 阶段因 mkdir 失败抛错。
 *
 * 已知限制：未引入日志轮转（如 winston-daily-rotate-file / logrotate）。
 * app.log 会持续增长，生产环境建议通过外部 logrotate 或容器日志驱动管理大小，
 * 否则可能写满磁盘。此处保持轻量实现，不额外引入轮转依赖。
 */
let stream: fs.WriteStream | null = null;
let streamFailed = false;
let backpressured = false;
const pendingLines: string[] = [];
let approximateSize = 0;

function ensureStream(): fs.WriteStream | null {
  if (stream) return stream;
  if (streamFailed) return null;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_LOG_SIZE) {
      const rotated = path.join(LOG_DIR, 'app.log.1');
      fs.rmSync(rotated, { force: true });
      fs.renameSync(LOG_FILE, rotated);
    }
    approximateSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf-8' });
    stream.on('drain', () => {
      backpressured = false;
      const target = stream;
      while (target && pendingLines.length > 0 && !backpressured) {
        const buffered = pendingLines.shift()!;
        approximateSize += Buffer.byteLength(buffered, 'utf8');
        backpressured = !target.write(buffered);
      }
    });
    // 写入错误不能让进程崩溃，标记失败后停止文件写入（console 仍可用）
    stream.on('error', () => {
      streamFailed = true;
      stream = null;
      pendingLines.length = 0;
    });
    return stream;
  } catch {
    streamFailed = true;
    return null;
  }
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
  if (approximateSize + bytes >= MAX_LOG_SIZE && stream) {
    stream.end();
    stream = null;
    backpressured = false;
    try {
      const rotated = path.join(LOG_DIR, 'app.log.1');
      fs.rmSync(rotated, { force: true });
      if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, rotated);
      approximateSize = 0;
    } catch {
      streamFailed = true;
      return;
    }
  }
  const s = ensureStream();
  if (!s) return;
  try {
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
