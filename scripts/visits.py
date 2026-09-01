#!/usr/bin/env python3
"""Turn Caddy's JSON access log (on stdin) into readable visit lines.

Usage: <caddy logs> | visits.py [visits|all]
  visits (default) : authenticated page opens only (real visitors)
  all              : every logged request, including 401 bots and asset/poll noise
"""
import sys
import json
import datetime
import ipaddress

mode = sys.argv[1] if len(sys.argv) > 1 else "visits"


def is_external(ip):
    """True for a real public internet client; False for private/internal IPs
    (Docker network, loopback, link-local) that are your own tests or health
    checks, not visitors. Unknown/unparseable IPs are treated as external so a
    real one is never hidden."""
    try:
        return ipaddress.ip_address(ip).is_global
    except Exception:
        return True

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
    uri = req.get("uri", "?")
    host = req.get("host", "")
    status = d.get("status", "?")
    ua = req.get("headers", {}).get("User-Agent", ["?"])
    ua = ua[0] if isinstance(ua, list) and ua else (ua if isinstance(ua, str) else "?")
    ts = datetime.datetime.fromtimestamp(d.get("ts", 0)).strftime("%Y-%m-%d %H:%M:%S")
    if mode != "all":
        # real visitor page opens: an external client, authenticated (200) GET
        # of an app root, skipping /api/* status polls, static assets, 401 bots,
        # and internal/private IPs (your own tests, Docker health checks).
        if not is_external(ip):
            continue
        if status != 200:
            continue
        if uri not in ("/", "/index.html", "/console", "/console/"):
            continue
    print(f"{ts}  {ip:15s}  {status}  {host}{uri}  {ua[:70]}", flush=True)
