#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Usage: upgrade.sh /absolute/path/tgtc-vX.Y.Z-linux-x64.zip [/absolute/path/SHA256SUMS]
# Exit codes: 0 success; 2 usage; 3 precheck; 4 verification; 5 operation; 6 rollback failure.
[[ $# -ge 1 && $# -le 2 ]] || die "$EXIT_USAGE" "用法：$0 ARCHIVE [SHA256SUMS]"
ARCHIVE=$1
SUMS=${2:-"$(dirname "$ARCHIVE")/SHA256SUMS"}
# 发布清单与 SHA256SUMS 同目录（由 updater.sh 或人工发布目录提供）。
MANIFEST_SRC="$(dirname "$SUMS")/release-manifest.json"
# INSTALL_ROOT 由 common.sh 统一解析（含 releases/ 布局特判），此处不得重算。
CURRENT_LINK="$INSTALL_ROOT/current"
SERVICE="${TGTC_SERVICE:-tgtc.service}"
BOT_SERVICE="${TGTC_BOT_SERVICE:-tgtc-telegram-bot-api.service}"
ENV_FILE="${TGTC_ENV_FILE:-$RUNTIME_DIR/backend/.env}"

# 任务模式（由 updater.sh 派发）通过 TGTC_PROGRESS_FILE 回写状态机阶段；
# 人工模式未设置该变量时静默跳过。
report_phase() {
  if [[ -n "${TGTC_PROGRESS_FILE:-}" ]]; then
    printf '%s\n' "$1" > "$TGTC_PROGRESS_FILE" 2>/dev/null || true
  fi
}

restart_bot_if_present() {
  if systemctl cat "$BOT_SERVICE" >/dev/null 2>&1; then
    # R3：新 Bot API 二进制随发行包交付，必须重启才真正生效；
    # 失败不中止（Bot API 仅影响流式下载，由后端就绪检查兜底）。
    systemctl restart "$BOT_SERVICE" || log "WARN: $BOT_SERVICE 重启失败，请人工检查。"
  fi
}

# The parent owns the write freeze for both databases and all failure paths.
freeze_started=0
was_active=0
migration_started=0
backup_path=''
target_installed=0

check_release_health() {
  local release=$1 i attempts="${TGTC_READY_WAIT_ATTEMPTS:-15}"
  for ((i=0; i<attempts; i++)); do
    api_get health >/dev/null 2>&1 && break
    sleep 2
  done
  TGTC_EXPECTED_VERSION="$(read_version "$release/VERSION")" "$release/scripts/release/health-check.sh"
}

recover_failed_upgrade() {
  if (( migration_started )) && [[ "$ROLLBACK_SAFE" != true ]]; then
    systemctl stop "$SERVICE" || log "ERROR: 停止 $SERVICE 失败，须立即人工停写。"
    log "禁止自动回退（programRollbackSafe=$ROLLBACK_SAFE）。恢复已验证备份 $backup_path，再核对 current、.env 和 Telegram 工作目录后启动旧版本 $PREVIOUS。"
    record_state "upgrade recovery_required version=$NEW_VERSION backup=$backup_path previous=$PREVIOUS rollback_safe=$ROLLBACK_SAFE"
    return "$EXIT_ROLLBACK"
  fi
  if [[ "$(readlink -f "$CURRENT_LINK")" != "$PREVIOUS" ]]; then
    report_phase rolling_back
    systemctl stop "$SERVICE" || return "$EXIT_ROLLBACK"
    ln -s "$PREVIOUS" "$STAGE/previous" && mv -Tf "$STAGE/previous" "$CURRENT_LINK" || return "$EXIT_ROLLBACK"
    restart_bot_if_present
  fi
  if (( was_active )); then
    systemctl start "$SERVICE" && check_release_health "$PREVIOUS" || return "$EXIT_ROLLBACK"
  else
    systemctl stop "$SERVICE" || return "$EXIT_ROLLBACK"
  fi
  if (( target_installed )); then rm -rf -- "$TARGET"; fi
  record_state "upgrade failed restored_previous=$PREVIOUS active=$was_active backup=$backup_path"
}

finish_upgrade() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 && freeze_started )); then
    recover_failed_upgrade || rc=$EXIT_ROLLBACK
  fi
  rm -rf -- "$STAGE"
  exit "$rc"
}

# P1-05：迁移子进程的工作目录必须是 .env 所在目录（$RUNTIME_DIR/backend）。
# SQLite 的 DB_DATABASE 常为相对路径（data/tgtc.sqlite），由 cwd 解析；
# 此前 cd 到新发行目录会连到空库——真实库未迁移而流程继续。
run_target_migrations() {
  if [[ ! -x "$TARGET/runtime/bin/node" ]]; then log "ERROR: 候选发行包缺少 Node.js：$TARGET/runtime/bin/node"; return 1; fi
  if [[ ! -f "$TARGET/backend/node_modules/typeorm/cli.js" ]]; then log 'ERROR: 候选发行包缺少 TypeORM CLI。'; return 1; fi
  if [[ ! -f "$TARGET/backend/dist/database/data-source.js" ]]; then log 'ERROR: 候选发行包缺少编译后的数据库数据源。'; return 1; fi
  if [[ ! -r "$ENV_FILE" ]]; then log "ERROR: 无法读取迁移环境文件：$ENV_FILE"; return 1; fi
  log "运行目标发行版 $NEW_VERSION 的数据库迁移。"
  (
    cd "$RUNTIME_DIR/backend"
    # dotenv 的 env-options 机制只读大写 DOTENV_CONFIG_PATH；小写变量静默失效，
    # 会导致迁移回退到 database.config.ts 的默认库名（"test"）而连错库。
    DOTENV_CONFIG_PATH="$ENV_FILE" "$TARGET/runtime/bin/node" \
      -r "$TARGET/backend/node_modules/dotenv/config" \
      "$TARGET/backend/node_modules/typeorm/cli.js" migration:run \
      -d "$TARGET/backend/dist/database/data-source.js"
  )
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

# M4：读取已验签清单中的程序回退安全标志（fail-closed：缺失/非法一律视为 unknown）。
# 该标志决定升级失败时能否自动切回旧代码，以及 rollback.sh 是否放行。
ROLLBACK_SAFE=$(release_rollback_safe_flag "$(dirname "$SUMS")")
log "程序回退安全标志（programRollbackSafe）：$ROLLBACK_SAFE"
if [[ "$ROLLBACK_SAFE" != 'true' ]]; then
  log "WARN: 本版本未声明可安全回退（programRollbackSafe=$ROLLBACK_SAFE）；升级失败时不会自动切回旧代码，需按人工指引先恢复数据库备份。"
fi

STAGE=$(mktemp -d "$INSTALL_ROOT/.tgtc-stage.XXXXXX")
trap finish_upgrade EXIT
unzip -q "$ARCHIVE" -d "$STAGE"
mapfile -t candidates < <(find "$STAGE" -mindepth 1 -maxdepth 1 -type d)
[[ ${#candidates[@]} -eq 1 ]] || die "$EXIT_VERIFY" '归档必须恰有一个顶层目录。'
CANDIDATE=${candidates[0]}
assert_no_protected_payload "$CANDIDATE"
NEW_VERSION=$(read_version "$CANDIDATE/VERSION")
TARGET="$INSTALL_ROOT/releases/$NEW_VERSION"
[[ ! -e "$TARGET" ]] || die "$EXIT_PRECHECK" "目标版本已存在，拒绝覆盖：$TARGET"
# releases/ 目录命名约定：纯版本号（不带 v 前缀）。提前打印目标路径，
# 避免运维排障时按错误的目录名（如 v1.1.1）误判升级未生效。
log "升级目标：$TARGET"
PREVIOUS=''
[[ -L "$CURRENT_LINK" ]] && PREVIOUS=$(readlink -f "$CURRENT_LINK")
[[ -n "$PREVIOUS" && -d "$PREVIOUS" ]] || die "$EXIT_PRECHECK" 'current 必须指向现有发行目录。'

report_phase backing_up
if systemctl is-active --quiet "$SERVICE"; then was_active=1; fi
freeze_started=1
systemctl stop "$SERVICE" || die "$EXIT_OPERATION" "无法停止 $SERVICE。"
TGTC_SKIP_LOCK=1 TGTC_ENV_FILE="$ENV_FILE" TGTC_BACKUP_KEEP_STOPPED=1 TGTC_BACKUP_RESULT_FILE="$STAGE/backup-path" bash "$SCRIPT_DIR/backup.sh" || die "$EXIT_OPERATION" "数据库备份失败。"
IFS= read -r backup_path < "$STAGE/backup-path"
[[ -s "$backup_path/SHA256SUMS" ]] || die "$EXIT_VERIFY" '缺少已验证的备份。'
mkdir -p "$INSTALL_ROOT/releases"
report_phase extracting
mv "$CANDIDATE" "$TARGET"
target_installed=1
# mv 就位断言：关键运行文件缺失说明移动不完整，立即停止（current 仍未切换）。
for required in "$TARGET/VERSION" "$TARGET/backend/dist/main.js" "$TARGET/runtime/bin/node" \
  "$TARGET/backend/node_modules/typeorm/cli.js" "$TARGET/backend/node_modules/dotenv/config.js"; do
  [[ -e "$required" ]] || die "$EXIT_OPERATION" "新版本就位校验失败（缺少 $required）；未切换 current。"
done
log "新版本已就位：$TARGET"
# M4：把已验签的发布清单持久化进发行目录，供 rollback.sh 判断能否安全自动回退。
if [[ -f "$MANIFEST_SRC" && ! -L "$MANIFEST_SRC" ]]; then
  cp -- "$MANIFEST_SRC" "$TARGET/release-manifest.json"
  log "已记录发布清单：$TARGET/release-manifest.json（programRollbackSafe=$ROLLBACK_SAFE）"
else
  log "WARN: 未提供 release-manifest.json；回滚脚本将按 fail-closed 拒绝自动回退。"
fi
report_phase migrating
migration_started=1
run_target_migrations || die "$EXIT_OPERATION" "版本 $NEW_VERSION 迁移失败。"

# Runtime data remains outside releases. Refuse implicit migration/copying of protected paths.
for protected in "$INSTALL_ROOT/telegram-bot-api/data" "$INSTALL_ROOT/backend/.env" "$INSTALL_ROOT/.env" "$INSTALL_ROOT/redis" "$INSTALL_ROOT/uploads" "$INSTALL_ROOT/logs" "$INSTALL_ROOT/cache"; do
  [[ -e "$protected" ]] || log "WARN: 受保护状态不存在：$protected（不会创建或复制）"
done
report_phase activating
ln -s "releases/$NEW_VERSION" "$STAGE/next"
mv -Tf "$STAGE/next" "$CURRENT_LINK"
if (( was_active )); then
  report_phase restarting
  restart_bot_if_present
  systemctl start "$SERVICE" || die "$EXIT_OPERATION" '新程序启动失败。'
  report_phase health_checking
  check_release_health "$TARGET" || die "$EXIT_OPERATION" '新程序健康检查失败。'
else
  log "$SERVICE 在升级前已停止，已离线切换版本；下次启动后运行 health-check.sh。"
fi
record_state "upgrade ok version=$NEW_VERSION previous=$PREVIOUS"
log "OK: 已备份、迁移并原子切换到 $NEW_VERSION；运行时 Telegram 数据、数据库与 .env 未被移动或覆盖。"
