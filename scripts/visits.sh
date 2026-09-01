#!/usr/bin/env bash
# Who has visited the live demo, and when. Reads Caddy's access log (the public
# front door) and prints readable lines. See scripts/visits.py for the parser.
#
# Because the demo is behind HTTP basic auth, a 200 is a real invited visitor;
# random bots/scanners that hit the URL without the password get a 401. The
# default view shows just the real page opens so you can tell when someone
# (e.g. the person you emailed) actually clicked in.
#
# Usage, from the repo root on the VM:
#   ./scripts/visits.sh          # real visits only (authenticated page opens)
#   ./scripts/visits.sh all      # every request Caddy logged (incl. 401 bots, assets, polls)
#   ./scripts/visits.sh follow   # live tail of real visits as they happen
#
# Columns: timestamp  client-IP  status  host+path  user-agent

here="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-visits}"

# Resolve the caddy container directly. `docker compose logs` returns nothing on
# some Compose versions, so read from `docker logs` on the resolved container.
cid="$(docker compose ps -q caddy 2>/dev/null)"
[ -z "$cid" ] && cid="$(docker ps -qf 'name=caddy' | head -1)"
if [ -z "$cid" ]; then
  echo "caddy container not found (is the stack up?)"
  exit 1
fi

if [ "$mode" = "follow" ]; then
  echo "Watching for real visits (Ctrl-C to stop)..."
  docker logs -f "$cid" 2>&1 | python3 -u "$here/visits.py" visits
else
  out="$(docker logs "$cid" 2>&1 | python3 "$here/visits.py" "$mode")"
  if [ -z "$out" ]; then
    echo "(no matching requests yet)"
  else
    echo "$out"
  fi
fi
