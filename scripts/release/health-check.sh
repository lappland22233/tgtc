#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Exit codes: 0 healthy; 2 usage; 3 precheck; 4 one or more health checks failed.
SERVICE="${TGTC_SERVICE:-tgtc.service}"
BOT_SERVICE="${TGTC_BOT_SERVICE:-tgtc-telegram-bot-api.service}"
EXPECTED_VERSION="${TGTC_EXPECTED_VERSION:-$(read_version "$RELEASE_ROOT/VERSION")}" # release may override after an atomic switch
FAILURES=0
fail() { log "FAIL: $*"; FAILURES=1; }

require_linux
for command in systemctl curl; do require_cmd "$command"; done
systemctl is-active --quiet "$SERVICE" || fail "systemd 服务未运行：$SERVICE"
if systemctl cat "$BOT_SERVICE" >/dev/null 2>&1; then systemctl is-active --quiet "$BOT_SERVICE" || fail "Telegram Bot API 服务未运行：$BOT_SERVICE"; fi

health=$(api_get health 2>/dev/null || true)
[[ "$health" == *'"status":"ok"'* && "$health" == *'"database":"ok"'* ]] || fail '后端 /api/health 未返回就绪状态'
version=$(api_get version 2>/dev/null || true)
[[ "$version" == *"\"version\":\"$EXPECTED_VERSION\""* ]] || fail "后端版本不匹配（期望 $EXPECTED_VERSION）"
# Do not accept an SPA fallback: a frontend check must retrieve actual index markup.
frontend=$(curl --fail --silent --show-error --max-time "${TGTC_HTTP_TIMEOUT:-5}" "${TGTC_FRONTEND_URL:-http://127.0.0.1:3000/}" 2>/dev/null || true)
[[ "$frontend" == *'<html'* || "$frontend" == *'<!doctype html'* || "$frontend" == *'<!DOCTYPE html'* ]] || fail '前端首页不可用或未返回 HTML'

if (( FAILURES )); then record_state "health-check failed expected_version=$EXPECTED_VERSION"; exit "$EXIT_VERIFY"; fi
record_state "health-check ok version=$EXPECTED_VERSION"
log "OK: systemd、API、数据库、前端与版本均通过。"
