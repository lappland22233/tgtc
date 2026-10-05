#!/usr/bin/env bash
#
# upload-files.sh —— 批量上传指定目录下的所有文件（API Key 认证，失败自动重试）
#
# 行为：
#   * 逐个文件调用 POST /api/files/upload（multipart 字段名 file，见 docs/API.md）
#   * 单个文件上传失败后等待 60 秒自动重试，单文件最多尝试 3 次（首次 + 2 次重试）
#   * 单个文件最终失败不会中断整体流程；结束时输出汇总，有失败文件时退出码为 1
#
# 用法：
#   TGTC_API_KEY=tgtc_xxx ./upload-files.sh /path/to/dir
#   ./upload-files.sh /path/to/dir -k tgtc_xxx -u https://your-domain.example -r
#
# 参数：
#   <目录>                 必填，要上传的本地目录
#   -u, --url <地址>        服务地址，默认 http://127.0.0.1:3000
#   -k, --key <密钥>        API 密钥（网页端 个人设置 → API 密钥）
#   -r, --recursive         递归上传子目录中的文件（默认只上传目录第一层）
#       --retry-delay <秒>  失败后重试等待秒数，默认 60
#       --max-attempts <次> 单文件最大尝试次数，默认 3
#   -h, --help              显示帮助
#
# 环境变量（同名命令行参数优先）：
#   TGTC_BASE_URL、TGTC_API_KEY、TGTC_RETRY_DELAY、TGTC_MAX_ATTEMPTS、TGTC_RECURSIVE
#
# 退出码：0 = 全部上传成功；1 = 存在失败文件；2 = 参数或环境错误

set -u

BASE_URL="${TGTC_BASE_URL:-http://127.0.0.1:3000}"
API_KEY="${TGTC_API_KEY:-}"
RETRY_DELAY="${TGTC_RETRY_DELAY:-60}"
MAX_ATTEMPTS="${TGTC_MAX_ATTEMPTS:-3}"
RECURSIVE="${TGTC_RECURSIVE:-0}"
TARGET_DIR=""

UPLOAD_PATH="/api/files/upload"

usage() {
  cat <<'EOF'
用法: ./upload-files.sh <目录> [选项]

选项:
  -u, --url <地址>         服务地址，默认 http://127.0.0.1:3000
  -k, --key <密钥>         API 密钥（或用环境变量 TGTC_API_KEY）
  -r, --recursive          递归上传子目录中的文件
      --retry-delay <秒>   失败后重试等待秒数，默认 60
      --max-attempts <次>  单文件最大尝试次数，默认 3
  -h, --help               显示本帮助

示例:
  TGTC_API_KEY=tgtc_xxx ./upload-files.sh /data/backup -u https://example.com -r
EOF
}

die() {
  echo "错误: $*" >&2
  exit 2
}

# 从响应体里提取 message 字段（拿不到就回显原始响应前 200 字符）
extract_message() {
  local file="$1" msg=""
  [ -f "$file" ] || return 0
  msg="$(sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1)"
  if [ -z "$msg" ]; then
    msg="$(tr -d '\r\n' <"$file" | cut -c1-200)"
  fi
  printf '%s' "$msg"
}

# 单个文件上传（内部自带重试），成功返回 0，重试耗尽返回 1
upload_with_retry() {
  local file="$1"
  local attempt=1
  local body_file="$TMP_DIR/body.json"
  local err_file="$TMP_DIR/curl.err"
  local http_code reason curl_err

  while :; do
    http_code="$(curl -sS -X POST "$BASE_URL$UPLOAD_PATH" \
        -H "X-API-Key: $API_KEY" \
        -H "Accept: application/json" \
        -F "file=@\"$file\"" \
        -o "$body_file" -w '%{http_code}' 2>"$err_file")" || true
    http_code="${http_code:-000}"

    # 成功判据：HTTP 2xx 且响应体 code 为 0
    if [ "${http_code#2}" != "$http_code" ] &&
       grep -Eq '"code"[[:space:]]*:[[:space:]]*0[,}]' "$body_file" 2>/dev/null; then
      printf '    成功 (HTTP %s)\n' "$http_code"
      return 0
    fi

    reason="$(extract_message "$body_file")"
    curl_err="$(tr -d '\r' <"$err_file" 2>/dev/null | head -n 1)"
    printf '    第 %d/%d 次尝试失败: HTTP %s' "$attempt" "$MAX_ATTEMPTS" "$http_code"
    [ -n "$reason" ] && printf ' %s' "$reason"
    printf '\n'
    [ -n "$curl_err" ] && printf '    curl: %s\n' "$curl_err"

    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      printf '    已达最大尝试次数 %s 次，放弃该文件\n' "$MAX_ATTEMPTS"
      return 1
    fi

    attempt=$((attempt + 1))
    printf '    等待 %s 秒后重试（第 %d/%d 次尝试）...\n' "$RETRY_DELAY" "$attempt" "$MAX_ATTEMPTS"
    sleep "$RETRY_DELAY"
  done
}

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    -u | --url)
      [ $# -ge 2 ] || die "选项 $1 缺少参数"
      BASE_URL="$2"
      shift 2
      ;;
    -k | --key)
      [ $# -ge 2 ] || die "选项 $1 缺少参数"
      API_KEY="$2"
      shift 2
      ;;
    -r | --recursive)
      RECURSIVE=1
      shift
      ;;
    --retry-delay)
      [ $# -ge 2 ] || die "选项 $1 缺少参数"
      RETRY_DELAY="$2"
      shift 2
      ;;
    --max-attempts)
      [ $# -ge 2 ] || die "选项 $1 缺少参数"
      MAX_ATTEMPTS="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      usage >&2
      die "未知选项: $1"
      ;;
    *)
      [ -z "$TARGET_DIR" ] || die "只能指定一个目录，多余参数: $1"
      TARGET_DIR="$1"
      shift
      ;;
  esac
done

# ---------- 参数校验 ----------
[ -n "$API_KEY" ] || die "未提供 API 密钥，请用 -k 或环境变量 TGTC_API_KEY 指定"
[ -n "$TARGET_DIR" ] || {
  usage >&2
  die "未指定要上传的目录"
}
[ -d "$TARGET_DIR" ] || die "目录不存在或不是目录: $TARGET_DIR"
case "$MAX_ATTEMPTS" in '' | *[!0-9]*) die "--max-attempts 必须是正整数，当前值: $MAX_ATTEMPTS" ;; esac
[ "$MAX_ATTEMPTS" -ge 1 ] || die "--max-attempts 必须大于等于 1"
case "$RETRY_DELAY" in '' | *[!0-9]*) die "--retry-delay 必须是非负整数，当前值: $RETRY_DELAY" ;; esac
command -v curl >/dev/null 2>&1 || die "未找到 curl 命令，请先安装 curl"
BASE_URL="${BASE_URL%/}"
case "$BASE_URL" in
  http://* | https://*) ;;
  *) die "服务地址必须以 http:// 或 https:// 开头: $BASE_URL" ;;
esac

# ---------- 准备 ----------
TMP_DIR="$(mktemp -d 2>/dev/null)" || die "无法创建临时目录"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

# 进入目标目录后只用相对路径：一来 -F 的文件名参数更干净，
# 二来 git-bash(MSYS) 会把含 ';' 的绝对 POSIX 路径当作路径列表改写，导致上传失败。
cd "$TARGET_DIR" || die "无法进入目录: $TARGET_DIR"

list_files() {
  if [ "$RECURSIVE" = "1" ]; then
    find . -type f -print0 2>/dev/null
  else
    find . -maxdepth 1 -type f -print0 2>/dev/null
  fi
}

files=()
while IFS= read -r -d '' f; do
  files+=("${f#./}")
done < <(list_files)

total=${#files[@]}

echo "服务地址: $BASE_URL$UPLOAD_PATH"
echo "上传目录: $TARGET_DIR"
if [ "$RECURSIVE" = "1" ]; then
  echo "范围: 含子目录    失败重试: 等待 ${RETRY_DELAY} 秒，单文件最多 ${MAX_ATTEMPTS} 次尝试"
else
  echo "范围: 仅第一层    失败重试: 等待 ${RETRY_DELAY} 秒，单文件最多 ${MAX_ATTEMPTS} 次尝试"
fi

if [ "$total" -eq 0 ]; then
  echo "目录中没有找到文件，无需上传。"
  exit 0
fi

echo "文件数量: $total"
echo "------------------------------------------------------------"

# ---------- 主流程 ----------
success_count=0
fail_count=0
failed_files=()
index=0

for f in "${files[@]}"; do
  index=$((index + 1))
  printf '[%d/%d] %s\n' "$index" "$total" "$f"
  if upload_with_retry "$f"; then
    success_count=$((success_count + 1))
  else
    fail_count=$((fail_count + 1))
    failed_files+=("$f")
  fi
done

# ---------- 汇总 ----------
echo "------------------------------------------------------------"
printf '总数: %d    成功: %d    失败: %d\n' "$total" "$success_count" "$fail_count"

if [ "$fail_count" -gt 0 ]; then
  echo "失败文件（重试 ${MAX_ATTEMPTS} 次后仍失败）:"
  for f in "${failed_files[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo "全部上传成功。"
exit 0
