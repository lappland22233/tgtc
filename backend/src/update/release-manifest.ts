import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { compareSemver, parseSemver } from '../version/semver';

/**
 * release-manifest.json 协议（与 scripts/release/release-manifest.schema.json 严格对齐）。
 * 字段集合是封闭集合：未知主 schemaVersion 或多余字段一律拒绝。
 */
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  channel: 'stable';
  publishedAt: string;
  platform: 'linux';
  arch: 'x64';
  asset: { name: string; size: number; sha256: string };
  minUpgradableVersion: string;
  maxUpgradableVersion: string | null;
  includesDbMigration: boolean;
  programRollbackSafe: boolean;
  healthCheck: { path: string; timeoutMs: number };
}

export type ManifestParseResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: string };

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_NAME_PATTERN = /^tgtc-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-linux-x64\.zip$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 严格解析 release-manifest.json。
 *
 * expectedVersion 传入时（安装/校验场景）额外断言清单版本与预期一致。
 * 任何字段缺失、类型不符或语义非法（如兼容窗口倒挂）都返回 ok: false，
 * 绝不返回"部分可用"的清单。
 */
export function parseReleaseManifest(raw: unknown, expectedVersion?: string): ManifestParseResult {
  if (!isPlainObject(raw)) return { ok: false, reason: '清单顶层必须是 JSON 对象' };

  const allowedKeys = new Set([
    'schemaVersion', 'version', 'channel', 'publishedAt', 'platform', 'arch',
    'asset', 'minUpgradableVersion', 'maxUpgradableVersion',
    'includesDbMigration', 'programRollbackSafe', 'healthCheck',
  ]);
  const keys = Object.keys(raw);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    return { ok: false, reason: '清单字段集合与协议不符' };
  }

  if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
    return { ok: false, reason: 'schemaVersion 必须是整数' };
  }
  if (raw.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, reason: `未知的清单主 schemaVersion：${String(raw.schemaVersion)}` };
  }

  if (typeof raw.version !== 'string' || !SEMVER_PATTERN.test(raw.version)) {
    return { ok: false, reason: '清单版本必须是稳定的 X.Y.Z' };
  }
  if (raw.channel !== 'stable') return { ok: false, reason: '清单通道必须是 stable' };
  if (raw.platform !== 'linux' || raw.arch !== 'x64') {
    return { ok: false, reason: '清单平台/架构必须是 linux/x64' };
  }
  if (typeof raw.publishedAt !== 'string' || !ISO_DATETIME_PATTERN.test(raw.publishedAt)) {
    return { ok: false, reason: 'publishedAt 必须是 ISO 8601 时间戳' };
  }
  if (expectedVersion !== undefined && raw.version !== expectedVersion) {
    return { ok: false, reason: '清单版本与预期版本不一致' };
  }

  const asset = raw.asset;
  if (!isPlainObject(asset) || !(['name', 'size', 'sha256'] as const).every((key) => key in asset)
    || Object.keys(asset).length !== 3) {
    return { ok: false, reason: '清单 asset 字段非法' };
  }
  if (typeof asset.name !== 'string' || !ASSET_NAME_PATTERN.test(asset.name)) {
    return { ok: false, reason: '清单资产名非法' };
  }
  if (asset.name !== `tgtc-v${raw.version}-linux-x64.zip`) {
    return { ok: false, reason: '清单资产名与版本不一致' };
  }
  if (typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    return { ok: false, reason: '清单资产大小非法' };
  }
  if (typeof asset.sha256 !== 'string' || !SHA256_PATTERN.test(asset.sha256)) {
    return { ok: false, reason: '清单资产 SHA-256 非法' };
  }

  if (typeof raw.minUpgradableVersion !== 'string' || !SEMVER_PATTERN.test(raw.minUpgradableVersion)) {
    return { ok: false, reason: 'minUpgradableVersion 必须是 X.Y.Z' };
  }
  const maxUpgradable = raw.maxUpgradableVersion;
  if (maxUpgradable !== null
    && (typeof maxUpgradable !== 'string' || !SEMVER_PATTERN.test(maxUpgradable))) {
    return { ok: false, reason: 'maxUpgradableVersion 必须是 X.Y.Z 或 null' };
  }
  const minTuple = raw.minUpgradableVersion.split('.').map(Number);
  const versionTuple = raw.version.split('.').map(Number);
  // 逐分量数值比较；JS 数组直接比较会退化为字符串比较（10 < 9），禁止使用。
  const compareTuple = (a: number[], b: number[]): number => {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  };
  if (compareTuple(minTuple, versionTuple) > 0) {
    return { ok: false, reason: 'minUpgradableVersion 不得高于本版本' };
  }
  if (typeof maxUpgradable === 'string') {
    const maxTuple = maxUpgradable.split('.').map(Number);
    if (compareTuple(versionTuple, maxTuple) > 0) {
      return { ok: false, reason: '本版本不得高于 maxUpgradableVersion' };
    }
  }

  if (typeof raw.includesDbMigration !== 'boolean' || typeof raw.programRollbackSafe !== 'boolean') {
    return { ok: false, reason: 'includesDbMigration/programRollbackSafe 必须是布尔值' };
  }

  const healthCheck = raw.healthCheck;
  if (!isPlainObject(healthCheck) || !(['path', 'timeoutMs'] as const).every((key) => key in healthCheck)
    || Object.keys(healthCheck).length !== 2) {
    return { ok: false, reason: '清单 healthCheck 字段非法' };
  }
  if (typeof healthCheck.path !== 'string' || !healthCheck.path.startsWith('/') || healthCheck.path.includes('..')) {
    return { ok: false, reason: 'healthCheck.path 必须是以 / 开头的站内路径' };
  }
  if (typeof healthCheck.timeoutMs !== 'number' || !Number.isInteger(healthCheck.timeoutMs)
    || healthCheck.timeoutMs < 1000 || healthCheck.timeoutMs > 600_000) {
    return { ok: false, reason: 'healthCheck.timeoutMs 必须在 1000-600000 之间' };
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      version: raw.version,
      channel: 'stable',
      publishedAt: raw.publishedAt,
      platform: 'linux',
      arch: 'x64',
      asset: { name: asset.name, size: asset.size, sha256: asset.sha256 },
      minUpgradableVersion: raw.minUpgradableVersion,
      maxUpgradableVersion: maxUpgradable,
      includesDbMigration: raw.includesDbMigration,
      programRollbackSafe: raw.programRollbackSafe,
      healthCheck: { path: healthCheck.path, timeoutMs: healthCheck.timeoutMs },
    },
  };
}

/** 判断当前版本是否允许自动升级到清单目标版本（含边界；max 为 null 表示不设上限）。 */
export function isUpgradableFrom(manifest: ReleaseManifest, currentVersion: string): boolean {
  const parsedCurrent = parseSemver(currentVersion);
  if (!parsedCurrent) return false;
  const aboveFloor = compareSemver(currentVersion, manifest.minUpgradableVersion);
  if (aboveFloor === null || aboveFloor < 0) return false;
  if (manifest.maxUpgradableVersion === null) return true;
  const belowCeiling = compareSemver(currentVersion, manifest.maxUpgradableVersion);
  return belowCeiling !== null && belowCeiling <= 0;
}

/**
 * 解析 SHA256SUMS 内容为 `文件名 -> sha256` 映射。
 * 只接受小写十六进制摘要与两空格分隔的标准格式。
 */
export function parseSha256Sums(text: string): Map<string, string> | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(trimmed);
    if (!match) return null;
    if (map.has(match[2])) return null;
    map.set(match[2], match[1]);
  }
  return map.size > 0 ? map : null;
}

/**
 * 从 SPKI DER 中解析 RSA 模长（字节），用于拒绝带尾部垃圾字节的签名。
 * openssl dgst -verify 会忽略签名文件的多余尾部字节，Node 端必须自行补齐该断言。
 */
function rsaModulusBytes(publicKeyPem: string | Buffer): number {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  let offset = 0;
  const readLength = (): number => {
    let length = der[offset++];
    if (length & 0x80) {
      const byteCount = length & 0x7f;
      length = 0;
      for (let i = 0; i < byteCount; i++) length = length * 256 + der[offset++];
    }
    return length;
  };
  if (der[offset++] !== 0x30) throw new Error('公钥 DER 结构非法');
  readLength(); // SPKI 总长
  if (der[offset++] !== 0x30) throw new Error('公钥 DER 结构非法');
  const algIdentifierLength = readLength();
  // 跳过 AlgorithmIdentifier 内容（OID rsaEncryption + NULL 参数）。
  offset += algIdentifierLength;
  if (der[offset++] !== 0x03) throw new Error('公钥 DER 结构非法');
  readLength(); // BIT STRING
  offset += 1; // 跳过 unused-bits 字节
  if (der[offset++] !== 0x30) throw new Error('公钥 DER 结构非法');
  readLength(); // RSAPublicKey SEQ
  if (der[offset++] !== 0x02) throw new Error('公钥 DER 结构非法');
  const modulusLength = readLength();
  // DER 整数若最高位为 1 会补前导 0x00，模长实际字节需扣除。
  return modulusLength > 0 && der[offset] === 0x00 ? modulusLength - 1 : modulusLength;
}

/**
 * 验证 SHA256SUMS 的发布签名（RSA PKCS#1 v1.5 / SHA-256）。
 * 同时断言：签名字节长度必须等于 RSA 模长（防尾部填充绕过），摘要必须匹配。
 */
export function verifySha256SumsSignature(
  sums: Buffer,
  signature: Buffer,
  publicKeyPem: string | Buffer,
): boolean {
  try {
    const expectedLength = rsaModulusBytes(publicKeyPem);
    if (signature.length !== expectedLength) return false;
    return cryptoVerify('sha256', sums, publicKeyPem, signature);
  } catch {
    return false;
  }
}

/** 计算缓冲区的小写 SHA-256 摘要（流式前的大小上限由调用方负责）。 */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
