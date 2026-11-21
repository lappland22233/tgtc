#!/usr/bin/env bash
set -Eeuo pipefail
project=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
checkout="$fixture/source checkout's data"
install="$fixture/persistent"
export FIXTURE_UNIT="$fixture/unit" REAL_SQLITE
REAL_SQLITE=$(command -v sqlite3)
mkdir -p "$checkout/scripts/release" "$checkout/backend/data" "$install/runtime/backend/data" "$install/current" "$fixture/bin"
cp "$project/scripts/release/"{common,backup}.sh "$checkout/scripts/release/"
printf '2.0.1\n' > "$checkout/VERSION"
printf '1.6.3\n' > "$install/current/VERSION"
cat > "$fixture/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -eu
case "$1" in
  is-active) [[ $(cat "$FIXTURE_UNIT") == active ]] ;;
  stop) echo inactive > "$FIXTURE_UNIT"; echo stop >> "$FIXTURE_UNIT.log" ;;
  start) echo active > "$FIXTURE_UNIT"; echo start >> "$FIXTURE_UNIT.log" ;;
  *) exit 3 ;;
esac
SH
cat > "$fixture/bin/sqlite3" <<'SH'
#!/usr/bin/env bash
set -eu
if [[ ${FAIL_SQLITE_BACKUP:-0} == 1 && $2 == .backup* ]]; then exit 13; fi
exec "$REAL_SQLITE" "$@"
SH
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
for runtime in "$checkout/backend" "$install/runtime/backend"; do
  printf 'DB_TYPE=sqlite\nDB_DATABASE=./data/live.sqlite\n' > "$runtime/.env"
  "$REAL_SQLITE" "$runtime/data/live.sqlite" "create table marker(v); insert into marker values(7)"
done
backup="$checkout/scripts/release/backup.sh"
verify_snapshot() {
  local root=$1 version=$2 dest
  dest=$(sed -n 's/.*backup ok type=sqlite path=//p' "$root/.tgtc-ops/history.log" | tail -n1)
  grep -Fxq "version=$version" "$dest/metadata"
  [[ $("$REAL_SQLITE" "$dest/database.sqlite" 'select v from marker') == 7 ]]
  (cd "$dest" && sha256sum -c SHA256SUMS)
}
echo active > "$FIXTURE_UNIT"
bash "$backup"
verify_snapshot "$checkout" 2.0.1
[[ $(cat "$FIXTURE_UNIT.log") == $'stop\nstart' ]]
: > "$FIXTURE_UNIT.log"
if FAIL_SQLITE_BACKUP=1 bash "$backup"; then exit 1; fi
[[ $(cat "$FIXTURE_UNIT.log") == $'stop\nstart' && $(cat "$FIXTURE_UNIT") == active ]]
[[ $(find "$checkout/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) == 1 ]]
: > "$FIXTURE_UNIT.log"
echo inactive > "$FIXTURE_UNIT"
mkdir -p "$install/backups/unrelated"
touch -d '40 days ago' "$install/backups/unrelated"
TGTC_INSTALL_ROOT="$install" bash "$backup"
verify_snapshot "$install" 1.6.3
[[ ! -s "$FIXTURE_UNIT.log" && -d "$install/backups/unrelated" ]]
if TGTC_INSTALL_ROOT="$install" TGTC_BACKUP_DIR="$fixture/outside/new/backups" bash "$backup"; then exit 1; fi
[[ ! -e "$fixture/outside" ]]
ln -s "$fixture" "$install/linked"
if TGTC_INSTALL_ROOT="$install" TGTC_BACKUP_DIR="$install/linked/backups" bash "$backup"; then exit 1; fi
echo 'PASS source and legacy backup paths, SQLite restore, service state and backup retention'
