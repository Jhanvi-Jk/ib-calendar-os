#!/usr/bin/env bash
# ============================================================================
# Runs every migration plus the guardrail suite against a throwaway local
# Postgres cluster. No Docker required.
#
#   ./scripts/db-test.sh
#
# Needs PostgreSQL 16 with btree_gist (Homebrew: `brew install postgresql@16`).
# The cluster lives in .tmp/pgdata and is destroyed and rebuilt on every run,
# so this is always testing the migrations from scratch — the same thing a
# fresh Supabase project will do.
# ============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
PGDATA="$REPO/.tmp/pgdata"
PORT="${PGPORT:-55432}"
DB="postgresql://postgres@127.0.0.1:$PORT/ibtest"

export PATH="$PGBIN:$PATH"
# initdb refuses to run under a locale it cannot resolve.
export LANG=C LC_ALL=C

cleanup() { pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
rm -rf "$PGDATA"
mkdir -p "$PGDATA"

echo "==> initialising cluster"
initdb -D "$PGDATA" -U postgres --auth=trust --locale=C -E UTF8 >/dev/null

echo "==> starting postgres on :$PORT"
pg_ctl -D "$PGDATA" \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" \
  -l "$REPO/.tmp/pg.log" start >/dev/null
sleep 2

psql "postgresql://postgres@127.0.0.1:$PORT/postgres" -q -c "create database ibtest;"

echo "==> applying shim + migrations"
psql "$DB" -v ON_ERROR_STOP=1 -q -f "$REPO/supabase/tests/00_local_shim.sql"
for f in "$REPO"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "==> guardrail suite"
psql "$DB" -v ON_ERROR_STOP=1 -q -f "$REPO/supabase/tests/01_guardrails.sql" 2>&1 \
  | sed -e 's/^psql:.*NOTICE:  //' -e 's/^/    /'

echo "==> ok"
