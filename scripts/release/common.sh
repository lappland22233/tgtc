#!/usr/bin/env bash
# Shared paths and checks for manual backup and health checks.
set -Eeuo pipefail

readonly EXIT_USAGE=2 EXIT_PRECHECK=3 EXIT_VERIFY=4 EXIT_OPERATION=5
# Exporting documents these as the stable interface for scripts that source this file.
export EXIT_USAGE EXIT_PRECHECK EXIT_VERIFY EXIT_OPERATION
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
INSTALL_ROOT="${TGTC_INSTALL_ROOT:-$SOURCE_ROOT}"
if [[ "$(basename "$(dirname "$SOURCE_ROOT")")" == releases && -z "${TGTC_INSTALL_ROOT:-}" ]]; then
  INSTALL_ROOT="$(dirname "$(dirname "$SOURCE_ROOT")")"
fi
STATE_DIR="${TGTC_STATE_DIR:-$INSTALL_ROOT/.tgtc-ops}"
LOCK_FILE="$STATE_DIR/operation.lock"

log() { printf '[tgtc-ops] %s\n' "$*" >&2; }
die() { local code=$1; shift; log "ERROR: $*"; exit "$code"; }
require_linux() { [[ "$(uname -s)" == Linux ]] || die "$EXIT_PRECHECK" '仅支持 Linux；拒绝在其他平台操作。'; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "$EXIT_PRECHECK" "缺少必需命令：$1"; }
acquire_lock() {
  mkdir -p "$STATE_DIR"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "$EXIT_OPERATION" '已有运维操作正在执行。'
}
record_state() { mkdir -p "$STATE_DIR"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATE_DIR/history.log"; }
valid_version() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; }
read_version() { local file=$1 value; [[ -f "$file" ]] || die "$EXIT_VERIFY" "缺少 VERSION：$file"; value=$(tr -d '\r\n' < "$file"); valid_version "$value" || die "$EXIT_VERIFY" 'VERSION 不是有效 SemVer。'; printf '%s' "$value"; }
api_get() { local endpoint=$1; require_cmd curl; curl --fail --silent --show-error --max-time "${TGTC_HTTP_TIMEOUT:-5}" "${TGTC_API_URL:-http://127.0.0.1:3000}/api/$endpoint"; }
