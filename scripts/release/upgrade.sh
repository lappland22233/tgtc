#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Usage: upgrade.sh /absolute/path/tgtc-vX.Y.Z-linux-x64.zip [/absolute/path/SHA256SUMS]
# Exit codes: 0 success; 2 usage; 3 precheck; 4 verification; 5 operation; 6 rollback failure.
[[ $# -ge 1 && $# -le 2 ]] || die "$EXIT_USAGE" "用法：$0 ARCHIVE [SHA256SUMS]"
ARCHIVE=$1
SUMS=${2:-"$(dirname "$ARCHIVE")/SHA256SUMS"}
# INSTALL_ROOT 由 common.sh 统一解析（含 releases/ 布局特判），此处不得重算。
CURRENT_LINK="$INSTALL_ROOT/current"
SERVICE="${TGTC_SERVICE:-tgtc.service}"
ENV_FILE="${TGTC_ENV_FILE:-$RUNTIME_DIR/backend/.env}"

# 任务模式（由 updater.sh 派发）通过 TGTC_PROGRESS_FILE 回写状态机阶段；
# 人工模式未设置该变量时静默跳过。
report_phase() {
  if [[ -n "${TGTC_PROGRESS_FILE:-}" ]]; then
    printf '%s\n' "$1" > "$TGTC_PROGRESS_FILE" 2>/dev/null || true
  fi
}

rollback_after_activation_failure() {
  local reason=$1
  [[ -n "$PREVIOUS" ]] || die "$EXIT_ROLLBACK" "$reason，且没有可回退版本。"
  report_phase rolling_back
  ln -s "$PREVIOUS" "$INSTALL_ROOT/.current.rollback"
  mv -Tf "$INSTALL_ROOT/.current.rollback" "$CURRENT_LINK"
  systemctl restart "$SERVICE" || die "$EXIT_ROLLBACK" "$reason，且回退后的服务也无法启动。"
  die "$EXIT_OPERATION" "$reason，已成功回退。"
}

run_target_migrations() {
  [[ -x "$TARGET/runtime/bin/node" ]] || die "$EXIT_VERIFY" "候选发行包缺少 Node.js：$TARGET/runtime/bin/node"
  [[ -f "$TARGET/backend/node_modules/typeorm/cli.js" ]] || die "$EXIT_VERIFY" '候选发行包缺少 TypeORM CLI。'
  [[ -f "$TARGET/backend/dist/database/data-source.js" ]] || die "$EXIT_VERIFY" '候选发行包缺少编译后的数据库数据源。'
  [[ -r "$ENV_FILE" ]] || die "$EXIT_PRECHECK" "无法读取迁移环境文件：$ENV_FILE"
  log "运行目标发行版 $NEW_VERSION 的数据库迁移。"
  (
    cd "$TARGET/backend"
    dotenv_config_path="$ENV_FILE" "$TARGET/runtime/bin/node" \
      -r "$TARGET/backend/node_modules/dotenv/config" \
      "$TARGET/backend/node_modules/typeorm/cli.js" migration:run \
      -d "$TARGET/backend/dist/database/data-source.js"
  ) || die "$EXIT_OPERATION" "目标发行版 $NEW_VERSION 的数据库迁移失败；未切换 current。"
}

require_linux
for command in unzip sha256sum systemctl flock; do require_cmd "$command"; done
acquire_lock
report_phase prechecking
[[ -d "$INSTALL_ROOT" ]] || die "$EXIT_PRECHECK" "安装根目录不存在：$INSTALL_ROOT"
# A service pinned to a concrete release cannot be atomically upgraded by moving current.
systemctl cat "$SERVICE" 2>/dev/null | grep -Fq "$CURRENT_LINK/" \
  || die "$EXIT_PRECHECK" "服务单元未使用 $CURRENT_LINK；拒绝非原子升级。请先迁移为 current 符号链接部署。"
bash "$SCRIPT_DIR/validate-release.sh" "$ARCHIVE" "$SUMS"

STAGE=$(mktemp -d "$INSTALL_ROOT/.tgtc-stage.XXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT
unzip -q "$ARCHIVE" -d "$STAGE"
mapfile -t candidates < <(find "$STAGE" -mindepth 1 -maxdepth 1 -type d)
[[ ${#candidates[@]} -eq 1 ]] || die "$EXIT_VERIFY" '归档必须恰有一个顶层目录。'
CANDIDATE=${candidates[0]}
assert_no_protected_payload "$CANDIDATE"
NEW_VERSION=$(read_version "$CANDIDATE/VERSION")
TARGET="$INSTALL_ROOT/releases/$NEW_VERSION"
[[ ! -e "$TARGET" ]] || die "$EXIT_PRECHECK" "目标版本已存在，拒绝覆盖：$TARGET"
PREVIOUS=''
[[ -L "$CURRENT_LINK" ]] && PREVIOUS=$(readlink -f "$CURRENT_LINK")
[[ -n "$PREVIOUS" && -d "$PREVIOUS" ]] || die "$EXIT_PRECHECK" 'current 必须指向现有发行目录。'

# 备份和迁移都在切换 current 前完成；任一失败都会保留旧程序运行。
report_phase backing_up
TGTC_SKIP_LOCK=1 TGTC_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/backup.sh"
mkdir -p "$INSTALL_ROOT/releases"
report_phase extracting
mv "$CANDIDATE" "$TARGET"
report_phase migrating
run_target_migrations

# Runtime data remains outside releases. Refuse implicit migration/copying of protected paths.
for protected in "$INSTALL_ROOT/telegram-bot-api/data" "$INSTALL_ROOT/backend/.env" "$INSTALL_ROOT/.env" "$INSTALL_ROOT/redis" "$INSTALL_ROOT/uploads" "$INSTALL_ROOT/logs" "$INSTALL_ROOT/cache"; do
  [[ -e "$protected" ]] || log "WARN: 受保护状态不存在：$protected（不会创建或复制）"
done
report_phase activating
ln -s "releases/$NEW_VERSION" "$INSTALL_ROOT/.current.new"
mv -Tf "$INSTALL_ROOT/.current.new" "$CURRENT_LINK"
report_phase restarting
if ! systemctl restart "$SERVICE"; then
  rollback_after_activation_failure '新程序启动失败'
fi
report_phase health_checking
if ! TGTC_EXPECTED_VERSION="$NEW_VERSION" TGTC_API_URL="${TGTC_API_URL:-http://127.0.0.1:3000}" "$TARGET/scripts/release/health-check.sh"; then
  rollback_after_activation_failure '健康检查失败'
fi
record_state "upgrade ok version=$NEW_VERSION previous=$PREVIOUS"
log "OK: 已备份、迁移并原子切换到 $NEW_VERSION；运行时 Telegram 数据、数据库与 .env 未被移动或覆盖。"
