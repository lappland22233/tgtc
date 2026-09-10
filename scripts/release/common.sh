#!/usr/bin/env bash
# Shared, deliberately conservative primitives for release-package operations.
set -Eeuo pipefail

readonly EXIT_USAGE=2 EXIT_PRECHECK=3 EXIT_VERIFY=4 EXIT_OPERATION=5 EXIT_ROLLBACK=6
# Exporting documents these as the stable interface for scripts that source this file.
export EXIT_USAGE EXIT_PRECHECK EXIT_VERIFY EXIT_OPERATION EXIT_ROLLBACK
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
find_release_root() {
  local candidate="$SCRIPT_DIR"
  while [[ "$candidate" != / ]]; do
    [[ -f "$candidate/VERSION" ]] && { printf '%s' "$candidate"; return; }
    candidate=$(dirname "$candidate")
  done
  die "$EXIT_PRECHECK" '找不到发行根目录 VERSION；拒绝操作。'
}
RELEASE_ROOT="$(find_release_root)"
if [[ "$(basename "$(dirname "$RELEASE_ROOT")")" == releases ]]; then
  INSTALL_ROOT="$(dirname "$(dirname "$RELEASE_ROOT")")"
else
  INSTALL_ROOT="${TGTC_INSTALL_ROOT:-$(dirname "$RELEASE_ROOT")}"
fi
# 持久化运行时目录（.env、数据库、Bot API workdir）由各运维脚本读取，故在此统一解析。
# shellcheck disable=SC2034
RUNTIME_DIR="$INSTALL_ROOT/runtime"
STATE_DIR="${TGTC_STATE_DIR:-$INSTALL_ROOT/.tgtc-ops}"
LOCK_FILE="$STATE_DIR/operation.lock"

log() { printf '[tgtc-ops] %s\n' "$*" >&2; }
die() { local code=$1; shift; log "ERROR: $*"; exit "$code"; }
require_linux() { [[ "$(uname -s)" == Linux ]] || die "$EXIT_PRECHECK" '仅支持 Linux；拒绝在其他平台操作。'; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "$EXIT_PRECHECK" "缺少必需命令：$1"; }
acquire_lock() {
  [[ ${TGTC_SKIP_LOCK:-0} == 1 ]] && return 0
  mkdir -p "$STATE_DIR"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "$EXIT_OPERATION" '已有运维操作正在执行。'
}
record_state() { mkdir -p "$STATE_DIR"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATE_DIR/history.log"; }
valid_version() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; }
read_version() { local file=$1 value; [[ -f "$file" ]] || die "$EXIT_VERIFY" "缺少 VERSION：$file"; value=$(tr -d '\r\n' < "$file"); valid_version "$value" || die "$EXIT_VERIFY" 'VERSION 不是有效 SemVer。'; printf '%s' "$value"; }
# Protected runtime state must never be included in an activation candidate.
# 注意：不得使用 `cmd && die` 模式——校验通过时 grep 返回 1 会让整个函数在
# set -e 下以非零退出，调用方（upgrade.sh 等）会误判为校验失败而静默中止。
assert_no_protected_payload() {
  local dir=$1 path
  for path in telegram-bot-api/data backend/.env .env redis uploads logs cache; do
    [[ ! -e "$dir/$path" ]] || die "$EXIT_PRECHECK" "候选发行包包含受保护路径 $path；拒绝覆盖。"
  done
  if find "$dir" -type f \( -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' -o -name 'td.binlog*' -o -name 'db.sqlite*' \) -print -quit | grep -q .; then
    die "$EXIT_PRECHECK" '候选发行包包含数据库或 Telegram 持久化文件；拒绝覆盖。'
  fi
}
api_get() { local endpoint=$1; require_cmd curl; curl --fail --silent --show-error --max-time "${TGTC_HTTP_TIMEOUT:-5}" "${TGTC_API_URL:-http://127.0.0.1:3000}/api/$endpoint"; }

# ---- M4：程序回退安全标志（fail-closed） ----
# 读取发行目录内 release-manifest.json 的 programRollbackSafe。
# 输出 true / false / unknown；清单缺失、为符号链接或字段非法一律返回 unknown。
# 不依赖 jq/python：清单由 generate-manifest.sh 机器生成，字段格式固定。
release_rollback_safe_flag() {
  local dir=$1 manifest="$1/release-manifest.json" raw=''
  [[ -f "$manifest" && ! -L "$manifest" ]] || { printf 'unknown'; return 0; }
  raw=$(grep -oE '"programRollbackSafe"[[:space:]]*:[[:space:]]*(true|false)' "$manifest" 2>/dev/null | head -n1 | grep -oE '(true|false)$' || true)
  case "$raw" in
    true|false) printf '%s' "$raw" ;;
    *) printf 'unknown' ;;
  esac
}

# M4：回滚安全门。仅当标志为 true 才允许脚本自动切回旧代码。
# false/unknown 时拒绝执行并输出人工恢复指引（先停服→恢复备份→核对 Bot API 工作目录与 .env）；
# 运维确认数据库已恢复后可显式设置 TGTC_ACK_DB_RESTORED=1 放行。
# 参数：$1 当前（待回退）发行目录；$2 目标发行目录；$3 当前版本号。
require_rollback_safe() {
  local release_dir=$1 target_dir=$2 from_version=$3 flag
  flag=$(release_rollback_safe_flag "$release_dir")
  if [[ "$flag" == 'true' ]]; then
    return 0
  fi
  if [[ "${TGTC_ACK_DB_RESTORED:-0}" == '1' ]]; then
    log "WARN: 已按 TGTC_ACK_DB_RESTORED=1 显式确认数据库已恢复，继续代码回退（programRollbackSafe=$flag，from=$from_version）。"
    return 0
  fi
  die "$EXIT_PRECHECK" "拒绝自动回退：当前版本 $from_version 的程序回退安全标志为 $flag（仅 true 允许脚本自动切回旧代码）。
该标志缺失/false 表示本版本可能包含不可逆数据库迁移：切回旧代码会让数据库停留在新 schema 上。
请按以下步骤人工恢复后再回退（目标版本目录：$target_dir）：
  1) systemctl stop ${TGTC_SERVICE:-tgtc.service}
  2) 从 $INSTALL_ROOT/backups/<时间戳>/ 恢复数据库备份（PostgreSQL: pg_restore；SQLite: 停服后原子替换数据库文件）
  3) 核对 Telegram Bot API 工作目录（--dir，与 file_id 强绑定，禁止清空/重命名）与应用 .env（尤其 DB_* 连接项）
  4) 确认数据库已恢复到旧版本 schema 后，设置 TGTC_ACK_DB_RESTORED=1 重跑本脚本完成代码回退。
本脚本不会自动删除或重命名 Bot API 工作目录，也不会自动执行数据库迁移回退。"
}
