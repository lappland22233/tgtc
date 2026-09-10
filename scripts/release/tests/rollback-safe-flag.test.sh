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
check() {
  local label=$1 expected=$2 actual=$3
  if [[ "$actual" == "$expected" ]]; then
    printf 'ok   %s\n' "$label"
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
printf '%s\n' '{"programRollbackSafe": "yes"}' > "$REL/release-manifest.json"
check '非布尔值 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
printf '%s\n' 'not-json-at-all' > "$REL/release-manifest.json"
check '非 JSON 内容 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
rm -f "$REL/release-manifest.json"; ln -s /dev/null "$REL/release-manifest.json"
check '符号链接清单 → unknown' unknown "$(release_rollback_safe_flag "$REL")"
rm -f "$REL/release-manifest.json"

# ---- require_rollback_safe：安全门退出码与显式放行 ----
run_gate() {
  local code=0
  set +e
  ( "$@" ) >/dev/null 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}

printf '%s\n' '{"programRollbackSafe": false}' > "$REL/release-manifest.json"
check 'false → 拒绝（EXIT_PRECHECK=3）' 3 "$(run_gate require_rollback_safe "$REL" "$TARGET" 1.1.0)"
check 'false + TGTC_ACK_DB_RESTORED=1 → 放行' 0 \
  "$(run_gate env TGTC_ACK_DB_RESTORED=1 require_rollback_safe "$REL" "$TARGET" 1.1.0)"

rm -f "$REL/release-manifest.json"
check '清单缺失 → 拒绝（EXIT_PRECHECK=3）' 3 "$(run_gate require_rollback_safe "$REL" "$TARGET" 1.1.0)"

printf '%s\n' '{"programRollbackSafe": true}' > "$REL/release-manifest.json"
check 'true → 放行' 0 "$(run_gate require_rollback_safe "$REL" "$TARGET" 1.1.0)"

if [[ "$failed" == 1 ]]; then
  printf 'FAILED: 回滚安全标志测试存在失败用例。\n' >&2
  exit 1
fi
printf 'OK: 回滚安全标志测试全部通过。\n'
