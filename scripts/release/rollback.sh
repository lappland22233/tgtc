#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Usage: rollback.sh [VERSION]. Without a version, selects the immediately previous release.
[[ $# -le 1 ]] || die "$EXIT_USAGE" "用法：$0 [VERSION]"
# INSTALL_ROOT 由 common.sh 统一解析（含 releases/ 布局特判），此处不得重算。
CURRENT_LINK="$INSTALL_ROOT/current"; SERVICE="${TGTC_SERVICE:-tgtc.service}"
require_linux; for command in systemctl flock; do require_cmd "$command"; done; acquire_lock
[[ -L "$CURRENT_LINK" ]] || die "$EXIT_PRECHECK" "current 不是符号链接：$CURRENT_LINK"
CURRENT=$(readlink -f "$CURRENT_LINK"); [[ -d "$CURRENT" ]] || die "$EXIT_PRECHECK" 'current 指向不存在的发行目录。'
if [[ $# -eq 1 ]]; then valid_version "$1" || die "$EXIT_USAGE" '版本必须为有效 SemVer。'; TARGET="$INSTALL_ROOT/releases/$1"; else mapfile -t releases < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -name '.*' -prune -o -type d -printf '%f\n' | sort -Vr); TARGET=''; for version in "${releases[@]}"; do [[ "$INSTALL_ROOT/releases/$version" != "$CURRENT" ]] && { TARGET="$INSTALL_ROOT/releases/$version"; break; }; done; fi
[[ -n "$TARGET" && -d "$TARGET" ]] || die "$EXIT_PRECHECK" '没有可用回退版本。'
assert_no_protected_payload "$TARGET"; VERSION=$(read_version "$TARGET/VERSION")
ln -s "$TARGET" "$INSTALL_ROOT/.current.rollback"; mv -Tf "$INSTALL_ROOT/.current.rollback" "$CURRENT_LINK"
# 与 upgrade.sh 相同的就绪等待窗口：restart 返回不代表应用已可服务。
wait_app_ready() {
  local attempts="${TGTC_READY_WAIT_ATTEMPTS:-15}"
  for _ in $(seq 1 "$attempts"); do
    api_get health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
systemctl restart "$SERVICE" || { ln -s "$CURRENT" "$INSTALL_ROOT/.current.restore" && mv -Tf "$INSTALL_ROOT/.current.restore" "$CURRENT_LINK"; systemctl restart "$SERVICE" || die "$EXIT_ROLLBACK" '回退失败且无法恢复原服务。'; die "$EXIT_ROLLBACK" '回退后服务重启失败，已恢复原版本。'; }
if ! wait_app_ready || ! TGTC_EXPECTED_VERSION="$VERSION" "$TARGET/scripts/release/health-check.sh"; then
  ln -s "$CURRENT" "$INSTALL_ROOT/.current.restore" && mv -Tf "$INSTALL_ROOT/.current.restore" "$CURRENT_LINK"
  systemctl restart "$SERVICE" || die "$EXIT_ROLLBACK" '回退失败且无法恢复原服务。'
  die "$EXIT_OPERATION" '回退健康检查失败，已恢复原版本。'
fi
record_state "rollback ok version=$VERSION previous=$(read_version "$CURRENT/VERSION")"
log "OK: 已原子回退至 $VERSION；未处理 Telegram 数据、数据库或 .env。"
