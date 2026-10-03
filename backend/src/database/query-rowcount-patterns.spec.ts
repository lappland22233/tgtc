import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * 静态守卫：运行时代码（非 migrations）禁止「`.query()` 后直读返回值做行数 / affected 判断」。
 *
 * 回归背景（v1.6.0 审查报告「机制性防退化」要求落地；历史上已两次事故，本次仍曾漏网一处）：
 * PostgreSQL 下 TypeORM `queryRunner.query()` 对 `UPDATE`/`DELETE` 返回
 * `[rows, affectedCount]` 元组——`rows.length` 恒为 2、`result[1]` 在 SQLite 下恒为
 * `undefined`，导致所有「按行数/affected 判断」的分支静默失真：
 *   - Bot 每日配额按行数判断 → 判定恒真/恒假，配额永不生效；
 *   - 告警一键确认按元组读数 → 数量恒错报为 2、只处理首批；
 *   - 标签解绑按 `result[1]` 判定 → 恒假，「关联不存在」永不抛出（假成功）。
 *
 * 正确写法：语句补 `RETURNING`，经 `src/database/database-types.ts` 的
 * `databaseQuery()` 执行（内部完成 PG 元组归一化 / SQLite RETURNING 解包），
 * 再按返回行数组的 `length` 判定。范式见：
 *   - src/jobs/file-upload.processor.ts（UPDATE ... RETURNING id）
 *   - src/telegram-mirror/telegram-mirror-task.service.ts（UPDATE ... RETURNING *）
 *   - src/alert/alert.service.ts（分批 UPDATE ... RETURNING id 计数）
 *   - src/file/file.service.ts removeFileTag / src/share/share-preview-session.service.ts（DELETE ... RETURNING）
 *
 * 判定规则：
 *   A（硬规则，零容忍）：对 `.query()` 调用结果做「元组式直读」——
 *     A1. 结果变量被 `[1]` 索引（`result[1]` / 链式 `(await x.query(...))[1]`）；
 *     A2. 结果被 `[rows, count]` 形式两元素解构且第二元素具数值/行数语义；
 *     A3. 直读 `.affected` / `.rowCount`（含可选链与 `result[0]?.rowCount` 变体）。
 *   B（启发式）：`.query()` 首参为字符串/模板字面量、语句判定为 DELETE/UPDATE
 *     （排除 `INSERT ... ON CONFLICT ... DO UPDATE` 与 `FOR UPDATE` 锁子句）、不含
 *     `RETURNING`，且绑定结果随后被用于行数/受影响判定（`.length`、与数字比较、
 *     `Number(...)`/`parseInt/parseFloat`、`return` 作为计数、`+=`）→ 违规。
 *
 * 豁免范围（下方常量显式声明，失败信息中会原样说明；白名单必须尽可能小）：
 *   - src/migrations/**：迁移链自身需要 affected/rows 语义，不参与运行时判定；
 *   - *.spec.ts / *.e2e-spec.ts：测试自身（收集阶段即排除）；
 *   - src/database/database-types.ts：统一入口实现本体，其 runner.query() 是唯一
 *     允许的 `.query()` 直读点（归一化逻辑本身就写在那个文件里）；
 *   - 显式白名单（当前为空）：文件 + 行号 + 理由，必须逐条论证「不用于行数/affected
 *     判断」；能改走 databaseQuery() 的一律不进白名单。
 *
 * 防「虚假安全结论」（与 migration-patterns.spec.ts / nest-di-token-patterns.spec.ts
 * 同一守卫哲学）：扫描器一旦因路径/语法漂移而扫不到东西，会给出错误的安全结论。
 * 因此这里同时断言：
 *   1. 扫描覆盖量下限（文件数、真实 `.query(` 调用数与语句分类计数），扫描为空必须失败；
 *   2. 内联「已知坏」样本（含历史事故 1:1 复刻）断言全部命中并能给出定位行号；
 *   3. 内联「已知好」样本（databaseQuery + RETURNING + rows.length、纯 SELECT 行数组、
 *      INSERT ... RETURNING、`[0]` 计数读取、单元素解构、非数值语义两元素解构）
 *      断言零误伤——防止规则过宽导致误报腐蚀信任。
 *
 * 实现边界（有意保守，宁漏勿滥）：
 *   - 仅文本级扫描（fs/path + 正则），不引入新依赖、不连库、不启动 Nest；
 *   - 先清空注释再扫描，避免「修复注释里引用 result[1] / rowCount 反被举报」这类误伤
 *     （file.service.ts、share-preview-session.service.ts 的说明注释即含此字样）；
 *   - 变量使用点按「文件级」聚合（同一文件内绑定过 `.query()` 结果的变量名参与检查）。
 *     当前工作树已逐一核对零误伤；若未来出现确属误伤的场景，请收窄扫描器实现
 *     （例如按方法作用域收敛），**不要**为了让测试变绿而放宽规则。
 */

const SRC_DIR = join(__dirname, '..');
/** 不参与扫描的目录：测试与产物 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test']);

/** 豁免：统一入口实现本体（其 runner.query() 是归一化的唯一合法直读点） */
const EXEMPT_FILE_PATHS = new Set(['src/database/database-types.ts']);
/** 豁免：迁移链自身需要 affected/rows 语义，不参与运行时判定 */
const EXEMPT_PATH_PREFIXES = ['src/migrations/'];

interface ViolationWhitelistEntry {
  /** 相对 backend/ 的路径，如 'src/xxx.ts'（与违规信息中的 file 字段同口径） */
  file: string;
  line: number;
  reason: string;
}

/**
 * 显式白名单：**尽可能小，当前为空是目标状态**。
 * 每条必须论证「不用于行数/affected 判断」；能改走 databaseQuery() 的一律不进白名单。
 * 新增条目必须同时通过下方「白名单必须逐条命中真实违规」测试（防过期豁免）。
 */
const VIOLATION_WHITELIST: ViolationWhitelistEntry[] = [];

type ViolationKind = 'tuple-index' | 'tuple-destructure' | 'affected-read' | 'rowcount-judgment';

interface QueryRowcountViolation {
  file: string;
  line: number;
  kind: ViolationKind;
  reason: string;
  snippet: string;
}

interface QueryCallStats {
  queryCalls: number;
  literalCalls: number;
  selectCalls: number;
  insertCalls: number;
  deleteUpdateCalls: number;
}

interface ScanResult {
  violations: QueryRowcountViolation[];
  stats: QueryCallStats;
}

const KIND_REASONS: Record<ViolationKind, string> = {
  'tuple-index':
    '对 .query() 结果按下标 [1] 直读：PG 下该槽位实际是 affected 计数（行数组恰为 2 时还会被误当行数），SQLite 下恒为 undefined',
  'tuple-destructure':
    '对 .query() 结果做 [rows, count] 式两元素解构：两方言返回值形状不同（PG 元组 / SQLite 纯行集），第二元素不可依赖',
  'affected-read':
    '对 .query() 结果直读 .affected/.rowCount：PG 下两字段均为 undefined，按它判定等于恒定分支',
  'rowcount-judgment':
    'DELETE/UPDATE 语句未带 RETURNING，返回结果却被用于行数/受影响判定：PG 元组与 SQLite 纯行集语义不一致，判定会静默失真',
};

const FIX_GUIDANCE =
  '修复：改用 databaseQuery()（src/database/database-types.ts）执行并将语句补上 RETURNING（如 RETURNING "id"），' +
  '按返回行数组长度判定；范式见 jobs/file-upload.processor.ts、alert/alert.service.ts 与 file/file.service.ts 的 removeFileTag。';

const EXEMPTION_NOTE = [
  '豁免范围（本 spec 内显式声明）：',
  '1. src/migrations/**：迁移链自身需要 affected/rows 语义，不参与运行时判定；',
  '2. src/**/*.spec.ts 与 *.e2e-spec.ts：测试自身（收集阶段即排除）；',
  '3. src/database/database-types.ts：统一入口实现本体，其 runner.query() 是唯一允许的 .query() 直读点；',
  `4. 显式白名单：当前 ${VIOLATION_WHITELIST.length} 条（文件 + 行号 + 理由）；`,
  '   新增条目必须先论证「不用于行数/affected 判断」，能改走 databaseQuery() 的一律不进白名单。',
].join('\n');

function formatViolation(violation: QueryRowcountViolation): string {
  return `${violation.file}:${violation.line} [${violation.kind}] ${violation.reason}；示例：${violation.snippet}。${FIX_GUIDANCE}`;
}

// ---------------------------------------------------------------------------
// 文本层工具（版面保持型：只把目标区间替换为空格，保留换行，保证偏移/行号一致）
// ---------------------------------------------------------------------------

function blankRange(chars: string[], start: number, end: number): void {
  const stop = Math.min(chars.length, end);
  for (let i = start; i < stop; i += 1) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

/** 返回字符串字面量结束后的下标（含 `\` 转义与模板 `${}` 嵌套；未闭合时返回文本长度） */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      i = skipTemplateExpression(text, i + 2);
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** 跳过模板字面量 `${ ... }` 表达式（含大括号嵌套与其中的字符串） */
function skipTemplateExpression(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/** 清空 TS 注释（行注释与块注释），字符串内部保持不变；版面与偏移不变 */
function stripComments(text: string): string {
  const chars = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      let end = i + 2;
      while (end < text.length && text[end] !== '\n') end += 1;
      blankRange(chars, i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      let end = i + 2;
      while (end < text.length && !(text[end] === '*' && text[end + 1] === '/')) end += 1;
      end = Math.min(text.length, end + 2);
      blankRange(chars, i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

/** 清空所有字符串字面量内容（用于「只认代码里的 .query( 调用」的检测层） */
function blankStrings(text: string): string {
  const chars = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(text, i);
      blankRange(chars, i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

/** 返回与 openIndex 处开括号配对的闭括号下标（跳过字符串内容），未闭合返回 -1 */
function findMatchingDelimiter(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** 读取首个实参是否为字符串/模板字面量；不是则返回 null（规则 B 仅对字面量可判） */
function readFirstArgumentLiteral(text: string, openParenIndex: number): { content: string } | null {
  let i = openParenIndex + 1;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const quote = text[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const end = skipString(text, i);
  if (end > text.length || text[end - 1] !== quote) return null;
  return { content: text.slice(i + 1, end - 1) };
}

function lineAt(text: string, index: number): number {
  let line = 1;
  const stop = Math.min(index, text.length);
  for (let i = 0; i < stop; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function snippetAt(text: string, index: number): string {
  const from = Math.max(0, index);
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  let end = text.indexOf('\n', from);
  if (end === -1) end = text.length;
  const line = text.slice(start, end).trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

// ---------------------------------------------------------------------------
// SQL 语句分类与使用点判定
// ---------------------------------------------------------------------------

type StatementKind = 'select' | 'insert' | 'delete' | 'update' | 'other';

/** 去掉 SQL 注释与单引号字面量（避免 `WHERE action = 'UPDATE'` 之类的关键字误判） */
function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

/**
 * 判定 SQL 语句类型与是否含 RETURNING。
 * - 首关键字为 INSERT → insert（自然覆盖 `INSERT ... ON CONFLICT ... DO UPDATE`）；
 * - 首关键字为 DELETE/UPDATE → 对应类型；
 * - `WITH ...` 开头：取首个 INSERT/DELETE/UPDATE 关键字，但先剔除锁子句
 *   （`FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR KEY SHARE`）与 `DO UPDATE`；
 * - 其余（SELECT 等）→ select/other，不参与规则 B。
 */
function classifyStatement(sql: string): { kind: StatementKind; hasReturning: boolean } {
  const cleaned = stripSqlLiterals(sql);
  const head = cleaned.trimStart();
  const firstWord = (/^[A-Za-z_]+/.exec(head)?.[0] ?? '').toUpperCase();
  const hasReturning = /\bRETURNING\b/i.test(cleaned);
  const byKeyword = (word: string): StatementKind | null => {
    if (word === 'INSERT') return 'insert';
    if (word === 'DELETE') return 'delete';
    if (word === 'UPDATE') return 'update';
    return null;
  };
  const direct = byKeyword(firstWord);
  if (direct) return { kind: direct, hasReturning };
  if (firstWord === 'WITH') {
    const withoutLockClauses = cleaned
      .replace(/\bFOR\s+(?:NO\s+)?(?:KEY\s+)?(?:SHARE|UPDATE)\b/gi, ' ')
      .replace(/\bDO\s+UPDATE\b/gi, ' ');
    const keyword = /\b(INSERT|DELETE|UPDATE)\b/i.exec(withoutLockClauses)?.[1]?.toUpperCase() ?? '';
    return { kind: byKeyword(keyword) ?? 'other', hasReturning };
  }
  if (firstWord === 'SELECT' || firstWord === 'SHOW' || firstWord === 'PRAGMA') {
    return { kind: 'select', hasReturning };
  }
  return { kind: 'other', hasReturning };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tupleIndexRegex(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\s*\\[\\s*1\\s*\\]`);
}

function affectedReadRegex(name: string): RegExp {
  return new RegExp(
    `\\b${escapeRegExp(name)}\\s*(?:\\[[^\\]]*\\])?\\s*\\??\\.\\s*(?:affected|rowCount)\\b`,
  );
}

function lengthUsageRegex(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\s*\\??\\.\\s*length\\b`);
}

/** 数值/行数语义的使用模式（用于规则 A2 的第二元素与规则 B 的结果消费判定） */
function numericUsagePatterns(name: string): RegExp[] {
  const n = escapeRegExp(name);
  return [
    new RegExp(`Number\\s*\\(\\s*${n}\\b`),
    new RegExp(`parseInt\\s*\\(\\s*${n}\\b`),
    new RegExp(`parseFloat\\s*\\(\\s*${n}\\b`),
    new RegExp(`\\b${n}\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*\\d`),
    new RegExp(`\\d\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*${n}\\b`),
    new RegExp(`\\b${n}\\s*\\+=`),
    new RegExp(`\\breturn\\s+${n}\\b`),
  ];
}

function numericUsageIndex(text: string, name: string): number {
  for (const pattern of numericUsagePatterns(name)) {
    const match = pattern.exec(text);
    if (match) return match.index;
  }
  return -1;
}

function hasNumericUsage(text: string, name: string): boolean {
  return numericUsageIndex(text, name) >= 0;
}

function isCountSemanticName(name: string): boolean {
  return (
    /^(count|rows?|affected|rowcount|num|total|deleted|inserted|updated|changed|changes|matched|n|amount|sum)$/i.test(name) ||
    /(count|affected|total|deleted|inserted|updated|changes)/i.test(name)
  );
}

/** 规则 B：结果变量被用于行数判定的第一个位置（`.length` / 数值比较 / Number(...) / return / +=） */
function rowcountUsageIndex(text: string, name: string): number {
  const lengthAt = lengthUsageRegex(name).exec(text);
  if (lengthAt) return lengthAt.index;
  return numericUsageIndex(text, name);
}

// ---------------------------------------------------------------------------
// 绑定解析：`const xxx = await callee.query(` / `const [a, b] = await callee.query(`
// ---------------------------------------------------------------------------

interface BindingResult {
  names: string[];
  destructured: boolean;
  objectDestructured: boolean;
  raw: string;
  /** 声明起始的绝对偏移（用于报告行号） */
  index: number;
}

/** 同一行内、紧邻调用前的赋值声明（严格版：LHS 不含 `;`，兼容常见写法） */
const BINDING_STRICT = /(?:const|let|var)\s+([^\n;=]+?)=\s*\(?\s*(?:await\s+)?[\w$.]+$/;
/** 放宽版：允许 LHS 类型标注内含 `;`（如 `Array<{ key: string; value: string }>`） */
const BINDING_WITH_TYPE_SEMICOLON = /(?:const|let|var)\s+([^\n=]+?)=\s*\(?\s*(?:await\s+)?[\w$.]+$/;

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseBindingLhs(lhs: string): Omit<BindingResult, 'index'> | null {
  if (lhs.startsWith('[')) {
    const close = findMatchingDelimiter(lhs, 0, '[', ']');
    if (close === -1) return null;
    const names = splitTopLevel(lhs.slice(1, close))
      .map((part) => part.trim())
      .map((item) => item.replace(/^\.\.\./, ''))
      .map((item) => {
        const eq = item.search(/=(?!=|>)/);
        const withoutDefault = eq === -1 ? item : item.slice(0, eq);
        const colon = withoutDefault.indexOf(':');
        return (colon === -1 ? withoutDefault : withoutDefault.slice(0, colon)).trim();
      })
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    return { names, destructured: true, objectDestructured: false, raw: lhs };
  }
  if (lhs.startsWith('{')) {
    return { names: [], destructured: true, objectDestructured: true, raw: lhs };
  }
  const name = lhs.split(':')[0].trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  return { names: [name], destructured: false, objectDestructured: false, raw: lhs };
}

function parseBindingBeforeCall(semiText: string, callIndex: number): BindingResult | null {
  const windowStart = Math.max(0, callIndex - 600);
  const windowText = semiText.slice(windowStart, callIndex);
  for (const pattern of [BINDING_STRICT, BINDING_WITH_TYPE_SEMICOLON]) {
    const match = pattern.exec(windowText);
    if (!match) continue;
    const parsed = parseBindingLhs(match[1].trim());
    if (parsed) return { ...parsed, index: windowStart + (match.index ?? 0) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 扫描器主体（纯函数：文本进，违规/统计出；内联自测直接复用）
// ---------------------------------------------------------------------------

function scanSource(label: string, source: string): ScanResult {
  const semiText = stripComments(source);
  const codeText = blankStrings(semiText);
  const violations: QueryRowcountViolation[] = [];
  const stats: QueryCallStats = {
    queryCalls: 0,
    literalCalls: 0,
    selectCalls: 0,
    insertCalls: 0,
    deleteUpdateCalls: 0,
  };

  const callPattern = /\.query\s*(?:<[^()]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(codeText)) !== null) {
    stats.queryCalls += 1;
    const callIndex = match.index;
    const openParen = match.index + match[0].length - 1;

    const literal = readFirstArgumentLiteral(semiText, openParen);
    let statement: { kind: StatementKind; hasReturning: boolean } | null = null;
    if (literal) {
      stats.literalCalls += 1;
      statement = classifyStatement(literal.content);
      if (statement.kind === 'select') stats.selectCalls += 1;
      else if (statement.kind === 'insert') stats.insertCalls += 1;
      else if (statement.kind === 'delete' || statement.kind === 'update') stats.deleteUpdateCalls += 1;
    }

    const binding = parseBindingBeforeCall(semiText, callIndex);
    const found = new Map<ViolationKind, number>();
    const record = (kind: ViolationKind, at: number): void => {
      if (!found.has(kind)) found.set(kind, at);
    };

    // A1/A3 链式直读：(await x.query(...)).affected / (await x.query(...))[1]
    const closeParen = findMatchingDelimiter(codeText, openParen, '(', ')');
    if (closeParen !== -1) {
      const tail = codeText.slice(closeParen + 1);
      const chainAffected = /^\s*\)?\s*\??\.\s*(?:affected|rowCount)\b/.exec(tail);
      if (chainAffected) record('affected-read', closeParen + 1 + chainAffected.index);
      const chainIndex = /^\s*\)?\s*\[\s*1\s*\]/.exec(tail);
      if (chainIndex) record('tuple-index', closeParen + 1 + chainIndex.index);
    }

    let destructureFired = false;
    if (binding) {
      // A2 两元素数组解构（第二元素具数值/行数语义）
      if (binding.destructured && !binding.objectDestructured && binding.names.length >= 2) {
        const second = binding.names[1];
        if (isCountSemanticName(second) || hasNumericUsage(semiText, second)) {
          record('tuple-destructure', binding.index);
          destructureFired = true;
        }
      }
      // A3 对象解构中的 affected / rowCount
      if (binding.objectDestructured && /\b(affected|rowCount)\b/.test(binding.raw)) {
        record('affected-read', binding.index);
      }
      // A1/A3 结果变量的使用点
      for (const name of binding.names) {
        const indexUsage = tupleIndexRegex(name).exec(semiText);
        if (indexUsage) record('tuple-index', indexUsage.index);
        const affectedUsage = affectedReadRegex(name).exec(semiText);
        if (affectedUsage) record('affected-read', affectedUsage.index);
      }
      // B 启发式：DELETE/UPDATE 无 RETURNING 的结果被用于行数/受影响判定
      if (
        statement &&
        (statement.kind === 'delete' || statement.kind === 'update') &&
        !statement.hasReturning &&
        !destructureFired
      ) {
        for (const name of binding.names) {
          const usageAt = rowcountUsageIndex(semiText, name);
          if (usageAt >= 0) {
            record('rowcount-judgment', usageAt);
            break;
          }
        }
      }
    }

    for (const [kind, at] of found) {
      violations.push({
        file: label,
        line: lineAt(semiText, at),
        kind,
        reason: KIND_REASONS[kind],
        snippet: snippetAt(semiText, at),
      });
    }
  }

  return { violations, stats };
}

// ---------------------------------------------------------------------------
// 文件收集与豁免判定
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), acc);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (/\.(spec|e2e-spec)\.ts$/.test(entry.name)) continue;
    acc.push(join(dir, entry.name));
  }
  return acc;
}

function toSrcPath(absPath: string): string {
  return `src/${relative(SRC_DIR, absPath).split(sep).join('/')}`;
}

function isExemptFile(srcPath: string): boolean {
  if (EXEMPT_FILE_PATHS.has(srcPath)) return true;
  return EXEMPT_PATH_PREFIXES.some((prefix) => srcPath.startsWith(prefix));
}

function isExempt(srcPath: string, line: number): boolean {
  return isExemptFile(srcPath) || VIOLATION_WHITELIST.some((entry) => entry.file === srcPath && entry.line === line);
}

function sumStats(items: QueryCallStats[]): QueryCallStats {
  return items.reduce<QueryCallStats>(
    (acc, s) => ({
      queryCalls: acc.queryCalls + s.queryCalls,
      literalCalls: acc.literalCalls + s.literalCalls,
      selectCalls: acc.selectCalls + s.selectCalls,
      insertCalls: acc.insertCalls + s.insertCalls,
      deleteUpdateCalls: acc.deleteUpdateCalls + s.deleteUpdateCalls,
    }),
    { queryCalls: 0, literalCalls: 0, selectCalls: 0, insertCalls: 0, deleteUpdateCalls: 0 },
  );
}

// ---------------------------------------------------------------------------
// 内联样本（坏样本 = 必须命中；好样本 = 必须零误伤）
// ---------------------------------------------------------------------------

/** 坏 1：result[1] 下标直读（历史事故写法） */
const BAD_TUPLE_INDEX = `
  async function demote(queryRunner: QueryRunner, id: string) {
    const result = await queryRunner.query('UPDATE users SET quota = quota - 1 WHERE id = $1', [id]);
    if ((result[1] ?? 0) === 0) return;
  }`;

/** 坏 2：[rows, count] 两元素解构 */
const BAD_DESTRUCTURE = `
  async function sweep(manager: EntityManager, cutoff: Date) {
    const [rows, count] = await manager.query('DELETE FROM sessions WHERE "expiresAt" < $1', [cutoff]);
    if (count > 0) cleanup(rows);
  }`;

/** 坏 3：无 RETURNING 的 DELETE，结果被 .length 判定（分批循环典型） */
const BAD_ROWCOUNT = `
  async function purge(tokens: DataSource, cutoff: Date) {
    const result = await tokens.query(
      \`DELETE FROM "access_tokens" WHERE "createdAt" < $1\`,
      [cutoff],
    );
    deleted += result.length;
  }`;

/** 坏 4：.affected 直读 */
const BAD_AFFECTED = `
  async function acknowledge(queryRunner: QueryRunner, alertId: string) {
    const result = await queryRunner.query('UPDATE alerts SET "acknowledgedAt" = now() WHERE id = $1', [alertId]);
    if ((result.affected ?? 0) === 0) throw new Error('not found');
  }`;

/** 坏 5：历史事故 1:1 复刻（旧 archiveData 写法，两类直读同时出现） */
const BAD_REAL_WORLD = `
  async function archive(dataSource: DataSource, cutoff: Date, batchSize: number) {
    const result = await dataSource.query(
      \`DELETE FROM "access_logs" WHERE "createdAt" < $1 LIMIT $2\`,
      [cutoff, batchSize],
    );
    const count = Array.isArray(result) ? result[0]?.rowCount ?? 0 : (result[1] ?? 0);
  }`;

/** 好 1：databaseQuery() + RETURNING + rows.length（统一入口，本身不在扫描范围） */
const GOOD_DATABASE_QUERY = `
  async function finalize(repo: Repository<File>, fileId: string) {
    const readyRows = await databaseQuery<Array<{ id: string }>>(
      repo.manager,
      'UPDATE files SET status = $1 WHERE id = $2 RETURNING id',
      ['ready', fileId],
      getDatabaseType(),
    );
    if (!Array.isArray(readyRows) || readyRows.length === 0) return;
  }`;

/** 好 2：纯 SELECT 结果当行数组用（含 .length 判定——不能因规则过宽被误报） */
const GOOD_SELECT = `
  async function listIds(manager: EntityManager, rootId: string) {
    const rows = await manager.query('SELECT id FROM folders WHERE "parentId" = $1', [rootId]);
    if (rows.length === 0) return [];
    return rows.map((row) => row.id);
  }`;

/** 好 3：INSERT ... RETURNING（INSERT 命令返回纯行集，length 判定合法） */
const GOOD_INSERT_RETURNING = `
  async function appendTag(queryRunner: QueryRunner, fileId: string, tagId: string) {
    const inserted = await queryRunner.query(
      \`INSERT INTO file_tags ("fileId", "tagId") VALUES ($1, $2) RETURNING "tagId"\`,
      [fileId, tagId],
    );
    if (inserted.length === 0) throw new Error('append failed');
  }`;

/** 好 4：SELECT COUNT 后 [0] 读列（下标 1 才违规，0 合法） */
const GOOD_COUNT_ZERO_INDEX = `
  async function countUsers(manager: EntityManager) {
    const countRows = await manager.query('SELECT COUNT(*) AS "count" FROM "users" WHERE "deletedAt" IS NULL', []);
    return countRows[0]?.count ?? 0;
  }`;

/** 好 5：单元素解构（仅两元素 [rows, count] 形式违规） */
const GOOD_SINGLE_DESTRUCTURE = `
  async function latestMetric(dataSource: DataSource) {
    const [metric] = await dataSource.query(
      \`SELECT "qpsAvg" FROM "access_logs_metrics_1min" ORDER BY "windowTime" DESC LIMIT 1\`,
      [],
    );
    if (!metric) return null;
    return metric.qpsAvg;
  }`;

/** 好 6：两元素解构但第二元素无数值/行数语义（规则 A2 的边界，不得误伤） */
const GOOD_NON_NUMERIC_DESTRUCTURE = `
  async function pair(queryRunner: QueryRunner, id: string) {
    const [firstRow, secondRow] = await queryRunner.query('SELECT a FROM demo WHERE id = $1', [id]);
    return [firstRow.a, secondRow.a];
  }`;

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('运行时代码 .query() 行数/affected 直读静态守卫（v1.6.0 机制性防退化）', () => {
  const files = collectSourceFiles(SRC_DIR);
  const scanned = files.map((absPath) => ({
    srcPath: toSrcPath(absPath),
    result: scanSource(toSrcPath(absPath), readFileSync(absPath, 'utf8')),
  }));

  it('真实源码（豁免外）零违规：不存在 .query() 元组直读 / 无 RETURNING 计数判定', () => {
    const violations = scanned.flatMap(({ srcPath, result }) =>
      result.violations.filter((violation) => !isExempt(srcPath, violation.line)),
    );
    const report =
      violations.length === 0
        ? ''
        : ['发现 .query() 行数直读违规：', ...violations.map(formatViolation), '', EXEMPTION_NOTE].join('\n');

    // 失败信息直接给出 文件:行号 + 判定原因 + 修复指引，便于后来者一眼能改
    expect(report).toBe('');
    expect(violations).toEqual([]);
  });

  it('扫描覆盖量下限与语句分类计数（防止空扫/路径漂移给出虚假安全结论）', () => {
    const eligible = scanned.filter(({ srcPath }) => !isExemptFile(srcPath));
    const runtimeStats = sumStats(eligible.map(({ result }) => result.stats));
    const allStats = sumStats(scanned.map(({ result }) => result.stats));

    // 当前工作树实测：收集 337 个（含 migrations 86 个），运行时可判定 250 个；
    // `.query(` 调用：运行时代码 34 处、全量 641 处（migrations 607 处）。
    // 以下下限按实测值留出余量，只用于证明「扫描器确实走遍了源码树并完成分类」。
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(eligible.length).toBeGreaterThanOrEqual(200);
    expect(runtimeStats.queryCalls).toBeGreaterThanOrEqual(25);
    expect(runtimeStats.literalCalls).toBeGreaterThanOrEqual(20);
    expect(runtimeStats.selectCalls).toBeGreaterThanOrEqual(18);
    expect(runtimeStats.insertCalls).toBeGreaterThanOrEqual(2);
    // 当前唯一样本：file.service.ts setFileTags 的整表替换 DELETE（结果不读）。
    // 若该处日后也迁走，请同步下调此下限并在 PR 中说明，而不是删除守卫。
    expect(runtimeStats.deleteUpdateCalls).toBeGreaterThanOrEqual(1);

    // 全量（含 migrations）计数防止「分类器整体失效」时下限仍被运行时小样本掩盖
    expect(allStats.queryCalls).toBeGreaterThanOrEqual(250);
    expect(allStats.deleteUpdateCalls).toBeGreaterThanOrEqual(10);
  });

  it('坏样本自测：result[1] / [rows,count] 解构 / 无 RETURNING .length / .affected 全部命中', () => {
    const tupleSample = scanSource('samples/bad-tuple-index.ts', BAD_TUPLE_INDEX);
    expect(tupleSample.violations.map((violation) => violation.kind)).toEqual(['tuple-index']);
    expect(tupleSample.violations[0].line).toBe(4);
    expect(tupleSample.violations[0].snippet).toContain('result[1]');

    const destructureSample = scanSource('samples/bad-destructure.ts', BAD_DESTRUCTURE);
    expect(destructureSample.violations.map((violation) => violation.kind)).toEqual(['tuple-destructure']);

    const rowcountSample = scanSource('samples/bad-rowcount.ts', BAD_ROWCOUNT);
    expect(rowcountSample.violations.map((violation) => violation.kind)).toEqual(['rowcount-judgment']);

    const affectedSample = scanSource('samples/bad-affected.ts', BAD_AFFECTED);
    expect(affectedSample.violations.map((violation) => violation.kind)).toEqual(['affected-read']);

    // 历史事故 1:1 复刻：两类直读同时命中
    const realWorld = scanSource('samples/bad-real-world.ts', BAD_REAL_WORLD);
    expect(realWorld.violations.map((violation) => violation.kind).sort()).toEqual([
      'affected-read',
      'tuple-index',
    ]);
  });

  it('好样本自测：合规写法零误伤（databaseQuery+RETURNING / 纯 SELECT / INSERT...RETURNING / [0] / 单元素解构）', () => {
    const databaseQuerySample = scanSource('samples/good-database-query.ts', GOOD_DATABASE_QUERY);
    expect(databaseQuerySample.violations).toEqual([]);
    expect(databaseQuerySample.stats.queryCalls).toBe(0); // 统一入口本身不在 `.query(` 扫描范围

    const selectSample = scanSource('samples/good-select.ts', GOOD_SELECT);
    expect(selectSample.violations).toEqual([]);
    expect(selectSample.stats.selectCalls).toBe(1);

    const insertSample = scanSource('samples/good-insert-returning.ts', GOOD_INSERT_RETURNING);
    expect(insertSample.violations).toEqual([]);
    expect(insertSample.stats.insertCalls).toBe(1);

    const countSample = scanSource('samples/good-count.ts', GOOD_COUNT_ZERO_INDEX);
    expect(countSample.violations).toEqual([]);

    const singleDestructureSample = scanSource('samples/good-single-destructure.ts', GOOD_SINGLE_DESTRUCTURE);
    expect(singleDestructureSample.violations).toEqual([]);

    const nonNumericSample = scanSource('samples/good-non-numeric-destructure.ts', GOOD_NON_NUMERIC_DESTRUCTURE);
    expect(nonNumericSample.violations).toEqual([]);
  });

  it('白名单必须逐条命中真实违规（防止过期豁免静默腐蚀守卫）', () => {
    const allViolations = scanned.flatMap(({ srcPath, result }) =>
      result.violations.map((violation) => ({ srcPath, line: violation.line })),
    );
    const stale = VIOLATION_WHITELIST.filter(
      (entry) => !allViolations.some((violation) => violation.srcPath === entry.file && violation.line === entry.line),
    );
    expect(stale).toEqual([]);
  });

  it('违规信息包含「文件:行号」与修复指引（databaseQuery + RETURNING）', () => {
    const result = scanSource('src/example/broken.ts', BAD_REAL_WORLD);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
    for (const violation of result.violations) {
      const message = formatViolation(violation);
      expect(message).toContain(`src/example/broken.ts:${violation.line}`);
      expect(message).toContain('databaseQuery');
      expect(message).toContain('RETURNING');
    }
  });
});
