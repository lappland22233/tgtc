#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# 使用 RSA 私钥对 SHA256SUMS 签名（openssl dgst -sha256），并立即用内置公钥自检。
# 私钥只应存在于 CI secret 或发布操作者的安全介质；仓库与发行包只携带公钥。
# 签名失败或自检不过时丢弃签名文件，绝不留下无效 SHA256SUMS.sig。
#
# Usage: sign-release.sh /absolute/path/to/SHA256SUMS [/absolute/path/to/private-key.pem]
[[ $# -ge 1 && $# -le 2 ]] || die "$EXIT_USAGE" "用法：$0 SHA256SUMS [PRIVATE_KEY.pem]"
SUMS=$1
[[ -f "$SUMS" ]] || die "$EXIT_PRECHECK" "待签名文件不存在：$SUMS"
KEY=${2:-${RELEASE_SIGNING_KEY_PATH:-}}
[[ -n "$KEY" ]] || die "$EXIT_USAGE" '缺少签名私钥：传入私钥路径或设置 RELEASE_SIGNING_KEY_PATH。'
[[ -f "$KEY" ]] || die "$EXIT_PRECHECK" "签名私钥不存在：$KEY"
require_cmd openssl
PUB="$RELEASE_ROOT/scripts/release/update-public-key.pem"
[[ -f "$PUB" ]] || die "$EXIT_PRECHECK" "缺少内置验证公钥：$PUB"
SUMS_DIR=$(cd "$(dirname "$SUMS")" && pwd -P)
SUMS="$SUMS_DIR/$(basename "$SUMS")"
SIG="$SUMS.sig"
rm -f "$SIG"
openssl dgst -sha256 -sign "$KEY" -out "$SIG" "$SUMS"
if ! openssl dgst -sha256 -verify "$PUB" -signature "$SIG" "$SUMS" >/dev/null 2>&1; then
  rm -f "$SIG"
  die "$EXIT_VERIFY" '签名未通过内置公钥自检；已丢弃签名文件。'
fi
log "OK: SHA256SUMS 签名完成并通过公钥自检。"
