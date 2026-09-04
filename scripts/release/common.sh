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
