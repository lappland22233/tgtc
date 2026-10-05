#!/usr/bin/env bash
# 版本守卫回归测试（scripts/release/check-version.sh）。
#
# 为什么必须锁死：VERSION 是全仓唯一的版本事实来源，四个包清单都必须与它一致，
# 且 **lockfile 有两处根包版本**（顶层 version 与 packages[""].version）。
# 事故形态：手工升版本只改 package.json 与 packages[""]、漏掉 lockfile 顶层
# （或反过来），不一致会一路带到打包与 validate-release.sh 才暴露；tag 守卫失效
# 则会让 `v1.6.2` 标签指向声称 1.6.1 的制品。
#
# 因此本测试在临时 fixture 仓库上锁定：全一致放行；任一清单/任一字段不一致、
# packages 根条目缺失、VERSION 非 SemVer 均拒绝；tag/CI_TAG 必须等于 v<VERSION>。
# 纯文件级测试，不触网、不依赖 systemd/root；由 release-scripts job 执行。
set -Eeuo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$TEST_DIR/../../.." && pwd -P)"

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE/backend" "$FIXTURE/frontend" "$FIXTURE/scripts/release"
cp "$ROOT_DIR/scripts/release/check-version.sh" "$FIXTURE/scripts/release/check-version.sh"

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

manifest_json() { # name version
  printf '{\n  "name": "%s",\n  "version": "%s"\n}\n' "$1" "$2"
}

lock_json() { # name top-level-version packages-root-version
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "%s",\n      "version": "%s"\n    }\n  }\n}\n' \
    "$1" "$2" "$1" "$3"
}

write_fixture() { # version
  local version=$1
  printf '%s\n' "$version" > "$FIXTURE/VERSION"
  manifest_json file-distribution-system-backend "$version" > "$FIXTURE/backend/package.json"
  lock_json file-distribution-system-backend "$version" "$version" > "$FIXTURE/backend/package-lock.json"
  manifest_json file-distribution-system-frontend "$version" > "$FIXTURE/frontend/package.json"
  lock_json file-distribution-system-frontend "$version" "$version" > "$FIXTURE/frontend/package-lock.json"
}

# 在 fixture 仓库上执行守卫；前缀 VAR=value 以环境变量注入（用于 tag 守卫用例）。
# 只比对退出码：0=放行，非 0=拒绝（node 缺失时放行用例会失败，不会静默通过）。
run_guard() {
  local code=0
  set +e
  ( while [[ "${1:-}" == *=* ]]; do export "${1?}"; shift; done; bash "$FIXTURE/scripts/release/check-version.sh" ) >/dev/null 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}

write_fixture 1.6.2
check '全部一致 → 放行' 0 "$(run_guard)"

# lockfile 顶层 version 半改：顶层残留旧版本，packages[""] 已是新版本。
lock_json file-distribution-system-backend 1.6.1 1.6.2 > "$FIXTURE/backend/package-lock.json"
check '后端 lockfile 顶层 version 不一致 → 拒绝' 1 "$(run_guard)"

# packages[""].version 半改：顶层已更新，根包条目残留旧版本。
lock_json file-distribution-system-backend 1.6.2 1.6.1 > "$FIXTURE/backend/package-lock.json"
check '后端 lockfile packages[""].version 不一致 → 拒绝' 1 "$(run_guard)"

# packages 根条目整体缺失：必须 fail-closed，不能因 undefined 静默通过。
printf '{\n  "name": "file-distribution-system-backend",\n  "version": "1.6.2",\n  "lockfileVersion": 3\n}\n' \
  > "$FIXTURE/backend/package-lock.json"
check '后端 lockfile 缺 packages 根条目 → 拒绝' 1 "$(run_guard)"

write_fixture 1.6.2
manifest_json file-distribution-system-frontend 1.6.1 > "$FIXTURE/frontend/package.json"
check '前端 package.json 版本不一致 → 拒绝' 1 "$(run_guard)"

write_fixture 1.6.2
printf '1.6\n' > "$FIXTURE/VERSION"
check 'VERSION 非 SemVer → 拒绝' 1 "$(run_guard)"

write_fixture 1.6.2
check 'tag 与 VERSION 匹配 → 放行' 0 "$(run_guard 'GITHUB_REF_TYPE=tag' 'GITHUB_REF_NAME=v1.6.2')"
check 'tag 与 VERSION 不匹配 → 拒绝' 1 "$(run_guard 'GITHUB_REF_TYPE=tag' 'GITHUB_REF_NAME=v1.6.3')"
check 'CI_TAG 与 VERSION 匹配 → 放行' 0 "$(run_guard 'CI_TAG=v1.6.2')"
check 'CI_TAG 与 VERSION 不匹配 → 拒绝' 1 "$(run_guard 'CI_TAG=v1.6.1')"

if [[ "$failed" == 1 ]]; then
  printf 'FAILED: 版本守卫测试存在失败用例（通过 %d / 共 %d）。\n' "$passed" "$total" >&2
  exit 1
fi
printf 'OK: 版本守卫测试全部通过（%d 个用例）。\n' "$passed"
