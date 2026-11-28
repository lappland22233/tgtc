import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getMigrationPatterns } from './database.config';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * 把本项目使用的受限迁移 glob 片段转换为正则。
 * 仅支持 database.config.ts 实际用到的语法：[0-9] 字符类、* 通配符、固定后缀 {.ts,.js}；
 * 出现其他语法时直接抛错，防止配置漂移后测试给出虚假的安全结论。
 */
function patternMatcher(pattern: string): (file: string) => boolean {
  const suffix = '{.ts,.js}';
  if (!pattern.endsWith(suffix)) {
    throw new Error(`迁移 glob 必须以 ${suffix} 结尾: ${pattern}`);
  }
  const base = pattern.slice(0, -suffix.length).split(/[\\/]/).pop() ?? '';
  const source = base
    .replace(/\[0-9\]/g, '\u0000')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\u0000/g, '[0-9]')
    .replace(/\\\*/g, '.*');
  const regExp = new RegExp(`^${source}\\.(ts|js)$`);
  return (file: string) => regExp.test(file);
}

describe('TypeORM 迁移加载边界（排除测试文件）', () => {
  let files: string[];

  beforeEach(() => {
    files = readdirSync(MIGRATIONS_DIR);
  });

  it('PG 迁移模式只匹配数字时间戳开头的正式迁移，不匹配 spec', () => {
    const matcher = patternMatcher(getMigrationPatterns('postgres')[0]);
    const matched = files.filter(matcher);

    expect(matched).not.toContain('sqlite-migrations.spec.ts');
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((file) => /^[0-9]/.test(file))).toBe(true);
    // 完整性：目录内所有以数字开头的迁移文件都必须被匹配，防止收紧过头漏掉迁移。
    expect(new Set(matched)).toEqual(new Set(files.filter((file) => /^[0-9].*\.(ts|js)$/.test(file))));
  });

  it('SQLite 迁移模式只匹配 *-Sqlite* 专用迁移，不匹配 spec', () => {
    const matcher = patternMatcher(getMigrationPatterns('sqlite')[0]);
    const matched = files.filter(matcher);

    expect(matched).not.toContain('sqlite-migrations.spec.ts');
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((file) => file.includes('-Sqlite'))).toBe(true);
    expect(new Set(matched)).toEqual(new Set(files.filter((file) => /-Sqlite.*\.ts$/.test(file))));
  });

  it('A-24：每个 *-Sqlite* 迁移都必须带方言早退守卫（PG glob 会匹配到它们）', () => {
    // PG 侧 glob 是 [0-9]*{.ts,.js}，会匹配全部 SQLite 迁移文件。唯一防线是每个文件
    // up/down 首部的 `options.type !== 'better-sqlite3'` 早退。该守卫此前只是口头约定：
    // 新增 SQLite 迁移漏写守卫，就会在 PostgreSQL 上执行 SQLite 方言 SQL 并中断升级链。
    const sqliteMigrations = files.filter(
      (file) => /-Sqlite.*\.ts$/.test(file) && !/\.spec\.|\.test\./.test(file),
    );
    expect(sqliteMigrations.length).toBeGreaterThan(0);

    const missingGuard = sqliteMigrations.filter((file) => {
      const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      return !/options\.type\s*!==\s*'better-sqlite3'/.test(source);
    });
    expect(missingGuard).toEqual([]);
  });

  it('任何 *.spec.* / *.test.* 测试文件都不会进入 CLI 迁移集合', () => {
    const testFiles = files.filter((file) => /\.spec\.|\.test\./.test(file));
    expect(testFiles.length).toBeGreaterThan(0);

    const patterns = [...getMigrationPatterns('postgres'), ...getMigrationPatterns('sqlite')];
    for (const pattern of patterns) {
      const matcher = patternMatcher(pattern);
      expect(testFiles.every((file) => !matcher(file))).toBe(true);
    }
  });
});
