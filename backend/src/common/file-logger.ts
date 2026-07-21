import { LoggerService } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'tmp', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

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

function ensureStream(): fs.WriteStream | null {
  if (stream) return stream;
  if (streamFailed) return null;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf-8' });
    // 写入错误不能让进程崩溃，标记失败后停止文件写入（console 仍可用）
    stream.on('error', () => {
      streamFailed = true;
      stream = null;
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
  const s = ensureStream();
  if (!s) return;
  // 异步写入；背压时 write 返回 false 但内部会缓冲，无需阻塞调用方
  try {
    s.write(line + '\n');
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
