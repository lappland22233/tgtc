#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# 由构建产物生成 release-manifest.json：
#   版本取自仓库根 VERSION；资产名/大小/SHA-256 直接从发行 ZIP 计算；
#   兼容窗口与迁移/回退标记由环境变量注入（CI 或发布操作者设置）。
#   生成后做结构自检，任何字段非法即整体失败，绝不产出部分写入的清单。
#
# 环境变量：
#   RELEASE_MIN_UPGRADABLE        默认 0.0.0（不设下限）
#   RELEASE_MAX_UPGRADABLE        默认空（null，不设上限）
#   RELEASE_INCLUDES_DB_MIGRATION 默认 false
#   RELEASE_ROLLBACK_SAFE         默认 true
#   RELEASE_HEALTH_PATH           默认 /api/health
#   RELEASE_HEALTH_TIMEOUT_MS     默认 30000
#
# Usage: generate-manifest.sh /absolute/path/to/output-dir
[[ $# -eq 1 ]] || die "$EXIT_USAGE" "用法：$0 OUTPUT_DIR"
[[ -d "$1" ]] || die "$EXIT_USAGE" "输出目录不存在：$1"
require_cmd node
require_cmd sha256sum
require_cmd stat
[[ -f "$SCRIPT_DIR/release-manifest.schema.json" ]] \
  || die "$EXIT_PRECHECK" '缺少 release-manifest.schema.json 字段契约；拒绝生成清单。'
OUTPUT_DIR=$(cd "$1" && pwd -P)
VERSION=$(read_version "$RELEASE_ROOT/VERSION")
ASSET_NAME="tgtc-v${VERSION}-linux-x64.zip"
ARCHIVE="$OUTPUT_DIR/$ASSET_NAME"
[[ -f "$ARCHIVE" ]] || die "$EXIT_PRECHECK" "发行 ZIP 不存在：$ARCHIVE"
ASSET_SIZE=$(stat -c '%s' "$ARCHIVE")
ASSET_SHA256=$(sha256sum "$ARCHIVE" | awk '{print $1}')

export MANIFEST_VERSION="$VERSION" \
  MANIFEST_ASSET_NAME="$ASSET_NAME" \
  MANIFEST_ASSET_SIZE="$ASSET_SIZE" \
  MANIFEST_ASSET_SHA256="$ASSET_SHA256" \
  MANIFEST_MIN_UPGRADABLE="${RELEASE_MIN_UPGRADABLE:-0.0.0}" \
  MANIFEST_MAX_UPGRADABLE="${RELEASE_MAX_UPGRADABLE:-}" \
  MANIFEST_INCLUDES_DB_MIGRATION="${RELEASE_INCLUDES_DB_MIGRATION:-false}" \
  MANIFEST_ROLLBACK_SAFE="${RELEASE_ROLLBACK_SAFE:-true}" \
  MANIFEST_HEALTH_PATH="${RELEASE_HEALTH_PATH:-/api/health}" \
  MANIFEST_HEALTH_TIMEOUT_MS="${RELEASE_HEALTH_TIMEOUT_MS:-30000}" \
  MANIFEST_OUTPUT="$OUTPUT_DIR/release-manifest.json"

node <<'NODE'
const fs = require('fs');

const env = process.env;
const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256Re = /^[0-9a-f]{64}$/;
const fail = (message) => { throw new Error(message); };

const version = env.MANIFEST_VERSION;
if (!semverRe.test(version)) fail(`清单版本必须是稳定的 X.Y.Z（不含预发布后缀）：${JSON.stringify(version)}`);

const assetName = env.MANIFEST_ASSET_NAME;
if (assetName !== `tgtc-v${version}-linux-x64.zip`) fail('资产名必须与版本一致。');

const assetSize = Number(env.MANIFEST_ASSET_SIZE);
if (!Number.isSafeInteger(assetSize) || assetSize <= 0) fail('资产大小非法。');

const assetSha256 = env.MANIFEST_ASSET_SHA256;
if (!sha256Re.test(assetSha256)) fail('资产 SHA-256 非法。');

const minUpgradable = env.MANIFEST_MIN_UPGRADABLE;
if (!semverRe.test(minUpgradable)) fail('minUpgradableVersion 必须是 X.Y.Z。');
const maxUpgradable = env.MANIFEST_MAX_UPGRADABLE === '' ? null : env.MANIFEST_MAX_UPGRADABLE;
if (maxUpgradable !== null && !semverRe.test(maxUpgradable)) fail('maxUpgradableVersion 必须是 X.Y.Z。');
// 逐分量数值比较；JS 数组直接比较会退化为字符串比较（10 < 9），禁止使用。
const semverTuple = (v) => v.split('.').map((part) => Number(part));
const compareTuple = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};
if (compareTuple(semverTuple(minUpgradable), semverTuple(version)) > 0) fail('minUpgradableVersion 不得高于本版本。');
if (maxUpgradable !== null && compareTuple(semverTuple(version), semverTuple(maxUpgradable)) > 0) fail('本版本不得高于 maxUpgradableVersion。');

const boolField = (raw, label) => {
  if (raw !== 'true' && raw !== 'false') fail(`${label} 必须是 true/false。`);
  return raw === 'true';
};
const includesDbMigration = boolField(env.MANIFEST_INCLUDES_DB_MIGRATION, 'includesDbMigration');
const programRollbackSafe = boolField(env.MANIFEST_ROLLBACK_SAFE, 'programRollbackSafe');

const healthPath = env.MANIFEST_HEALTH_PATH;
if (!healthPath.startsWith('/') || healthPath.includes('..')) fail('healthCheck.path 必须是以 / 开头的站内路径。');
const healthTimeoutMs = Number(env.MANIFEST_HEALTH_TIMEOUT_MS);
if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1000 || healthTimeoutMs > 600000) {
  fail('healthCheck.timeoutMs 必须在 1000-600000 之间。');
}

const manifest = {
  schemaVersion: 1,
  version,
  channel: 'stable',
  publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platform: 'linux',
  arch: 'x64',
  asset: { name: assetName, size: assetSize, sha256: assetSha256 },
  minUpgradableVersion: minUpgradable,
  maxUpgradableVersion: maxUpgradable,
  includesDbMigration,
  programRollbackSafe,
  healthCheck: { path: healthPath, timeoutMs: healthTimeoutMs },
};

// 结构自检：字段必须是封闭集合，与 release-manifest.schema.json 完全一致。
const requiredKeys = ['schemaVersion', 'version', 'channel', 'publishedAt', 'platform', 'arch',
  'asset', 'minUpgradableVersion', 'maxUpgradableVersion', 'includesDbMigration',
  'programRollbackSafe', 'healthCheck'];
const keys = Object.keys(manifest);
if (keys.length !== requiredKeys.length || requiredKeys.some((key) => !(key in manifest))) {
  fail('清单字段集合与 schema 契约不一致。');
}

const output = env.MANIFEST_OUTPUT;
const tmp = `${output}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
fs.renameSync(tmp, output);
console.log(`清单已生成：${output}`);
NODE

[[ -f "$OUTPUT_DIR/release-manifest.json" ]] || die "$EXIT_OPERATION" '清单生成失败。'
log "OK: release-manifest.json 已生成（v$VERSION）。"
