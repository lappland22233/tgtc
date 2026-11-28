import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A-13 静态守卫：流式/文件端点的错误响应必须走 StreamResponderService.handleError。
 *
 * 事故形态：thumbnail / thumbnail-hd / legacy-public 三处曾手写 catch，
 * 直接把 `error.message` 塞进 5xx 响应体，绕过 handleError 的
 * 「5xx 一律用安全通用文案 + requestId」脱敏规则（G4-12），
 * 向客户端泄漏内部错误细节（路径、驱动报错、依赖地址等）。
 */
const CONTROLLER = join(__dirname, 'file.controller.ts');

describe('file.controller 错误响应脱敏（A-13）', () => {
  const source = readFileSync(CONTROLLER, 'utf8');

  it('不得再出现把 error.message 直接写入响应体的写法', () => {
    // 手写 catch 的特征：先取 message，再 res.status(...).json({ ... message ... })
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /const message = .*error.*\.message/.test(line));
    expect(offenders).toEqual([]);
  });

  it('不得再手写 res.status(...).json 装配错误响应（限流 429 除外）', () => {
    const lines = source.split('\n');
    const offenders: number[] = [];
    lines.forEach((line, i) => {
      if (!/res\.status\(.*\)\.json\(/.test(line)) return;
      // 向上找 6 行，限流分支允许自行装配 429
      const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      if (/TOO_MANY_REQUESTS|legacyRate\.allowed/.test(context)) return;
      offenders.push(i + 1);
    });
    expect(offenders).toEqual([]);
  });

  it('三个曾手写 catch 的端点都改为调用 handleError', () => {
    // thumbnail / thumbnail-hd / legacy-public 各自的 catch 必须委托统一出口
    const handlerCalls = source.match(/this\.streamResponder\.handleError\(/g) ?? [];
    expect(handlerCalls.length).toBeGreaterThanOrEqual(6);
  });
});