import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';

/**
 * 策略 A 移除的**静态回归守卫**（源码级，不依赖运行时）。
 *
 * 为什么需要它：策略 A（「从源 Bot 下载后向目标 Bot 上传」）被整体删除后，
 * 任何一次「顺手加个降级分支」的改动都会让文件字节重新出现二次传输——
 * 它会静默放大上传流量（N 个账号就是 N 次重传）、与下载争抢账号额度，
 * 而且**单元测试不会失败**（它只是多了一条分支）。因此必须用源码断言把它挡在评审阶段。
 *
 * 三条守卫：
 * 1. 扩散执行链不得再引用字节传输 API 或 `role: 'replication'` 准入语义；
 * 2. 全仓产品源码不得出现「回退策略 A」「逐账号二次上传」这类已删除能力的文案；
 * 3. `source: 'relayed'` 只能由「入站认领链路」写入（其余来源一律 `inbound`），
 *    否则「副本来源」会变成不可信数据。
 *
 * 边界：**只扫产品源码**（`.ts` / `.vue`，排除 `*.spec.ts`）——测试文件里会出现
 * 这些字符串作为断言输入（例如 `expect(...).not.toContain('逐账号二次上传')`），
 * 把它们算作违规会让守卫自己变成噪声。
 */

const BACKEND_SRC = resolve(__dirname, '..');
const FRONTEND_SRC = resolve(__dirname, '..', '..', '..', 'frontend', 'src');

/** 递归收集文件（跳过 node_modules / dist，避免扫描构建产物） */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

/** 产品源码：`.ts` / `.vue` 且不是测试文件 */
function productSources(dir: string): string[] {
  return walk(dir).filter((file) => /\.(ts|vue)$/.test(file) && !/\.spec\.ts$/.test(file));
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function relativeTo(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** 收集「命中任一禁用片段」的文件（返回可读的相对路径，便于直接定位） */
function offendersOf(root: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const file of productSources(root)) {
    const content = read(file);
    for (const needle of needles) {
      if (content.includes(needle)) hits.push(`${relativeTo(root, file)} → ${needle}`);
    }
  }
  return hits;
}

describe('策略 A 移除：静态回归守卫', () => {
  it('扩散执行链不再引用字节传输 API，也不再存在 replication 准入角色', () => {
    const forbidden = /openRealtimeStream|sendDocumentStream|role:\s*'replication'/;
    for (const rel of [
      'telegram-account-pool/file-copy.service.ts',
      'telegram-account-pool/user-relay.service.ts',
    ]) {
      expect(read(resolve(BACKEND_SRC, rel))).not.toMatch(forbidden);
    }
  });

  it('账号池服务不再保留扩散专用的在飞闸门与准入语义', () => {
    const poolService = read(resolve(BACKEND_SRC, 'telegram-account-pool/telegram-account-pool.service.ts'));
    expect(poolService).not.toMatch(/REPLICATION_INFLIGHT_MAX|replication_full|replicationInflight/);
  });

  it('产品源码不再出现「回退策略 A」「逐账号二次上传」', () => {
    const phrases = ['回退策略 A', '逐账号二次上传'];
    expect(offendersOf(BACKEND_SRC, phrases)).toEqual([]);
    expect(offendersOf(FRONTEND_SRC, phrases)).toEqual([]);
  });

  it('已删除的策略 A 计数器不再出现在产品源码（类型与告警服务同步收敛）', () => {
    const removedCounters = ['replicationsOk', 'replicationsFailed', 'userRelaysOk', 'userRelaysFailed'];
    expect(offendersOf(BACKEND_SRC, removedCounters)).toEqual([]);
    expect(offendersOf(FRONTEND_SRC, removedCounters)).toEqual([]);
  });

  it("`source: 'relayed'` 只允许由入站认领链路写入（含类型声明）", () => {
    // 白名单即「谁能决定副本来源」：
    // - 入站认领：判定消息是否来自启用中的镜像规则目标群；
    // - 桥接：把认领结果写进站内逻辑文件的副本行（source 由调用方传入）；
    // - 实体类型：`TelegramCopySource` 联合类型的声明位置。
    const allowed = new Set([
      'telegram-bot/telegram-bot-dispatch.service.ts',
      'telegram-account-pool/file-copy.service.ts',
      'common/entities/telegram-file-copy.entity.ts',
    ]);
    const offenders: string[] = [];
    for (const file of productSources(BACKEND_SRC)) {
      if (!read(file).includes("'relayed'")) continue;
      const rel = relativeTo(BACKEND_SRC, file);
      if (!allowed.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('扩散观测只写终态与阻塞态：不存在「无既有行的幽灵 copy 行」写入路径', () => {
    const fileCopy = read(resolve(BACKEND_SRC, 'telegram-account-pool/file-copy.service.ts'));
    // `markFailed` 曾是策略 A 的失败留痕（凭空造一行 failed 副本）；失败改由轮次记录承担
    expect(fileCopy).not.toMatch(/markFailed\s*\(/);
  });
});
