/**
 * 精简 SemVer 2.0.0 解析与比较器。
 *
 * 刻意不引入第三方依赖：更新链路只需要解析、比较和稳定版判定，
 * 自己实现可以保证与发布脚本（check-version.sh / generate-manifest.sh）
 * 的正则语义完全一致，避免 npm audit 风险。
 *
 * 规则要点：
 * - 版本号必须是合法 SemVer，否则解析失败。
 * - 比较时主/次/补丁按数字比较；预发布版本低于同版本号的正式版；
 *   预发布标识符按 SemVer 规则逐段比较（数字段按数值，字母段按 ASCII，数字 < 字母）。
 * - 构建元数据（+build）不参与比较。
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识符数组；正式版为 null */
  prerelease: string[] | null;
  /** 构建元数据（不参与比较） */
  build: string | null;
}

const NUMERIC_IDENTIFIER = /^(0|[1-9]\d*)$/;

const SEMVER_PATTERN = new RegExp(
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)'
  + '(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?'
  + '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$',
);

/**
 * 解析 SemVer；非法输入返回 null。拒绝前后空白以外的多余字符。
 */
export function parseSemver(raw: string): SemVer | null {
  if (typeof raw !== 'string') return null;
  const match = SEMVER_PATTERN.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : null,
    build: match[5] ?? null,
  };
}

/**
 * 是否为稳定版（无预发布标识符）。解析失败返回 false。
 */
export function isStableVersion(raw: string): boolean {
  const parsed = parseSemver(raw);
  return parsed !== null && parsed.prerelease === null;
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) {
    const diff = Number(a) - Number(b);
    return diff < 0 ? -1 : diff > 0 ? 1 : 0;
  }
  // 数字标识符低于字母标识符
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (a === null && b === null) return 0;
  // 无预发布版本的正式版高于预发布版本
  if (a === null) return 1;
  if (b === null) return -1;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const result = comparePrereleaseIdentifier(a[i], b[i]);
    if (result !== 0) return result;
  }
  // 标识符更长的预发布版本更高（1.0.0-alpha < 1.0.0-alpha.1）
  if (a.length === b.length) return 0;
  return a.length > b.length ? 1 : -1;
}

/**
 * 比较两个 SemVer：a < b 返回 -1，a > b 返回 1，相等（含构建元数据差异）返回 0。
 * 任一入参非法返回 null（调用方必须显式处理，不允许隐式当作相等）。
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * 从 `vX.Y.Z` 形式的 tag 中提取版本号；非法 tag 返回 null。
 */
export function versionFromTag(tag: string): string | null {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  return parseSemver(version) ? version : null;
}
