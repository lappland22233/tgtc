#!/usr/bin/env bash
# Exercise the release scripts' write freeze and recovery using an isolated service and database.
# Signature/structure checks are covered separately; this fixture starts with an accepted candidate.
set -Eeuo pipefail
scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/package/candidate"
export PATH="$tmp/bin:$PATH" TGTC_READY_WAIT_ATTEMPTS=0
cat > "$tmp/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
set -eu
case "$1" in
  cat) [[ "$2" == tgtc.service ]] && echo "ExecStart=$TEST_ROOT/current/bin/tgtc" ;;
  is-active) [[ $(cat "$TEST_ROOT/service") == active ]] ;;
  stop) echo inactive > "$TEST_ROOT/service"; echo stop >> "$TEST_ROOT/events" ;;
  start|restart)
    version=$(cat "$TEST_ROOT/current/VERSION")
    echo "start $version" >> "$TEST_ROOT/events"
    [[ "$FAIL_AT $version" != 'start 2.0.0' ]] || exit 1
    echo active > "$TEST_ROOT/service"
    ;;
  *) exit 1 ;;
esac
STUB
cat > "$tmp/bin/pg_dump" <<'STUB'
#!/usr/bin/env bash
set -eu
[[ $(cat "$TEST_ROOT/service") == inactive ]]
echo backup >> "$TEST_ROOT/events"
[[ "$FAIL_AT" != backup ]] || exit 1
echo pg-dump > "${!#}"
STUB
cat > "$tmp/bin/pg_restore" <<'STUB'
#!/usr/bin/env bash
test -s "${!#}"
STUB
cat > "$tmp/bin/sqlite3" <<'STUB'
#!/usr/bin/env bash
set -eu
if [[ "$2" == ".backup "* ]]; then
  [[ $(cat "$TEST_ROOT/service") == inactive ]]
  echo backup >> "$TEST_ROOT/events"
  [[ "$FAIL_AT" != backup ]] || exit 1
  target=${2#*\'}; target=${target%\'}
  cp "$1" "$target"
else
  test -s "$1" && echo ok
fi
STUB
chmod +x "$tmp/bin/"*
candidate="$tmp/package/candidate"
mkdir -p "$candidate"/{backend/dist/database,backend/node_modules/{dotenv,typeorm},runtime/bin,scripts/release}
touch "$candidate"/{backend/dist/main.js,backend/dist/database/data-source.js,backend/node_modules/typeorm/cli.js,backend/node_modules/dotenv/config.js}
echo 2.0.0 > "$candidate/VERSION"
cat > "$candidate/runtime/bin/node" <<'STUB'
#!/usr/bin/env bash
set -eu
[[ $(cat "$TEST_ROOT/service") == inactive ]]
echo migration >> "$TEST_ROOT/events"
[[ "$FAIL_AT" != migration ]]
STUB
cat > "$candidate/scripts/release/health-check.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
echo "health $TGTC_EXPECTED_VERSION" >> "$TEST_ROOT/events"
[[ $(cat "$TEST_ROOT/service") == active && "$FAIL_AT $TGTC_EXPECTED_VERSION" != 'health 2.0.0' ]]
STUB
chmod +x "$candidate/runtime/bin/node" "$candidate/scripts/release/health-check.sh"
(cd "$tmp/package" && zip -qr "$tmp/candidate.zip" candidate)

setup_case() {
  TEST_ROOT=$(mktemp -d "$tmp/case.XXXXXX")
  export TEST_ROOT FAIL_AT=$3
  old="$TEST_ROOT/releases/1.0.0"
  mkdir -p "$old/scripts/release" "$TEST_ROOT/runtime/backend"
  cp "$scripts"/{common,backup,upgrade}.sh "$old/scripts/release/"
  cp "$candidate/scripts/release/health-check.sh" "$old/scripts/release/"
  echo 'exit 0' > "$old/scripts/release/validate-release.sh"
  echo 1.0.0 > "$old/VERSION"
  ln -s "$old" "$TEST_ROOT/current"
  echo "$2" > "$TEST_ROOT/service"
  : > "$TEST_ROOT/events"
  cat > "$TEST_ROOT/runtime/backend/.env" <<ENV
DB_TYPE=$1
DB_DATABASE=db
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=fixture
ENV
  echo fixture-data > "$TEST_ROOT/runtime/backend/db"
}

run_upgrade() {
  local db=$1 originally=$2 failure=$3 safe=$4 expected_rc=$5 expected_state=$6 expected_version=$7 rc=0
  setup_case "$db" "$originally" "$failure"
  if [[ $safe == unknown ]]; then rm -f "$tmp/release-manifest.json"; else
    printf '{"programRollbackSafe":%s}\n' "$safe" > "$tmp/release-manifest.json"
  fi
  bash "$old/scripts/release/upgrade.sh" "$tmp/candidate.zip" "$tmp/SHA256SUMS" > "$TEST_ROOT/log" 2>&1 || rc=$?
  if [[ $rc != "$expected_rc" || $(cat "$TEST_ROOT/service") != "$expected_state" || $(cat "$TEST_ROOT/current/VERSION") != "$expected_version" ]]; then
    cat "$TEST_ROOT/events" "$TEST_ROOT/log" >&2
    return 1
  fi
  [[ $(head -n2 "$TEST_ROOT/events") == $'stop\nbackup' ]]
  if [[ $originally == inactive ]]; then
    ! grep -q '^start ' "$TEST_ROOT/events" || return 1
  fi
  if (( rc == 6 )); then
    ! grep -Fxq 'start 1.0.0' "$TEST_ROOT/events" || return 1
    local backup
    backup=$(sed -n 's/.* recovery_required .* backup=\([^ ]*\) previous=.*/\1/p' "$TEST_ROOT/.tgtc-ops/history.log")
    [[ -s "$backup/SHA256SUMS" ]]
  fi
  if [[ $safe == true && $failure == health ]]; then
    grep -Fxq 'health 1.0.0' "$TEST_ROOT/events"
  fi
  echo "ok upgrade $db $originally $failure rollbackSafe=$safe"
}

for db in postgres sqlite; do
  run_upgrade "$db" active backup false 5 active 1.0.0
  run_upgrade "$db" inactive backup false 5 inactive 1.0.0
  run_upgrade "$db" active migration false 6 inactive 1.0.0
  run_upgrade "$db" active health false 6 inactive 2.0.0
  run_upgrade "$db" active start unknown 6 inactive 2.0.0
  run_upgrade "$db" active health true 5 active 1.0.0
  run_upgrade "$db" active none false 0 active 2.0.0
  run_upgrade "$db" inactive none false 0 inactive 2.0.0
done

for initial in active inactive; do
  for failure in none backup; do
    setup_case sqlite "$initial" "$failure"
    rc=0
    bash "$old/scripts/release/backup.sh" > "$TEST_ROOT/log" 2>&1 || rc=$?
    [[ $(cat "$TEST_ROOT/service") == "$initial" ]]
    if [[ $failure == none ]]; then [[ $rc == 0 ]]; else [[ $rc != 0 ]]; fi
    echo "ok standalone sqlite $initial $failure"
  done
done
