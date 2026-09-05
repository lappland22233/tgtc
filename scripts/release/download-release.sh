#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# 受限下载：仅 HTTPS + 主机白名单；限制重定向次数、总时长与文件大小；
# 先落 .part 临时文件，完整后才原子改名为目标文件，绝不留下部分下载的正式制品。
#
# Usage: download-release.sh URL DEST MAX_BYTES
[[ $# -eq 3 ]] || die "$EXIT_USAGE" "用法：$0 URL DEST MAX_BYTES"
URL=$1; DEST=$2; MAX_BYTES=$3
require_cmd curl
require_cmd stat
[[ "$MAX_BYTES" =~ ^[0-9]+$ && "$MAX_BYTES" -gt 0 ]] || die "$EXIT_USAGE" 'MAX_BYTES 必须是正整数。'

ALLOWED_HOSTS_RE='^(github\.com|objects\.githubusercontent\.com)$'
HOST=$(printf '%s' "$URL" | sed -n 's|^https://\([^/?#]*\)/.*|\1|p')
[[ -n "$HOST" ]] || die "$EXIT_USAGE" 'URL 必须是合法 HTTPS 地址。'
[[ "$HOST" =~ $ALLOWED_HOSTS_RE ]] || die "$EXIT_PRECHECK" "下载主机不在允许名单：拒绝。"
[[ "$URL" == https://* ]] || die "$EXIT_PRECHECK" '仅允许 HTTPS 下载。'

DEST_DIR=$(cd "$(dirname "$DEST")" && pwd -P)
DEST="$DEST_DIR/$(basename "$DEST")"
[[ "$(basename "$DEST")" != *.part ]] || die "$EXIT_USAGE" '目标文件名不允许 .part 后缀。'
[[ ! -L "$DEST" && ! -e "$DEST" ]] || die "$EXIT_PRECHECK" "目标文件已存在：$DEST"

PART="$DEST.part"
rm -f -- "$PART"
# shellcheck disable=SC2086
curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 3 \
  --max-time "${TGTC_DOWNLOAD_TIMEOUT:-1800}" --max-filesize "$MAX_BYTES" \
  --location "$URL" --output "$PART" \
  || { rm -f -- "$PART"; die "$EXIT_OPERATION" '下载失败（超时、超限或网络错误）。'; }
ACTUAL_SIZE=$(stat -c '%s' "$PART")
(( ACTUAL_SIZE <= MAX_BYTES )) || { rm -f -- "$PART"; die "$EXIT_VERIFY" '下载数据超过大小上限。'; }
mv -f -- "$PART" "$DEST"
log "OK: 已下载 $(basename "$DEST")（$ACTUAL_SIZE 字节）。"
