#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# TGTC 固定更新器入口（受 sudoers/systemd oneshot 约束的唯一执行点）。
#
# 调用方式：updater.sh <uuid 任务 ID>
# 任务描述 JSON 必须由后端（UpdateRunnerService）预先写入固定任务目录：
#   $TGTC_UPDATE_TASK_DIR/<task-id>.json（默认 $STATE_DIR/update-tasks/）
# 更新器不信任任何命令行参数（除任务 ID），自行重新校验版本、制品名、
# 路径、摘要、签名、schema、平台与兼容性；全程向 .state/.heartbeat 回传
# 进度，供后端同步任务状态机。
#
# 退出码：0 成功；2 用法；3 预检；4 校验；5 操作失败；6 回退失败。
[[ $# -eq 1 ]] || die "$EXIT_USAGE" "用法：$0 TASK_ID"
TASK_ID=$1
[[ "$TASK_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || die "$EXIT_USAGE" '任务 ID 必须是 uuid。'

TASK_DIR="${TGTC_UPDATE_TASK_DIR:-$STATE_DIR/update-tasks}"
TASK_FILE="$TASK_DIR/$TASK_ID.json"
STATE_FILE="$TASK_DIR/$TASK_ID.state"
HEARTBEAT_FILE="$TASK_DIR/$TASK_ID.heartbeat"
CURRENT_LINK="$INSTALL_ROOT/current"
SERVICE="${TGTC_SERVICE:-tgtc.service}"
ENV_FILE="${TGTC_ENV_FILE:-$RUNTIME_DIR/backend/.env}"
MAX_ASSET_BYTES="${TGTC_UPDATE_MAX_ASSET_BYTES:-3221225472}"
# 工作目录必须在 root 专属位置（默认 /var/lib/tgtc-update），
# 绝不放在后端服务账号可写的任务目录内：被控后端可借符号链接或
# 校验后替换制品绕过整条签名链（防提权边界）。
UPDATE_WORK_ROOT="${TGTC_UPDATE_WORK_ROOT:-/var/lib/tgtc-update}"

require_linux
for command in python3 curl unzip sha256sum openssl flock stat df id; do require_cmd "$command"; done
[[ -f "$TASK_FILE" && ! -L "$TASK_FILE" ]] || die "$EXIT_PRECHECK" "任务描述不存在：拒绝执行。"
[[ "$TASK_DIR" != /* || ! -d "$TASK_DIR" || -L "$TASK_DIR" ]] \
  && die "$EXIT_PRECHECK" '任务目录必须为已存在的真实目录。'
# 任务目录/描述不得 group/other 可写，防止任务被同机其他账号替换。
assert_not_widely_writable() {
  local mode=${1#0}
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 0
  # 三元组为 (owner, group, other)；owner 写位合法，仅断言 group/other 写位。
  local triplet=${mode: -3}
  if [[ "${triplet:1:1}" == [2367] || "${triplet:2:1}" == [2367] ]]; then
    return 1
  fi
}
assert_not_widely_writable "$(stat -c '%a' "$TASK_DIR")" \
  || die "$EXIT_PRECHECK" '任务目录 group/other 可写；拒绝执行。'
assert_not_widely_writable "$(stat -c '%a' "$TASK_FILE")" \
  || die "$EXIT_PRECHECK" '任务描述 group/other 可写；拒绝执行。'
[[ -f "$RELEASE_ROOT/scripts/release/update-public-key.pem" ]] || die "$EXIT_PRECHECK" '缺少发布验证公钥。'
# 公钥是签名验证的信任根：不得 group/other 可写（防止被替换后绕过签名门）。
assert_not_widely_writable "$(stat -c '%a' "$RELEASE_ROOT/scripts/release/update-public-key.pem")" \
  || die "$EXIT_PRECHECK" '验证公钥 group/other 可写；拒绝执行。'

acquire_lock   # OS 文件锁：与 API 派发、人工运维脚本互斥

# 建立并加固 root 专属工作根目录（符号链接拒绝；root 运行时强制属主与 0700）。
if [[ -L "$UPDATE_WORK_ROOT" ]]; then
  die "$EXIT_PRECHECK" '更新工作根目录不允许为符号链接。'
fi
mkdir -p "$UPDATE_WORK_ROOT"
chmod 700 "$UPDATE_WORK_ROOT"
if [[ "$(id -u)" == '0' ]]; then
  chown 0:0 "$UPDATE_WORK_ROOT" 2>/dev/null || true
fi
WORK_DIR=$(mktemp -d "$UPDATE_WORK_ROOT/tgtc-update-XXXXXX")
set_state() { printf '%s\n' "$1" > "$STATE_FILE"; }
report_task_error() { log "ERROR: $*"; printf '%s\n' "$2" > "$TASK_DIR/$TASK_ID.error"; }
cleanup() {
  [[ -n "${HEARTBEAT_PID:-}" ]] && kill "$HEARTBEAT_PID" 2>/dev/null || true
  pkill -P "$HEARTBEAT_PID" 2>/dev/null || true
  rm -rf -- "$WORK_DIR"
  rm -f -- "$HEARTBEAT_FILE"
}
trap cleanup EXIT
set_state downloading
# 心跳子 shell 必须关闭继承的锁 fd（9），否则会泄漏运维锁并阻塞后续任务。
( while :; do date -u +%FT%TZ > "$HEARTBEAT_FILE"; sleep 10; done ) 9>&- & HEARTBEAT_PID=$!

# ---- 解析并校验任务描述（不信任内容，仅接受白名单字段） ----
read -r TASK_VERSION ASSET_NAME ASSET_SIZE ASSET_SHA256 ASSET_URL \
  SUMS_URL SUMS_SHA SIG_URL MANIFEST_URL MANIFEST_SHA EXPECTED_CURRENT \
  < <(TGTF_FILE="$TASK_FILE" python3 <<'PY'
import json, os, re
path = os.environ['TGTF_FILE']
with open(path, 'rb') as fh:
    task = json.load(fh)
semver = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
sha = re.compile(r'^[0-9a-f]{64}$')
url = re.compile(r'^https://(github\.com|objects\.githubusercontent\.com)/[!-~]+$')
def need(cond, label):
    if not cond:
        raise SystemExit(f'任务描述字段非法：{label}')
need(isinstance(task, dict), '顶层')
need(set(task) == {'schemaVersion','taskId','version','releaseTag','currentVersion','asset','sums','sumsSig','manifest','includesDbMigration','programRollbackSafe'}, '字段集合')
need(task['schemaVersion'] == 1, 'schemaVersion')
version = task['version']
need(bool(semver.fullmatch(version)), 'version')
need(task['releaseTag'] == f'v{version}', 'releaseTag')
asset = task['asset']
need(set(asset) == {'name','size','sha256','url'}, 'asset')
need(asset['name'] == f'tgtc-v{version}-linux-x64.zip', 'asset.name')
need(isinstance(asset['size'], int) and asset['size'] > 0, 'asset.size')
need(bool(sha.fullmatch(asset['sha256'])), 'asset.sha256')
need(bool(url.fullmatch(asset['url'])), 'asset.url')
sums = task['sums']; sig = task['sumsSig']; manifest = task['manifest']
need(set(sums) == {'url','sha256'} and bool(sha.fullmatch(sums['sha256'])) and bool(url.fullmatch(sums['url'])), 'sums')
need(set(sig) == {'url'} and bool(url.fullmatch(sig['url'])), 'sumsSig')
need(set(manifest) == {'url','sha256'} and bool(sha.fullmatch(manifest['sha256'])) and bool(url.fullmatch(manifest['url'])), 'manifest')
need(task['includesDbMigration'] in (True, False), 'includesDbMigration')
need(task['programRollbackSafe'] in (True, False), 'programRollbackSafe')
current = task['currentVersion']
need(bool(semver.fullmatch(current)), 'currentVersion')
print(' '.join([
  version, asset['name'], str(asset['size']), asset['sha256'], asset['url'],
  sums['url'], sums['sha256'], sig['url'], manifest['url'], manifest['sha256'], current,
]))
PY
) || die "$EXIT_PRECHECK" '任务描述校验失败。'

# 来源核验：任务描述的当前版本必须与部署现状一致，防止陈旧任务误执行。
[[ "$EXPECTED_CURRENT" == "$(read_version "$RELEASE_ROOT/VERSION")" ]] \
  || die "$EXIT_PRECHECK" '任务描述中的当前版本与本机部署不一致；拒绝执行。'
[[ -L "$CURRENT_LINK" ]] || die "$EXIT_PRECHECK" "current 不是符号链接：$CURRENT_LINK"
PREVIOUS=$(readlink -f "$CURRENT_LINK")
[[ -d "$PREVIOUS" ]] || die "$EXIT_PRECHECK" 'current 指向不存在的发行目录。'

# ---- 下载：固定 staging、大小/时长/重定向受限、主机白名单 ----
bash "$SCRIPT_DIR/download-release.sh" "$ASSET_URL" "$WORK_DIR/$ASSET_NAME" "$MAX_ASSET_BYTES"
bash "$SCRIPT_DIR/download-release.sh" "$SUMS_URL" "$WORK_DIR/SHA256SUMS" 1048576
bash "$SCRIPT_DIR/download-release.sh" "$SIG_URL" "$WORK_DIR/SHA256SUMS.sig" 4096
bash "$SCRIPT_DIR/download-release.sh" "$MANIFEST_URL" "$WORK_DIR/release-manifest.json" 1048576
[[ "$(stat -c '%s' "$WORK_DIR/$ASSET_NAME")" -eq "$ASSET_SIZE" ]] \
  || { report_task_error 'artifact_size_mismatch' '发行包大小与任务描述不一致。'; die "$EXIT_VERIFY" '发行包大小与任务描述不一致。'; }

# ---- 校验：签名 → 摘要 → 清单 schema/版本/平台/兼容性 ----
set_state verifying
PUB="$RELEASE_ROOT/scripts/release/update-public-key.pem"
key_bits=$(openssl rsa -pubin -in "$PUB" -noout -text 2>/dev/null | grep -oE '[0-9]+ bit' | head -n1 | grep -oE '[0-9]+')
[[ -n "$key_bits" ]] || die "$EXIT_VERIFY" '无法解析公钥模长。'
[[ $(stat -c '%s' "$WORK_DIR/SHA256SUMS.sig") -eq $((key_bits / 8)) ]] \
  || { report_task_error 'signature_invalid' 'SHA256SUMS 签名长度非法。'; die "$EXIT_VERIFY" 'SHA256SUMS 签名长度非法。'; }
openssl dgst -sha256 -verify "$PUB" -signature "$WORK_DIR/SHA256SUMS.sig" "$WORK_DIR/SHA256SUMS" >/dev/null 2>&1 \
  || { report_task_error 'signature_invalid' 'SHA256SUMS 签名验证失败。'; die "$EXIT_VERIFY" 'SHA256SUMS 签名验证失败。'; }
[[ "$(sha256sum "$WORK_DIR/SHA256SUMS" | awk '{print $1}')" == "$SUMS_SHA" ]] \
  || { report_task_error 'sums_mismatch' 'SHA256SUMS 摘要与任务描述不一致。'; die "$EXIT_VERIFY" 'SHA256SUMS 摘要与任务描述不一致。'; }
[[ "$(sha256sum "$WORK_DIR/release-manifest.json" | awk '{print $1}')" == "$MANIFEST_SHA" ]] \
  || { report_task_error 'manifest_mismatch' '清单摘要与任务描述不一致。'; die "$EXIT_VERIFY" '清单摘要与任务描述不一致。'; }
[[ "$(sha256sum "$WORK_DIR/$ASSET_NAME" | awk '{print $1}')" == "$ASSET_SHA256" ]] \
  || { report_task_error 'asset_digest_mismatch' '发行包摘要与任务描述不一致。'; die "$EXIT_VERIFY" '发行包摘要与任务描述不一致。'; }
grep -Fqx "$ASSET_SHA256  $ASSET_NAME" "$WORK_DIR/SHA256SUMS" \
  || { report_task_error 'sums_missing_asset' 'SHA256SUMS 缺少发行包摘要行。'; die "$EXIT_VERIFY" 'SHA256SUMS 缺少发行包摘要行。'; }

MANIFEST_JSON=$(cat "$WORK_DIR/release-manifest.json")
if MANIFEST_JSON="$MANIFEST_JSON" TASK_VERSION="$TASK_VERSION" EXPECTED_CURRENT="$EXPECTED_CURRENT" python3 <<'PY'
import json, os
manifest = json.loads(os.environ['MANIFEST_JSON'])
version = os.environ['TASK_VERSION']
current = os.environ['EXPECTED_CURRENT']
def tuple_of(v):
    return tuple(int(part) for part in v.split('.'))
def version_le(a, b):
    return tuple_of(a) <= tuple_of(b)
checks = [
    manifest.get('schemaVersion') == 1,
    manifest.get('version') == version,
    manifest.get('channel') == 'stable',
    manifest.get('platform') == 'linux',
    manifest.get('arch') == 'x64',
    manifest.get('programRollbackSafe') is True,
    # 兼容窗口（含边界）
    version_le(manifest.get('minUpgradableVersion', '0.0.0'), current),
    manifest.get('maxUpgradableVersion') is None or version_le(current, manifest['maxUpgradableVersion']),
    # 防降级：目标必须严格高于当前版本（历史签名的旧版不得借任务 JSON 回装）
    tuple_of(version) > tuple_of(current),
    manifest.get('asset', {}).get('name') == f'tgtc-v{version}-linux-x64.zip',
]
if all(checks):
    print(f"includesDbMigration={str(manifest.get('includesDbMigration')).lower()}")
else:
    raise SystemExit('manifest check failed')
PY
then
  :
else
  report_task_error 'manifest_check_failed' '清单校验或兼容性检查未通过。'
  die "$EXIT_VERIFY" '清单校验或兼容性检查未通过。'
fi

# ---- 预检：磁盘、服务单元形态 ----
set_state prechecking
AVAILABLE_KB=$(df -Pk "$INSTALL_ROOT" | awk 'NR==2 {print $4}')
REQUIRED_KB=$(( (ASSET_SIZE / 1024) * 2 + 262144 ))
(( AVAILABLE_KB >= REQUIRED_KB )) || { report_task_error 'insufficient_disk' '安装根目录磁盘空间不足。'; die "$EXIT_PRECHECK" '安装根目录磁盘空间不足。'; }
systemctl cat "$SERVICE" 2>/dev/null | grep -Fq "$CURRENT_LINK/" \
  || die "$EXIT_PRECHECK" "服务单元未使用 $CURRENT_LINK；拒绝非原子升级。"

# ---- 交接 upgrade.sh：备份 → 解包 → 迁移 → 切换 → 重启 → 健康检查 ----
# upgrade.sh 通过 TGTC_PROGRESS_FILE 回写状态机阶段；失败在对应阶段停止。
set_state backing_up
set +e
TGTC_SKIP_LOCK=1 TGTC_ENV_FILE="$ENV_FILE" TGTC_PROGRESS_FILE="$STATE_FILE" \
  bash "$SCRIPT_DIR/upgrade.sh" "$WORK_DIR/$ASSET_NAME" "$WORK_DIR/SHA256SUMS"
UPGRADE_EXIT=$?
set -e
if (( UPGRADE_EXIT != 0 )); then
  # 失败分类：升级脚本自行回退（切回旧链接）、升级成功但回退失败、或从未切换。
  STILL_CURRENT=$(readlink -f "$CURRENT_LINK")
  if [[ "$STILL_CURRENT" != "$PREVIOUS" ]]; then
    RUNNING_VERSION=$(read_version "$STILL_CURRENT/VERSION")
    [[ "$RUNNING_VERSION" == "$TASK_VERSION" ]] && FINAL='rollback_failed' || FINAL='rolled_back'
  else
    FINAL='rolled_back'
  fi
  set_state rollback_pending
  set_state rolling_back
  set_state "$FINAL"
  report_task_error "upgrade_failed_exit_${UPGRADE_EXIT}" '更新失败；已按状态机记录回退结果。'
  if [[ "$FINAL" == 'rollback_failed' ]]; then
    die "$EXIT_ROLLBACK" '更新失败且回退未成功；需要人工介入。'
  fi
  die "$EXIT_OPERATION" '更新失败；已确认旧版本继续运行。'
fi

set_state succeeded
record_state "updater ok task=$TASK_ID version=$TASK_VERSION previous=$PREVIOUS"
log "OK: 更新任务 $TASK_ID 完成，已升级到 $TASK_VERSION。"
