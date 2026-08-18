#!/usr/bin/env bash
# Regenerates src/lib/types/database.ts from the migrations.
# Boots a throwaway Postgres cluster, applies every migration, introspects it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
PGDATA="$REPO/.tmp/typegen"
PORT="${PGPORT:-55433}"
DB="postgresql://postgres@127.0.0.1:$PORT/ibtypes"

export PATH="$PGBIN:$PATH"
export LANG=C LC_ALL=C

cleanup() { pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -rf "$PGDATA"; mkdir -p "$PGDATA"

initdb -D "$PGDATA" -U postgres --auth=trust --locale=C -E UTF8 >/dev/null
pg_ctl -D "$PGDATA" \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" \
  -l "$REPO/.tmp/typegen.log" start >/dev/null
sleep 2

psql "postgresql://postgres@127.0.0.1:$PORT/postgres" -q -c "create database ibtypes;"
psql "$DB" -v ON_ERROR_STOP=1 -q -f "$REPO/supabase/tests/00_local_shim.sql"
for f in "$REPO"/supabase/migrations/*.sql; do
  psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

PSQL="$PGBIN/psql" node "$REPO/scripts/gen-types.mjs" "$DB" "$REPO/src/lib/types/database.ts"
