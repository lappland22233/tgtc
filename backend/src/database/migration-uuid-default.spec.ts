import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** PG 侧迁移文件（数字时间戳开头、非 *-Sqlite* 专用、非测试文件） */
function pgMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^[0-9].*\.ts$/.test(file))
    .filter((file) => !file.includes('-Sqlite'))
    .filter((file) => !/\.spec\.|\.test\./.test(file));
}

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

/**
 * 逐行扫描，找出**缺少 DEFAULT 表达式**的 `"id" uuid` 列定义。
 * 返回项带所属建表名（用于判断是否存在配套修复迁移）。
 *
 * 逐行判定（而非提取 CREATE TABLE 块）可同时覆盖单行与多行建表写法；
 * 建表内各行紧跟 CREATE TABLE 之后，遇到块结束的 `)` 重置表名归属。
 */
export function findUuidIdColumnsWithoutDefault(
  source: string,
): { table: string | null; text: string }[] {
  const violations: { table: string | null; text: string }[] = [];
  let currentTable: string | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 跳过 SQL 注释行，避免把文档里的示例当作真实 DDL
    if (/^(--|\*|\/\*)/.test(line)) continue;

    const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i.exec(line);
    if (create) {
      currentTable = create[1];
      continue;
    }
    // 建表块结束（闭括号独占一行）
    if (/^\)/.test(line)) {
      currentTable = null;
      continue;
    }
    if (!/"id"\s+uuid\b/i.test(line)) continue;
    if (/\bDEFAULT\b/i.test(line)) continue;
    violations.push({ table: currentTable, text: line });
  }
  return violations;
}

/** 扫描 `ALTER TABLE ... ALTER COLUMN "id" SET DEFAULT` 补默认值的表名 */
export function findIdDefaultHealTables(source: string): string[] {
  const tables: string[] = [];
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ALTER\s+COLUMN\s+"id"\s+SET\s+DEFAULT/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    tables.push(match[1]);
  }
  return tables;
}

/**
 * 防回归：`@PrimaryGeneratedColumn('uuid')` 在 PostgreSQL 下**不做应用层生成**
 * （`UuidSubscriber` 仅在 SQLite 分支注册），INSERT 省略 id 时依赖数据库端默认值。
 * 建表漏写 DEFAULT 会让整张表写入 100% 失败（23502）。
 *
 * 该缺陷已在本项目出现两次：api_keys（4e0da52）与 Telegram Bot 三表（180230）。
 * 此处固化规则：**任何缺失 DEFAULT 的 uuid 主键，都必须存在配套的 SET DEFAULT 修复迁移**，
 * 从而允许历史迁移保持原样，同时保证升级链最终收敛。
 */
describe('PostgreSQL 迁移 uuid 主键默认值（防 23502 事故复发）', () => {
  it('检查器自身有效：能识别漏默认值、默认值与修复语句', () => {
    const brokenTable = [
      'CREATE TABLE IF NOT EXISTS "demo" (',
      '  "id" uuid NOT NULL,',
      '  "createdAt" timestamp NOT NULL DEFAULT now(),',
      '  CONSTRAINT "PK_demo_id" PRIMARY KEY ("id")',
      ')',
    ].join('\n');
    expect(findUuidIdColumnsWithoutDefault(brokenTable)).toEqual([
      { table: 'demo', text: '"id" uuid NOT NULL,' },
    ]);

    // 已有默认值的两种写法均不应被误报
    expect(findUuidIdColumnsWithoutDefault('"id" uuid NOT NULL DEFAULT gen_random_uuid(),')).toEqual([]);
    expect(findUuidIdColumnsWithoutDefault('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),')).toEqual([]);
    expect(findUuidIdColumnsWithoutDefault('"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),')).toEqual([]);

    // 注释中的示例不得计入
    expect(findUuidIdColumnsWithoutDefault('-- "id" uuid NOT NULL,')).toEqual([]);

    // 修复语句可被识别（含 IF EXISTS / 大小写差异）
    expect(findIdDefaultHealTables(
      'ALTER TABLE IF EXISTS "demo" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()',
    )).toEqual(['demo']);
    expect(findIdDefaultHealTables(
      'alter table "demo2" alter column "id" set default gen_random_uuid()',
    )).toEqual(['demo2']);
  });

  it('任何缺 DEFAULT 的 uuid 主键都必须有配套的 SET DEFAULT 修复迁移', () => {
    const files = pgMigrationFiles();
    expect(files.length).toBeGreaterThan(3);

    const healTables = new Set(files.flatMap((file) => findIdDefaultHealTables(read(file))));

    const unhealed = files
      .flatMap((file) => findUuidIdColumnsWithoutDefault(read(file)).map((item) => ({ file, ...item })))
      .filter((item) => item.table === null || !healTables.has(item.table));

    expect(unhealed).toEqual([]);

    // 自检：确认修复扫描确实读到了真实 SQL（否则上面的断言会因扫描失效而恒真）
    expect([...healTables]).toEqual(expect.arrayContaining([
      'api_keys',
      'telegram_bot_file_grants',
      'telegram_bot_daily_usage',
      'telegram_bot_whitelist',
    ]));
  });
});
