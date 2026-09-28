#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 下载端点部署自检（Nginx/代理 + 断点续传契约 + 磁盘余量）
#
# 背景：4GiB 分卷下载事件暴露了三类只能靠部署侧保证的问题：
#   1) 代理缓冲/缓存/临时文件把每个大文件又复制一份（隐藏占用约 3G）；
#   2) Range / If-Range / 206 契约被代理破坏，断点续传事实上不可用；
#   3) 各层超时未对齐（外层先断开 → 后端只能看到无原因中断）。
#
# 本脚本做静态配置校验 + 真实 HTTP 探针 + 磁盘余量检查，任何一项失败即退出非零。
# 生产 Nginx 配置不在本仓库内，因此本脚本是「部署验收」的执行入口。
#
# 用法：
#   bash scripts/release/check-download-proxy.sh
#   TGTC_TEST_DOWNLOAD_URL='https://站点/api/bot-dl/<token>' \
#   TGTC_DISK_PATHS='/opt/tgtc/runtime/backend/tmp:/opt/tgtc/runtime/telegram-bot-api/data:/var/lib/nginx/tmp' \
#     bash scripts/release/check-download-proxy.sh
#
# 可用环境变量：
#   TGTC_TEST_DOWNLOAD_URL  真实可下载 URL（用于 HTTP 契约探针；未设置则跳过该项并提示）
#   TGTC_NGINX_CONF         nginx 配置文本文件（默认尝试 `nginx -T`；两者都不可用则跳过静态校验）
#   TGTC_NGINX_BIN          nginx 可执行文件（默认 nginx）
#   TGTC_CURL_BIN           curl 可执行文件（默认 curl）
#   TGTC_DISK_PATHS         冒号分隔的目录列表（缓存卷 / workdir / 代理临时卷）
#   TGTC_MIN_FREE_GB        每个磁盘路径的最低空闲阈值（默认 5）
#   TGTC_SKIP_HTTP=1        跳过 HTTP 探针（离线环境）
#   TGTC_SOURCE_ONLY=1      仅加载函数（供回归测试使用，不执行 main）
#
# 退出码：0 全部通过；1 存在校验失败；3 前置条件缺失（缺 curl 等）
# ---------------------------------------------------------------------------
set -Eeuo pipefail

EXIT_PRECHECK=3

NGINX_BIN="${TGTC_NGINX_BIN:-nginx}"
CURL_BIN="${TGTC_CURL_BIN:-curl}"
MIN_FREE_GB="${TGTC_MIN_FREE_GB:-5}"

info() { printf '[信息] %s\n' "$*"; }
ok() { printf '[通过] %s\n' "$*"; }
bad() { printf '[失败] %s\n' "$*" >&2; }
warn() { printf '[注意] %s\n' "$*" >&2; }

FAILED=0
SKIPPED=0
mark_failed() { FAILED=1; bad "$1"; }

# ---------------------------------------------------------------------------
# 纯函数区（可被回归测试直接调用，不依赖 nginx/curl）
# ---------------------------------------------------------------------------

# 校验 Nginx 配置文本中下载端点相关指令。
# 输出缺失/违规项（每行一条）；返回 0 表示全部满足。
verify_nginx_text() {
  local text=$1
  local problems=''

  # 只截取 /api/bot-dl/ 所在 location 块，避免被其它 location 的同名指令误判为通过。
  # 用 index() 而非正则做定位：location 行含 `^~` 与 `/`，不同 awk 实现对转义的处理不一致。
  local block
  block=$(printf '%s\n' "$text" | awk '
    index($0, "location") > 0 && index($0, "/api/bot-dl/") > 0 { inside = 1 }
    inside { print }
    inside && substr($0, 1, 1) == "}" { exit }
  ')
  if [[ -z "$block" ]]; then
    problems+='/api/bot-dl/ location 块未找到'$'\n'
    printf '%s' "$problems"
    return 1
  fi

  # 先剥离注释行：配置模板的说明文字里会提到被禁止的写法，
  # 若在原文上匹配会把「注释里提到」误判成「实际写死了」。
  local directives
  directives=$(printf '%s\n' "$block" | sed 's/#.*//')

  printf '%s\n' "$directives" | grep -Eq 'proxy_buffering[[:space:]]+off' \
    || problems+='/api/bot-dl/ 缺少 proxy_buffering off（响应会落盘/占内存）'$'\n'
  printf '%s\n' "$directives" | grep -Eq 'proxy_max_temp_file_size[[:space:]]+0' \
    || problems+='/api/bot-dl/ 缺少 proxy_max_temp_file_size 0（完整响应可能落临时文件）'$'\n'
  # 注意：`proxy_cache off` 是期望值，只有「启用了某个缓存区」才算违规
  local enabled_cache
  enabled_cache=$(printf '%s\n' "$directives" \
    | grep -Eo 'proxy_cache[[:space:]]+[^;]+' \
    | grep -Ev '^proxy_cache[[:space:]]*off' || true)
  if [[ -n "$enabled_cache" ]]; then
    problems+="/api/bot-dl/ 启用了 proxy_cache（大文件下载必须关闭缓存）：${enabled_cache}"$'\n'
  fi
  # 读超时必须大于后端 Node 空闲超时（默认 180s）
  local read_timeout
  read_timeout=$(printf '%s\n' "$directives" | grep -Eo 'proxy_read_timeout[[:space:]]+[0-9]+' | grep -Eo '[0-9]+' | head -n1 || true)
  if [[ -z "$read_timeout" ]]; then
    problems+='/api/bot-dl/ 未显式配置 proxy_read_timeout（无法保证大于后端空闲超时）'$'\n'
  elif (( read_timeout < 200 )); then
    problems+="/api/bot-dl/ proxy_read_timeout=${read_timeout}s 过小（应 >= 200s，且不得设置固定总时长）"$'\n'
  fi
  if printf '%s\n' "$directives" | grep -Eq 'proxy_set_header[[:space:]]+Range[[:space:]]+""'; then
    problems+='/api/bot-dl/ 显式清空了 Range 请求头（会破坏断点续传）'$'\n'
  fi

  printf '%s' "$problems"
  [[ -z "$problems" ]]
}

# 校验真实响应头：Range 请求必须返回 206 + Content-Range + Accept-Ranges + ETag。
# 入参为 `curl -D -` 风格的原始响应头文本（可含多个响应块，取最后一个）。
verify_probe_headers() {
  local headers=$1
  local problems=''

  local status
  status=$(printf '%s\n' "$headers" | grep -Eo '^HTTP/[0-9.]+[[:space:]]+[0-9]{3}' | tail -n1 | grep -Eo '[0-9]{3}$' || true)
  if [[ -z "$status" ]]; then
    problems+='未解析到 HTTP 状态行'$'\n'
  elif [[ "$status" != '206' ]]; then
    problems+="Range 请求返回 ${status} 而非 206（断点续传不可用）"$'\n'
  fi
  printf '%s\n' "$headers" | grep -Eqi '^content-range:[[:space:]]*bytes ' \
    || problems+='缺少 Content-Range 响应头'$'\n'
  printf '%s\n' "$headers" | grep -Eqi '^accept-ranges:[[:space:]]*bytes' \
    || problems+='缺少 Accept-Ranges: bytes 响应头'$'\n'
  printf '%s\n' "$headers" | grep -Eqi '^etag:[[:space:]]*"' \
    || problems+='缺少强 ETag 响应头（客户端无法校验续传版本）'$'\n'

  printf '%s' "$problems"
  [[ -z "$problems" ]]
}

# 校验 If-Range 不匹配时必须忽略 Range 并返回完整 200（不得返回 206）。
verify_probe_if_range_mismatch() {
  local headers=$1
  local status
  status=$(printf '%s\n' "$headers" | grep -Eo '^HTTP/[0-9.]+[[:space:]]+[0-9]{3}' | tail -n1 | grep -Eo '[0-9]{3}$' || true)
  if [[ "$status" == '206' ]]; then
    printf '%s\n' 'If-Range 不匹配时仍返回 206（可能把不同版本的分段拼成损坏文件）'
    return 1
  fi
  if [[ "$status" != '200' ]]; then
    printf 'If-Range 不匹配时返回 %s（期望完整 200）\n' "${status:-未知}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 检查项
# ---------------------------------------------------------------------------

check_nginx_config() {
  local text='' source=''
  if [[ -n "${TGTC_NGINX_CONF:-}" ]]; then
    if [[ ! -r "$TGTC_NGINX_CONF" ]]; then
      warn "TGTC_NGINX_CONF 不可读：$TGTC_NGINX_CONF（跳过静态校验）"
      SKIPPED=$((SKIPPED + 1))
      return 0
    fi
    text=$(cat "$TGTC_NGINX_CONF")
    source="$TGTC_NGINX_CONF"
  elif command -v "$NGINX_BIN" >/dev/null 2>&1; then
    text=$("$NGINX_BIN" -T 2>/dev/null || true)
    source="$NGINX_BIN -T"
  fi

  if [[ -z "$text" ]]; then
    warn '未找到可读的 Nginx 配置（设置 TGTC_NGINX_CONF 或确保 nginx -T 可用）；跳过静态校验'
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  local problems
  if problems=$(verify_nginx_text "$text"); then
    ok "Nginx 下载端点配置校验通过（来源：$source）"
  else
    mark_failed "Nginx 下载端点配置不满足直通要求（来源：$source）："
    printf '%s' "$problems" | sed '/^$/d' | sed 's/^/       - /' >&2
  fi
}

check_http_contract() {
  if [[ "${TGTC_SKIP_HTTP:-}" == '1' ]]; then
    info 'TGTC_SKIP_HTTP=1：跳过 HTTP 契约探针'
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  if [[ -z "${TGTC_TEST_DOWNLOAD_URL:-}" ]]; then
    warn '未设置 TGTC_TEST_DOWNLOAD_URL：跳过 HTTP 契约探针（建议用真实 bot-dl 或分享直链复测 206/ETag）'
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  if ! command -v "$CURL_BIN" >/dev/null 2>&1; then
    bad '未找到 curl，无法执行 HTTP 契约探针'
    exit "$EXIT_PRECHECK"
  fi

  # 1) 单区间 Range：必须 206 + Content-Range + Accept-Ranges + 强 ETag
  local headers body_size
  headers=$("$CURL_BIN" -sS -o /dev/null -D - -H 'Range: bytes=0-0' "$TGTC_TEST_DOWNLOAD_URL" || true)
  if [[ -z "$headers" ]]; then
    mark_failed "Range 探针无响应：$TGTC_TEST_DOWNLOAD_URL"
    return 0
  fi
  local problems
  if problems=$(verify_probe_headers "$headers"); then
    ok 'Range 探针通过：206 + Content-Range + Accept-Ranges + ETag'
  else
    mark_failed 'Range 探针未满足断点续传契约：'
    printf '%s' "$problems" | sed '/^$/d' | sed 's/^/       - /' >&2
  fi

  # 2) 实际取回 1 字节，确认分段长度正确（避免代理把 206 当整体响应转成 200）
  body_size=$("$CURL_BIN" -sS -o /dev/null -w '%{size_download}' -H 'Range: bytes=0-0' "$TGTC_TEST_DOWNLOAD_URL" || echo '')
  if [[ "$body_size" == '1' ]]; then
    ok 'Range 分段体长度正确（1 字节）'
  else
    mark_failed "Range 分段体长度为 ${body_size:-未知} 字节（期望 1）"
  fi

  # 3) If-Range 不匹配：必须忽略 Range，返回完整 200
  headers=$("$CURL_BIN" -sS -o /dev/null -D - \
    -H 'Range: bytes=0-0' -H 'If-Range: "tgtc-stale-version"' "$TGTC_TEST_DOWNLOAD_URL" || true)
  local mismatch
  if mismatch=$(verify_probe_if_range_mismatch "$headers"); then
    ok 'If-Range 不匹配时回完整 200'
  else
    mark_failed "If-Range 语义不符合 RFC 7233：${mismatch}"
  fi
}

check_disk_headroom() {
  if [[ -z "${TGTC_DISK_PATHS:-}" ]]; then
    warn '未设置 TGTC_DISK_PATHS：跳过磁盘余量检查（建议覆盖后端 tmp/Cache、Bot API workdir/tmp 与代理临时卷）'
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  local path free_gb
  IFS=':' read -r -a _paths <<< "$TGTC_DISK_PATHS"
  for path in "${_paths[@]}"; do
    [[ -n "$path" ]] || continue
    if [[ ! -d "$path" ]]; then
      warn "目录不存在，跳过：$path"
      continue
    fi
    free_gb=$(df -Pk "$path" 2>/dev/null | awk 'NR==2 { printf "%.2f", $4/1048576 }')
    if [[ -z "$free_gb" ]]; then
      mark_failed "无法读取磁盘余量：$path"
      continue
    fi
    if awk -v f="$free_gb" -v min="$MIN_FREE_GB" 'BEGIN { exit !(f < min) }'; then
      mark_failed "磁盘余量不足：$path 空闲 ${free_gb}GB < 阈值 ${MIN_FREE_GB}GB"
    else
      ok "磁盘余量充足：$path 空闲 ${free_gb}GB（阈值 ${MIN_FREE_GB}GB）"
    fi
  done
}

main() {
  info '下载端点部署自检开始（代理直通 / 断点续传契约 / 磁盘余量）'
  check_nginx_config
  check_http_contract
  check_disk_headroom

  if [[ "$FAILED" == 1 ]]; then
    printf '\n[结果] 自检失败：请按上方条目修正后重跑。\n' >&2
    exit 1
  fi
  printf '\n[结果] 自检通过（跳过 %d 项）。\n' "$SKIPPED"
}

if [[ "${TGTC_SOURCE_ONLY:-}" != '1' ]]; then
  main "$@"
fi
