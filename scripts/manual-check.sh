#!/usr/bin/env bash
# 手動確認用: examples/basic を各 DB で起動し、確認シナリオ(smoke.ts)を流す。
#   bash scripts/manual-check.sh [postgres|mysql|sqlite|all]   (既定: all)
# PostgreSQL / MySQL は docker compose で起動する(開発用 DB の orders / inventory は作り直される)。
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"
case "$target" in
  all) dbs=(sqlite postgres mysql) ;;
  postgres | mysql | sqlite) dbs=("$target") ;;
  *) echo "usage: $0 [postgres|mysql|sqlite|all]" >&2; exit 2 ;;
esac

PORT="${PORT:-3210}"
export PORT
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use (set PORT=<free port>)" >&2
  exit 1
fi
log="$(mktemp -t yuiitsu-manual-check.XXXXXX)"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -f "$log"
}
trap cleanup EXIT

need_docker=false
for d in "${dbs[@]}"; do [ "$d" != sqlite ] && need_docker=true; done
if $need_docker; then pnpm exec vp run db:up; fi
pnpm exec vp run -r build

declare -a results=()
status=0
for d in "${dbs[@]}"; do
  echo
  echo "=== $d ==="
  DB="$d" node --env-file-if-exists=.env examples/basic/src/server.ts >"$log" 2>&1 &
  server_pid=$!
  ready=false
  for _ in $(seq 1 60); do
    if curl -fs "http://localhost:$PORT/openapi.json" >/dev/null 2>&1; then ready=true; break; fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.5
  done
  if ! $ready; then
    echo "server failed to start:"; cat "$log"
    results+=("$d: FAIL (server did not start)"); status=1
  elif BASE_URL="http://localhost:$PORT" node --env-file-if-exists=.env examples/basic/src/smoke.ts; then
    results+=("$d: OK")
  else
    results+=("$d: FAIL"); status=1
  fi
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  server_pid=""
done

echo
echo "=== summary ==="
printf '%s\n' "${results[@]}"
exit "$status"
