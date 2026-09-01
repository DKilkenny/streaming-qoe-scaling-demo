#!/usr/bin/env bash
# Who has visited the live demo, and when. Reads Caddy's access log (the public
# front door) from `docker compose logs caddy` and prints readable lines.
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

cd "$(dirname "$0")/.." || exit 1
mode="${1:-visits}"

reader() {
  python3 - "$1" <<'PY'
import sys, json, datetime
mode = sys.argv[1] if len(sys.argv) > 1 else "visits"
for line in sys.stdin:
    i = line.find("{")
    if i < 0:
        continue
    try:
        d = json.loads(line[i:])
    except Exception:
        continue
    if d.get("msg") != "handled request":
        continue
    req = d.get("request", {})
    ip = req.get("client_ip") or req.get("remote_ip") or req.get("remote_addr") or "?"
    ip = ip.split(":")[0] if ip.count(":") == 1 else ip  # strip :port if present
    uri = req.get("uri", "?")
    host = req.get("host", "")
    status = d.get("status", "?")
    ua = req.get("headers", {}).get("User-Agent", ["?"])
    ua = ua[0] if isinstance(ua, list) and ua else (ua if isinstance(ua, str) else "?")
    ts = datetime.datetime.fromtimestamp(d.get("ts", 0)).strftime("%Y-%m-%d %H:%M:%S")
    if mode != "all":
        # real visitor page opens only: authenticated (200) GET of an app root,
        # skipping the /api/* status polls, static assets, and 401 bots.
        if status != 200:
            continue
        if uri not in ("/", "/index.html", "/console", "/console/"):
            continue
    print(f"{ts}  {ip:15s}  {status}  {host}{uri}  {ua[:70]}")
PY
}

if [ "$mode" = "follow" ]; then
  echo "Watching for real visits (Ctrl-C to stop)..."
  docker compose logs -f --no-color caddy 2>/dev/null | reader visits
else
  out="$(docker compose logs --no-color caddy 2>/dev/null | reader "$mode")"
  if [ -z "$out" ]; then
    echo "(no matching requests yet)"
  else
    echo "$out"
  fi
fi
