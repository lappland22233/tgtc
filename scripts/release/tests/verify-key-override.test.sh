#!/usr/bin/env bash
# B3 回归测试：验签公钥替换开关（common.sh#resolve_verify_public_key）。
# 该开关是安全敏感的信任根入口，必须锁定两件事：
#   1) 未设置时严格回落到仓库内置公钥（默认行为与历史完全一致）；
#   2) GITHUB_REF_TYPE=tag 时硬拒绝覆盖，防止正式发布的信任根被替换。
# 纯函数级测试，不依赖 systemd/root；由 quality-gates 的 release-scripts job 执行。
set -Eeuo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$TEST_DIR/../common.sh"

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

# 在子 shell 内应用若干 VAR=value 前缀后调用函数，输出 "退出码|stdout"。
# 不得使用 `env VAR=1 <shell 函数>`——env 是外部程序，无法执行 shell 函数（返回 127）。
run_fn() {
  local code=0 out=''
  set +e
  out=$( while [[ "${1:-}" == *=* ]]; do export "${1?}"; shift; done; "$@" 2>/dev/null )
  code=$?
  set -e
  printf '%s|%s' "$code" "$out"
}

DEFAULT_KEY="$RELEASE_ROOT/scripts/release/update-public-key.pem"
printf 'dummy-public-key\n' > "$TMP/other.pem"

check '未设置覆盖 → 仓库内置公钥' "0|$DEFAULT_KEY" "$(run_fn resolve_verify_public_key)"
check '显式覆盖（非 tag）→ 覆盖路径生效' "0|$TMP/other.pem" \
  "$(run_fn "RELEASE_VERIFY_PUBLIC_KEY=$TMP/other.pem" resolve_verify_public_key)"
check 'tag 路径 → 拒绝覆盖（EXIT_PRECHECK=3）' '3|' \
  "$(run_fn "RELEASE_VERIFY_PUBLIC_KEY=$TMP/other.pem" 'GITHUB_REF_TYPE=tag' resolve_verify_public_key)"
check '覆盖文件不存在 → 拒绝（EXIT_PRECHECK=3）' '3|' \
  "$(run_fn "RELEASE_VERIFY_PUBLIC_KEY=$TMP/missing.pem" resolve_verify_public_key)"

if [[ "$failed" == 1 ]]; then
  printf 'FAILED: 验签公钥替换测试存在失败用例（通过 %d / 共 %d）。\n' "$passed" "$total" >&2
  exit 1
fi
printf 'OK: 验签公钥替换测试全部通过（%d 个用例）。\n' "$passed"
