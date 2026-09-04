#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Usage: validate-release.sh /absolute/path/to/tgtc-vX.Y.Z-linux-x64.zip [SHA256SUMS]
[[ $# -ge 1 && $# -le 2 ]] || die "$EXIT_USAGE" "用法：$0 ARCHIVE.zip [SHA256SUMS]"
ARCHIVE=$1; SUMS=${2:-"$(dirname "$ARCHIVE")/SHA256SUMS"}
require_linux; for command in python3 sha256sum; do require_cmd "$command"; done
[[ "$ARCHIVE" == *.zip ]] || die "$EXIT_USAGE" '发行归档必须为 .zip 文件。'
[[ -f "$ARCHIVE" && -f "$SUMS" ]] || die "$EXIT_PRECHECK" '发行归档或 SHA256SUMS 不存在。'
ARCHIVE_NAME=$(basename "$ARCHIVE")
ARCHIVE_DIR=$(cd "$(dirname "$ARCHIVE")" && pwd -P)
SUMS_DIR=$(cd "$(dirname "$SUMS")" && pwd -P)
ARCHIVE="$ARCHIVE_DIR/$ARCHIVE_NAME"
SUMS="$SUMS_DIR/$(basename "$SUMS")"
MANIFEST="$SUMS_DIR/release-manifest.json"
ARCHIVE_SHA256=$(sha256sum "$ARCHIVE" | awk '{print $1}')
# SHA256SUMS 必须与发行 ZIP 完全匹配；若目录中存在 release-manifest.json，
# 其摘要行也必须存在并匹配（签名因此同时覆盖 ZIP 与清单）。
(
  cd "$SUMS_DIR"
  expected_lines=1
  [[ -f release-manifest.json ]] && expected_lines=2
  [[ $(wc -l < "$(basename "$SUMS")") -eq $expected_lines ]]
  grep -Fqx "$ARCHIVE_SHA256  $ARCHIVE_NAME" "$(basename "$SUMS")"
  if [[ -f release-manifest.json ]]; then
    grep -Fqx "$(sha256sum release-manifest.json | awk '{print $1}')  release-manifest.json" "$(basename "$SUMS")"
  fi
) || die "$EXIT_VERIFY" 'SHA256SUMS 必须且只能包含与 ZIP 和 release-manifest.json 匹配的摘要行。'

# 存在签名时必须通过内置公钥验证；无签名仅允许本地构建场景（正式发布强制签名由 CI 保证）。
# openssl dgst -verify 会忽略签名文件尾部多余字节，因此先断言签名长度等于公钥模长。
if [[ -f "$SUMS.sig" ]]; then
  require_cmd openssl
  require_cmd stat
  PUB="$RELEASE_ROOT/scripts/release/update-public-key.pem"
  [[ -f "$PUB" ]] || die "$EXIT_PRECHECK" "检测到 SHA256SUMS.sig 但缺少验证公钥：$PUB"
  key_bits=$(openssl rsa -pubin -in "$PUB" -noout -text 2>/dev/null | grep -oE '[0-9]+ bit' | head -n1 | grep -oE '[0-9]+')
  [[ -n "$key_bits" ]] || die "$EXIT_PRECHECK" '无法解析验证公钥模长。'
  sig_bytes=$(stat -c '%s' "$SUMS.sig")
  [[ "$sig_bytes" -eq $((key_bits / 8)) ]] || die "$EXIT_VERIFY" 'SHA256SUMS 签名长度非法。'
  openssl dgst -sha256 -verify "$PUB" -signature "$SUMS.sig" "$SUMS" >/dev/null 2>&1 \
    || die "$EXIT_VERIFY" 'SHA256SUMS 签名验证失败。'
  log "OK: SHA256SUMS 签名验证通过。"
fi

if ! ARCHIVE="$ARCHIVE" ARCHIVE_NAME="$ARCHIVE_NAME" MANIFEST="$MANIFEST" ARCHIVE_SHA256="$ARCHIVE_SHA256" python3 <<'PY'
import json
import os
import re
import stat
import sys
import zipfile

archive = os.environ['ARCHIVE']
archive_name = os.environ['ARCHIVE_NAME']
name_pattern = re.compile(r'^tgtc-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-linux-x64\.zip$')
match = name_pattern.fullmatch(archive_name)
if not match:
    raise SystemExit('发行 ZIP 文件名非法。')
version_from_name = archive_name[len('tgtc-v'):-len('-linux-x64.zip')]
root = f'tgtc-v{version_from_name}-linux-x64'
required = {
    f'{root}/VERSION', f'{root}/backend/dist/main.js', f'{root}/backend/dist/database/data-source.js',
    f'{root}/frontend/index.html', f'{root}/runtime/bin/node', f'{root}/bin/tgtc', f'{root}/start.sh',
    f'{root}/telegram-bot-api/bin/telegram-bot-api', f'{root}/scripts/release/common.sh',
    f'{root}/scripts/release/health-check.sh', f'{root}/scripts/release/backup.sh',
    f'{root}/scripts/release/upgrade.sh', f'{root}/scripts/release/rollback.sh',
    f'{root}/scripts/release/validate-release.sh', f'{root}/scripts/release/update-public-key.pem',
}
executables = {
    f'{root}/start.sh', f'{root}/bin/tgtc', f'{root}/runtime/bin/node',
    f'{root}/telegram-bot-api/bin/telegram-bot-api', f'{root}/scripts/release/health-check.sh',
    f'{root}/scripts/release/backup.sh', f'{root}/scripts/release/upgrade.sh',
    f'{root}/scripts/release/rollback.sh', f'{root}/scripts/release/validate-release.sh',
}
forbidden_parts = ('telegram-bot-api/data/', 'redis/', 'uploads/', 'logs/', 'cache/')
forbidden_files = ('.env', 'backend/.env')
max_members = 100_000
max_member_bytes = 2 * 1024 * 1024 * 1024
max_total_bytes = 20 * 1024 * 1024 * 1024
with zipfile.ZipFile(archive) as package:
    infos = package.infolist()
    if not infos:
        raise SystemExit('发行 ZIP 为空。')
    if len(infos) > max_members:
        raise SystemExit('发行 ZIP 成员数量超过安全上限。')
    total_bytes = sum(info.file_size for info in infos)
    if total_bytes > max_total_bytes or any(info.file_size > max_member_bytes for info in infos):
        raise SystemExit('发行 ZIP 解压大小超过安全上限。')
    names = [info.filename for info in infos]
    if len(names) != len(set(names)):
        raise SystemExit('发行 ZIP 包含重复成员。')
    for info in infos:
        name = info.filename
        if name.startswith('/') or '\\' in name or any(part in ('', '.', '..') for part in name.rstrip('/').split('/')):
            raise SystemExit(f'发行 ZIP 包含不安全路径：{name!r}')
        if not name.startswith(root + '/'):
            raise SystemExit(f'发行 ZIP 必须只有顶层目录 {root}/：{name!r}')
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind and kind not in (stat.S_IFREG, stat.S_IFDIR):
            raise SystemExit(f'发行 ZIP 包含不允许的成员类型：{name!r}')
        if stat.S_ISLNK(mode):
            raise SystemExit(f'发行 ZIP 不允许符号链接：{name!r}')
        relative = name[len(root) + 1:]
        if relative in forbidden_files or relative.startswith(forbidden_parts) or relative.endswith(('.sqlite', '.sqlite3', '.db', '.map', '.ts')) or relative.endswith('.spec.js') or relative.startswith('td.binlog') or relative.startswith('db.sqlite') or '/test/' in relative or '/tests/' in relative or '/__tests__/' in relative:
            raise SystemExit(f'发行 ZIP 包含禁止内容：{name!r}')
    missing = required.difference(names)
    if missing:
        raise SystemExit(f'发行 ZIP 缺少必需文件：{sorted(missing)[0]}')
    for name in executables:
        mode = package.getinfo(name).external_attr >> 16
        if not mode or not (mode & stat.S_IXUSR):
            raise SystemExit(f'发行 ZIP 未保留可执行权限：{name}')
    version = package.read(f'{root}/VERSION').decode('utf-8').strip()
    if version != version_from_name:
        raise SystemExit('ZIP 文件名、顶层目录和包内 VERSION 不一致。')

manifest_path = os.environ.get('MANIFEST') or ''
if manifest_path and os.path.isfile(manifest_path):
    semver_re = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
    def semver_tuple(value):
        return tuple(int(part) for part in value.split('.'))
    try:
        with open(manifest_path, 'rb') as fh:
            manifest = json.loads(fh.read().decode('utf-8'))
    except Exception:
        raise SystemExit('release-manifest.json 不是合法 UTF-8 JSON。')
    if not isinstance(manifest, dict):
        raise SystemExit('release-manifest.json 顶层必须是对象。')
    allowed_top = {'schemaVersion', 'version', 'channel', 'publishedAt', 'platform', 'arch',
                   'asset', 'minUpgradableVersion', 'maxUpgradableVersion',
                   'includesDbMigration', 'programRollbackSafe', 'healthCheck'}
    if set(manifest) != allowed_top:
        raise SystemExit('清单字段集合与协议不符（封闭集合，未知主 schemaVersion 拒绝）。')
    if type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1:
        raise SystemExit('未知 schemaVersion；拒绝该清单。')
    if manifest['channel'] != 'stable':
        raise SystemExit('清单通道必须是 stable。')
    if manifest['platform'] != 'linux' or manifest['arch'] != 'x64':
        raise SystemExit('清单平台/架构必须是 linux/x64。')
    if not (isinstance(manifest['version'], str) and semver_re.fullmatch(manifest['version'])):
        raise SystemExit('清单版本非法。')
    if manifest['version'] != version_from_name:
        raise SystemExit('清单版本与 ZIP 文件名版本不一致。')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', manifest['publishedAt'] or ''):
        raise SystemExit('publishedAt 必须是 ISO 8601 时间戳。')
    asset = manifest['asset']
    if not isinstance(asset, dict) or set(asset) != {'name', 'size', 'sha256'}:
        raise SystemExit('清单 asset 字段非法。')
    if asset['name'] != archive_name:
        raise SystemExit('清单资产名与实际 ZIP 文件名不一致。')
    if type(asset['size']) is not int or asset['size'] != os.path.getsize(archive):
        raise SystemExit('清单资产大小与实际 ZIP 不一致。')
    if asset['sha256'] != os.environ['ARCHIVE_SHA256']:
        raise SystemExit('清单资产摘要与实际 ZIP 不一致。')
    min_upgradable = manifest['minUpgradableVersion']
    if not (isinstance(min_upgradable, str) and semver_re.fullmatch(min_upgradable)):
        raise SystemExit('minUpgradableVersion 非法。')
    max_upgradable = manifest['maxUpgradableVersion']
    if max_upgradable is not None and not (isinstance(max_upgradable, str) and semver_re.fullmatch(max_upgradable)):
        raise SystemExit('maxUpgradableVersion 非法。')
    if semver_tuple(min_upgradable) > semver_tuple(version_from_name):
        raise SystemExit('minUpgradableVersion 不得高于本版本。')
    if max_upgradable is not None and semver_tuple(version_from_name) > semver_tuple(max_upgradable):
        raise SystemExit('本版本不得高于 maxUpgradableVersion。')
    for flag in ('includesDbMigration', 'programRollbackSafe'):
        if type(manifest[flag]) is not bool:
            raise SystemExit(f'{flag} 必须是布尔值。')
    health = manifest['healthCheck']
    if not isinstance(health, dict) or set(health) != {'path', 'timeoutMs'}:
        raise SystemExit('清单 healthCheck 字段非法。')
    if not isinstance(health['path'], str) or not health['path'].startswith('/') or '..' in health['path']:
        raise SystemExit('healthCheck.path 必须是以 / 开头的站内路径。')
    if type(health['timeoutMs']) is not int or not (1000 <= health['timeoutMs'] <= 600000):
        raise SystemExit('healthCheck.timeoutMs 必须在 1000-600000 之间。')
print(f'ZIP 制品验证通过：{version}')
PY
then
  die "$EXIT_VERIFY" 'ZIP 制品结构、权限、路径或内容校验失败。'
fi
log "OK: ZIP 发行包验证通过。"
