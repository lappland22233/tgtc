#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Exit codes: 0 success; 2 usage; 3 precheck; 4 verification; 5 operation failure.
BACKUP_ROOT="${TGTC_BACKUP_DIR:-$INSTALL_ROOT/backups}"
KEEP_DAYS="${TGTC_BACKUP_KEEP_DAYS:-14}"
# Canonicalize and reject symlinked paths before creating backups or pruning directories.
[[ "$BACKUP_ROOT" = /* ]] || die "$EXIT_PRECHECK" "备份目录必须是绝对路径：$BACKUP_ROOT"
case "$BACKUP_ROOT" in
  *"/../"*|*/..|*"/./"*|*/.) die "$EXIT_PRECHECK" "备份目录不得包含 . 或 .. 路径分量：$BACKUP_ROOT" ;;
esac
[[ ! -L "$INSTALL_ROOT" ]] || die "$EXIT_PRECHECK" "安装根目录不得为符号链接：$INSTALL_ROOT"
install_root_real=$(realpath -e -- "$INSTALL_ROOT") || die "$EXIT_PRECHECK" '无法规范化安装根目录。'
backup_parent=$(dirname -- "$BACKUP_ROOT")
mkdir -p -- "$backup_parent"
[[ ! -L "$backup_parent" ]] || die "$EXIT_PRECHECK" "备份父目录不得为符号链接：$backup_parent"
backup_parent_real=$(realpath -e -- "$backup_parent") || die "$EXIT_PRECHECK" '无法规范化备份父目录。'
case "$backup_parent_real" in
  "$install_root_real"|"$install_root_real"/*) ;;
  *) die "$EXIT_PRECHECK" "规范化后的备份目录必须位于安装根目录内：$BACKUP_ROOT" ;;
esac
BACKUP_ROOT="$backup_parent_real/$(basename -- "$BACKUP_ROOT")"
[[ ! -L "$BACKUP_ROOT" ]] || die "$EXIT_PRECHECK" "备份目录不得为符号链接：$BACKUP_ROOT"
[[ ! -e "$BACKUP_ROOT" || -d "$BACKUP_ROOT" ]] || die "$EXIT_PRECHECK" "备份路径已存在但不是目录：$BACKUP_ROOT"
ENV_FILE="${TGTC_ENV_FILE:-$RUNTIME_DIR/backend/.env}"
SERVICE="${TGTC_SERVICE:-tgtc.service}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || die "$EXIT_USAGE" 'TGTC_BACKUP_KEEP_DAYS 必须是非负整数。'
require_linux; require_cmd sha256sum; require_cmd flock; acquire_lock
[[ -r "$ENV_FILE" ]] || die "$EXIT_PRECHECK" "无法读取应用环境文件：$ENV_FILE"
# Only accepts simple KEY=VALUE lines; deliberately does not source .env.
env_value() {
  local key=$1 value
  value=$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n1)
  value=${value%$'\r'}
  if [[ ${value:0:1} == '"' && ${value: -1} == '"' ]]; then value=${value:1:${#value}-2}; fi
  if [[ ${value:0:1} == "'" && ${value: -1} == "'" ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}
DB_TYPE=$(env_value DB_TYPE); DB_TYPE=${DB_TYPE:-postgres}
STAMP=$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$BACKUP_ROOT"; DEST=$(mktemp -d "$BACKUP_ROOT/$STAMP.XXXXXX")

case "$DB_TYPE" in
  postgres)
    require_cmd pg_dump
    DB_HOST=$(env_value DB_HOST); DB_PORT=$(env_value DB_PORT); DB_USERNAME=$(env_value DB_USERNAME); DB_DATABASE=$(env_value DB_DATABASE)
    [[ -n "$DB_HOST" && -n "$DB_PORT" && -n "$DB_USERNAME" && -n "$DB_DATABASE" ]] || die "$EXIT_PRECHECK" 'PostgreSQL 配置不完整。'
    # Password is intentionally supplied only via current process env, never logged or written.
    PGPASSWORD="$(env_value DB_PASSWORD)" pg_dump --format=custom --no-owner --no-privileges --host "$DB_HOST" --port "$DB_PORT" --username "$DB_USERNAME" --dbname "$DB_DATABASE" --file "$DEST/database.pg.dump"
    pg_restore --list "$DEST/database.pg.dump" >/dev/null
    ;;
  sqlite)
    require_cmd sqlite3; require_cmd systemctl
    DB_DATABASE=$(env_value DB_DATABASE); [[ -n "$DB_DATABASE" ]] || die "$EXIT_PRECHECK" 'SQLite DB_DATABASE 未配置。'
    # P1-05：.env 与运行库都位于 $RUNTIME_DIR/backend（服务 WorkingDirectory 同为该目录），
    # 相对路径必须以 .env 所在目录解析；此前按发行目录解析必然找不到真实库。
    [[ "$DB_DATABASE" = /* ]] || DB_DATABASE="$RUNTIME_DIR/backend/$DB_DATABASE"
    [[ -f "$DB_DATABASE" ]] || die "$EXIT_PRECHECK" "SQLite 数据库不存在：$DB_DATABASE"
    if systemctl is-active --quiet "$SERVICE"; then
      # A standalone backup restores only a service that it stopped itself.
      restore_after_backup() {
        local rc=$?
        trap - EXIT
        if (( rc != 0 )) || [[ ${TGTC_BACKUP_KEEP_STOPPED:-0} != 1 ]]; then
          if ! systemctl start "$SERVICE"; then
            log "ERROR: 备份后无法恢复 $SERVICE。"
            rc=$EXIT_OPERATION
          fi
        fi
        exit "$rc"
      }
      trap restore_after_backup EXIT
      systemctl stop "$SERVICE"
    fi
    sqlite3 "$DB_DATABASE" ".backup '$DEST/database.sqlite'"
    [[ "$(sqlite3 "$DEST/database.sqlite" 'PRAGMA integrity_check;')" == ok ]] || die "$EXIT_VERIFY" 'SQLite 备份完整性检查失败。'
    ;;
  *) die "$EXIT_PRECHECK" "不支持的 DB_TYPE：$DB_TYPE" ;;
esac
sha256sum "$DEST"/* > "$DEST/SHA256SUMS"
printf 'version=%s\ndb_type=%s\ncreated_at=%s\n' "$(read_version "$RELEASE_ROOT/VERSION")" "$DB_TYPE" "$STAMP" > "$DEST/metadata"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf -- {} +
if [[ -n "${TGTC_BACKUP_RESULT_FILE:-}" ]]; then printf '%s\n' "$DEST" > "$TGTC_BACKUP_RESULT_FILE"; fi
record_state "backup ok type=$DB_TYPE path=$DEST"
log "OK: 已创建并验证备份：$DEST"
