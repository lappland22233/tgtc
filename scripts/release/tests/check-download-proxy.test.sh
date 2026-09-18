#!/usr/bin/env bash
# 回归测试：下载端点部署自检（check-download-proxy.sh）。
#
# 锁定三件事：
#   1) 静态配置校验能识别「缓冲未关 / 缓存开启 / 读超时过小 / 清空 Range」等违规；
#   2) 响应头契约判定正确（206 + Content-Range + Accept-Ranges + 强 ETag；If-Range 不匹配回 200）；
#   3) 端到端：合规输入退出 0，违规输入退出非零（避免自检脚本永远"通过"）。
#
# 仅依赖 bash/awk/grep，不依赖真实 nginx 与网络（用 TGTC_CURL_BIN 桩替代 curl）。
set -Eeuo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_DIR="$(dirname "$TEST_DIR")"
SCRIPT="$RELEASE_DIR/check-download-proxy.sh"
TEMPLATE="$RELEASE_DIR/nginx-download.conf.template"

[[ -r "$SCRIPT" ]] || { printf 'FAIL 找不到自检脚本: %s\n' "$SCRIPT" >&2; exit 1; }
[[ -r "$TEMPLATE" ]] || { printf 'FAIL 找不到 Nginx 模板: %s\n' "$TEMPLATE" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

failed=0
passed=0
total=0
check() {
  local label=$1 expected=$2 actual=$3
  total=$((total + 1))
  if [[ "$actual" == "$expected" ]]; then
    printf 'ok   %s\n' "$label"
    passed=$((passed + 1))
  else
    printf 'FAIL %s: expected=%s actual=%s\n' "$label" "$expected" "$actual" >&2
    failed=1
  fi
}

# 仅加载纯函数（不执行 main）
TGTC_SOURCE_ONLY=1 source "$SCRIPT"

# ---------------- 1) 静态配置校验 ----------------
TEMPLATE_CONF="$TMP/template.conf"
cp "$TEMPLATE" "$TEMPLATE_CONF"
# 模板中的占位符不影响指令校验
check '仓库模板通过配置校验' '0' "$(verify_nginx_text "$(cat "$TEMPLATE_CONF")" >/dev/null 2>&1; echo $?)"

NO_BUFFER="$TMP/no-buffer.conf"
grep -v 'proxy_buffering off' "$TEMPLATE_CONF" > "$NO_BUFFER"
check '缺少 proxy_buffering off → 判定失败' '1' "$(verify_nginx_text "$(cat "$NO_BUFFER")" >/dev/null 2>&1; echo $?)"

NO_TEMP_ZERO="$TMP/no-temp-zero.conf"
sed 's/proxy_max_temp_file_size 0/proxy_max_temp_file_size 1024m/' "$TEMPLATE_CONF" > "$NO_TEMP_ZERO"
check 'proxy_max_temp_file_size 非 0 → 判定失败' '1' "$(verify_nginx_text "$(cat "$NO_TEMP_ZERO")" >/dev/null 2>&1; echo $?)"

CACHE_ON="$TMP/cache-on.conf"
sed 's/proxy_cache off;/proxy_cache tgtc_zone;/' "$TEMPLATE_CONF" > "$CACHE_ON"
check '启用 proxy_cache → 判定失败' '1' "$(verify_nginx_text "$(cat "$CACHE_ON")" >/dev/null 2>&1; echo $?)"

SHORT_TIMEOUT="$TMP/short-timeout.conf"
sed 's/proxy_read_timeout 210s;/proxy_read_timeout 60s;/' "$TEMPLATE_CONF" > "$SHORT_TIMEOUT"
check 'proxy_read_timeout 过小 → 判定失败' '1' "$(verify_nginx_text "$(cat "$SHORT_TIMEOUT")" >/dev/null 2>&1; echo $?)"

STRIP_RANGE="$TMP/strip-range.conf"
awk '{ print } /proxy_buffering off;/ && !done { print "    proxy_set_header Range \"\";"; done=1 }' \
  "$TEMPLATE_CONF" > "$STRIP_RANGE"
check '显式清空 Range 请求头 → 判定失败' '1' "$(verify_nginx_text "$(cat "$STRIP_RANGE")" >/dev/null 2>&1; echo $?)"

# 报告内容必须指明缺失项（不能只返回非零而不说明）
NO_BUFFER_REPORT=$(verify_nginx_text "$(cat "$NO_BUFFER")" || true)
check '失败原因包含具体缺失项' '1' \
  "$(printf '%s' "$NO_BUFFER_REPORT" | grep -c 'proxy_buffering off' || true)"

# ---------------- 2) 响应头契约判定 ----------------
GOOD_HEADERS=$'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/100\r\nAccept-Ranges: bytes\r\nETag: "abc"\r\n'
NO_ETAG_HEADERS=$'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/100\r\nAccept-Ranges: bytes\r\n'
FULL_200_HEADERS=$'HTTP/1.1 200 OK\r\nETag: "abc"\r\n'
IF_RANGE_MISMATCH=$'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n'
IF_RANGE_206=$'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/100\r\n'

check '206 全套头 → 通过' '0' "$(verify_probe_headers "$GOOD_HEADERS" >/dev/null 2>&1; echo $?)"
check '缺 ETag → 失败' '1' "$(verify_probe_headers "$NO_ETAG_HEADERS" >/dev/null 2>&1; echo $?)"
check 'Range 被降级为 200 → 失败' '1' "$(verify_probe_headers "$FULL_200_HEADERS" >/dev/null 2>&1; echo $?)"
check 'If-Range 不匹配返回 200 → 通过' '0' "$(verify_probe_if_range_mismatch "$IF_RANGE_MISMATCH" >/dev/null 2>&1; echo $?)"
check 'If-Range 不匹配却返回 206 → 失败' '1' "$(verify_probe_if_range_mismatch "$IF_RANGE_206" >/dev/null 2>&1; echo $?)"

# ---------------- 3) 端到端（curl 桩） ----------------
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl-ok" <<'SH'
#!/usr/bin/env bash
# 桩：-w '%{size_download}' 时输出分段体长度；否则输出响应头。
want_size=0
mode=range
for arg in "$@"; do
  [[ "$arg" == *size_download* ]] && want_size=1
  [[ "$arg" == 'If-Range: '* ]] && mode=ifrange
done
if [[ "$want_size" == 1 ]]; then
  printf '1'
  exit 0
fi
if [[ "$mode" == ifrange ]]; then
  printf 'HTTP/1.1 200 OK\r\nETag: "abc"\r\nContent-Length: 100\r\n\r\n'
else
  printf 'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/100\r\nAccept-Ranges: bytes\r\nETag: "abc"\r\n\r\n'
fi
SH
cat > "$TMP/bin/curl-bad" <<'SH'
#!/usr/bin/env bash
# 桩：代理把 Range 降级为 200 且剥离 ETag（典型的"断点续传不可用"形态）
want_size=0
for arg in "$@"; do
  [[ "$arg" == *size_download* ]] && want_size=1
done
if [[ "$want_size" == 1 ]]; then
  printf '1'
  exit 0
fi
printf 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n'
SH
chmod +x "$TMP/bin/curl-ok" "$TMP/bin/curl-bad"

run_script() {
  local curl_bin=$1 conf=$2 code=0
  set +e
  TGTC_CURL_BIN="$curl_bin" \
  TGTC_NGINX_CONF="$conf" \
  TGTC_TEST_DOWNLOAD_URL='http://example.test/api/bot-dl/probe' \
  bash "$SCRIPT" >/dev/null 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}

check '端到端：合规配置 + 合规响应 → 退出 0' '0' "$(run_script "$TMP/bin/curl-ok" "$TEMPLATE_CONF")"
check '端到端：代理破坏 206 契约 → 退出非零' '1' "$(run_script "$TMP/bin/curl-bad" "$TEMPLATE_CONF")"
check '端到端：Nginx 配置违规 → 退出非零' '1' "$(run_script "$TMP/bin/curl-ok" "$NO_BUFFER")"
# 未设置 TGTC_TEST_DOWNLOAD_URL 时必须跳过而不是误报通过/失败
SKIP_CODE=$(set +e; TGTC_NGINX_CONF="$TEMPLATE_CONF" bash "$SCRIPT" >/dev/null 2>&1; echo $?)
check '端到端：缺少探测 URL → 跳过探针但整体通过' '0' "$SKIP_CODE"

if [[ "$failed" == 1 ]]; then
  printf 'FAILED: 下载端点自检测试存在失败用例（通过 %d / 共 %d）。\n' "$passed" "$total" >&2
  exit 1
fi
printf 'OK: 下载端点自检测试全部通过（%d 个用例）。\n' "$passed"
