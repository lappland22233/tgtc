#!/usr/bin/env bash
# M4 回归测试：发布清单程序回退安全标志的解析与回滚安全门。
# 纯函数级测试，不依赖 systemd/root；由 quality-gates 的 release-scripts job 执行。
set -Eeuo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$TEST_DIR/../common.sh"

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
REL="$TMP/rel"; TARGET="$TMP/target"
mkdir -p "$REL" "$TARGET"

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

# ---- release_rollback_safe_flag：缺失/合法/非法/符号链接均 fail-closed ----
check 'manifest 缺失 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
printf '%s\n' '{"programRollbackSafe": true}' > "$REL/release-manifest.json"
check 'programRollbackSafe=true → true' true "$(release_rollback_safe_flag "$REL")"
printf '%s\n' '{"programRollbackSafe":false}' > "$REL/release-manifest.json"
check 'programRollbackSafe=false → false' false "$(release_rollback_safe_flag "$REL")"
# 锁定 grep -oE 对字段名与冒号之间空白的容忍度（机器生成清单带缩进）。
printf '%s\n' '{ "programRollbackSafe" :  true , "version": "1.1.0" }' > "$REL/release-manifest.json"
check '字段与冒号间含空白 → true' true "$(release_rollback_safe_flag "$REL")"
printf '%s\n' '{"version": "1.1.0"}' > "$REL/release-manifest.json"
check '清单存在但无该字段 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
printf '%s\n' '{"programRollbackSafe": "yes"}' > "$REL/release-manifest.json"
check '非布尔值 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
printf '%s\n' 'not-json-at-all' > "$REL/release-manifest.json"
check '非 JSON 内容 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
rm -f "$REL/release-manifest.json"; ln -s /dev/null "$REL/release-manifest.json"
check '符号链接清单 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
rm -f "$REL/release-manifest.json"

# ---- require_rollback_safe：安全门退出码与显式放行 ----
# 注意：不得使用 `env VAR=1 <shell 函数>`——env 是外部程序，无法执行 shell 函数，
# 会返回 127 而不是函数退出码（本测试曾在 CI 因此误红）。改为在子 shell 内 export 前缀。
run_gate() {
  local code=0
  set +e
  ( if [[ "${1:-}" == *=* ]]; then export "${1?}"; shift; fi; "$@" ) >/dev/null 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}

printf '%s\n' '{"programRollbackSafe": false}' > "$REL/release-manifest.json"
check 'false → 拒绝（EXIT_PRECHECK=3）' 3 "$(run_gate require_rollback_safe "$REL" "$TARGET" 1.1.0)"
check 'false + TGTC_ACK_DB_RESTORED=1 → 放行' 0 \
  "$(run_gate TGTC_ACK_DB_RESTORED=1 require_rollback_safe "$REL" "$TARGET" 1.1.0)"

rm -f "$REL/release-manifest.json"
check '清单缺失 → 拒绝（EXIT_PRECHECK=3）' 3 "$(run_gate require_rollback_safe "$REL" "$TARGET" 1.1.0)"

printf '%s\n' '{"programRollbackSafe": true}' > "$REL/release-manifest.json"
check 'true → 放行' 0 "$(run_gate require_rollback_safe "$REL" "$TARGET" 1.1.0)"

if [[ "$failed" == 1 ]]; then
  printf 'FAILED: 回滚安全标志测试存在失败用例（通过 %d / 共 %d）。\n' \
    "$passed" "$total" >&2
  exit 1
fi
printf 'OK: 回滚安全标志测试全部通过（%d 个用例）。\n' "$passed"
