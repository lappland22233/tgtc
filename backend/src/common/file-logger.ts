import { LoggerService } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'tmp', 'logs');

// 确保日志目录存在
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, 'app.log');

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
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {
    // 静默失败，避免日志写入阻塞应用
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
