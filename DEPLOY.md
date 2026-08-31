# Deploying the live demo (single VM)

This runs the **whole stack live** at a real HTTPS URL, behind basic auth, so you
can drop a link in an outreach email. It works on any Linux VM with Docker —
DigitalOcean, AWS Lightsail, Hetzner, EC2. It does **not** run on Vercel / Render
/ Fly / ECS, because the control plane scales by calling the host's Docker API to
create and remove containers (that's the demo). It needs a real Docker daemon.

**The one spec that matters:** this is CPU-bound under the surge (a ~4,000 req/s
load generator plus up to 4 API + 5 worker containers), so pick **~4 vCPU** so
the latency numbers reflect the *modeled* saturation, not a starved box.

| Provider | Pick | ~Cost |
|---|---|---|
| DigitalOcean | Basic **8 GB / 4 vCPU** | ~$48/mo (best CPU-per-$) |
| AWS Lightsail | a **4 vCPU** plan (not the 2-vCPU/8GB one) | ~$80–160/mo |
| Hetzner | CPX41 (8 vCPU / 16 GB) | ~$30/mo (cheapest) |

**Cost in practice:** all bill hourly. Spin it up when you send the email, keep
it for the week Angel might look, then **destroy it** — that's a few dollars, not
a monthly bill. Reserve a **static/reserved IP** (free while attached) so the URL
stays stable.

---

## 1. Provision the VM
- Create the VM (Ubuntu 22.04+), 4 vCPU / 8 GB.
- Attach a **reserved/static IP**. Note it, e.g. `143.42.9.17`.
- Firewall: allow **22 (SSH), 80, 443** only. Nothing else needs to be public.

## 2. Install Docker + Compose (+ make)
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out/in, or run the rest with sudo
docker compose version          # confirm Compose v2 is present
sudo apt-get update && sudo apt-get install -y make   # the Makefile is the task runner
```

## 3. Get the code + secrets
```bash
git clone <your-repo-url> angel-streaming-demo
cd angel-streaming-demo
cp .env.example .env    # then edit .env and set OPENROUTER_API_KEY (for the AI explainer)
```

## 4. Point Caddy at the production config
Two env values drive it: your **sslip.io domain** and a **basic-auth** credential.

Your domain is your dashed IP + `.sslip.io` — for `143.42.9.17` that's
`143-42-9-17.sslip.io` (it resolves to your IP automatically, free, and Caddy can
get a real Let's Encrypt cert for it).

Generate a bcrypt password hash and write `caddy.env` in one go. **Important:**
a bcrypt hash contains `$` characters, and Docker Compose performs variable
interpolation on `env_file` values — so a raw `$2a$14$...` hash gets silently
mangled (Compose eats `$name` as an undefined variable) and Caddy then fails to
start with `illegal base64 data`. The fix is to **double every `$` to `$$`**,
which Compose collapses back to a single `$`. This snippet does that escaping for
you automatically — just set your domain and password:
```bash
SITE=143-42-9-17.sslip.io          # your dashed IP + .sslip.io
HASH=$(docker run --rm caddy caddy hash-password --plaintext 'PICK-A-STRONG-PASSWORD')
printf 'SITE_ADDRESS=%s\nBASIC_AUTH_USER=angel\nBASIC_AUTH_HASH=%s\n' \
  "$SITE" "${HASH//\$/\$\$}" > caddy.env
cat caddy.env    # sanity-check: the hash line should show $$2a$$14$$...
```
(If you'd rather write it by hand, take the `$2a$14$...` from `caddy
hash-password` and double each `$`: `$$2a$$14$$...`.)

Swap the dev Caddyfile for the prod one (the caddy service mounts
`caddy/Caddyfile`, so replacing its contents is the cleanest, override-free way
— this is a local edit on the VM, don't commit it):
```bash
cp caddy/Caddyfile.prod caddy/Caddyfile
```

Then add a small compose override for the bits that merge cleanly — the env file,
port 80 (needed for the Let's Encrypt HTTP challenge; the dev compose only opens
443), and a volume to persist the cert (create `docker-compose.override.yml`):
```yaml
services:
  caddy:
    env_file: caddy.env
    ports:
      - "80:80"
    volumes:
      - caddy_data:/data          # persists the Let's Encrypt cert across restarts
volumes:
  caddy_data:
```
(These all append without conflict — the base 443 mapping and the Caddyfile mount
stay as-is; we only added port 80, the env file, and the cert volume. The
mkcert `caddy/certs` mount is simply unused by the prod config.)

## 5. Bring it up
```bash
make up      # builds, starts, scales the worker pool, seeds the catalog
```
(The Makefile's mkcert step auto-skips on a prod VM — there's no mkcert and none
is needed; Caddy gets a real Let's Encrypt cert. `make up-prod` is a documented
alias for the same thing.)

First TLS issuance takes ~10–30s. Then open:
```
https://143-42-9-17.sslip.io      (log in with the basic-auth user/password)
```
You'll land on the **Basic** tab — hit **▶ The premiere rush**.

## 6. Hardening (already mostly done)
- **Basic auth** is on (step 4) — the URL can spawn containers + drive load, so keep it behind auth.
- Only the **Console** is exposed by default; api/prometheus/grafana/jaeger/rabbitmq stay on the internal network. The Console's "Traces ↗ / API ↗" header links are local-dev only and won't resolve publicly — that's fine, the tours don't need them. The **Grafana ↗** link auto-hides publicly unless you expose Grafana (next bullet).
- The **Basic tab is the default**, so a visitor gets the one-button guided tour, not the raw load dial.
- Optional: to peek at Grafana/etc. yourself without exposing them, SSH-tunnel: `ssh -L 3001:localhost:3001 user@<ip>` then `http://localhost:3001`.

## 6b. Expose Grafana too (optional)
Publishes the Grafana dashboards on their own sslip.io host, behind the **same**
basic auth, and points the Console's **Grafana ↗** link straight at the Streaming
QoE board. Grafana runs with anonymous **Viewer** access so there's no second
Grafana login (the admin/edit surface stays behind the basic-auth wall). Uses the
same ports 80/443 — no firewall change.

Your Grafana host is `grafana.` + your Console host, e.g.
`grafana.157-230-196-166.sslip.io` (sslip.io resolves it to your IP for free).

1. Add `GRAFANA_SITE_ADDRESS` to `caddy.env` (no `$`, so no escaping needed):
   ```bash
   echo 'GRAFANA_SITE_ADDRESS=grafana.157-230-196-166.sslip.io' >> caddy.env
   ```
2. Point the Console link at it — add to `.env`:
   ```bash
   echo 'GRAFANA_BASE=https://grafana.157-230-196-166.sslip.io' >> .env
   ```
3. Use the Grafana-enabled Caddyfile instead of the Console-only one:
   ```bash
   cp caddy/Caddyfile.prod-grafana caddy/Caddyfile
   ```
4. Add a Grafana block to `docker-compose.override.yml` — anonymous Viewer + the
   correct public root URL (merge these into the `services:` you already have):
   ```yaml
   services:
     grafana:
       environment:
         GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer
         GF_SERVER_ROOT_URL: "https://grafana.157-230-196-166.sslip.io/"
         GF_SERVER_DOMAIN: "grafana.157-230-196-166.sslip.io"
   ```
5. Rebuild the control plane (picks up `GRAFANA_BASE`) and restart Caddy + Grafana:
   ```bash
   docker compose up -d --build controlplane caddy grafana
   ```
First cert for the new host issues in ~10–30s. The **Grafana ↗** link now opens
`https://grafana.157-230-196-166.sslip.io/d/streaming-discovery/streaming-qoe?orgId=1&refresh=5s`.

## 6c. Skip Jaeger on the VM (lighter box)
The tours tell their story through Grafana (aggregate metrics), not Jaeger
(per-request traces), and the Jaeger all-in-one container competes for the same
CPUs as the load generator. To drop it on a prod VM — keeping the OpenTelemetry
instrumentation in the code, just not running the collector here:

1. In `.env`, turn off span export and hide the Console's Traces link:
   ```bash
   echo 'OTEL_ENABLED=false' >> .env
   echo 'JAEGER_UI_BASE='     >> .env
   ```
2. Keep Jaeger out of `docker compose up` by profiling it out — add to
   `docker-compose.override.yml`:
   ```yaml
   services:
     jaeger:
       profiles: ["tracing"]   # excluded unless you run: docker compose --profile tracing up
   ```
3. Remove the running container and recreate the app with export off:
   ```bash
   docker compose rm -sf jaeger
   docker compose up -d --build controlplane api worker
   ```
The Console's **Traces ↗** link disappears (no dead link), and no spans are
generated. Local dev is unaffected — Jaeger still runs there by default.

## 7. Tear down when done
```bash
make down        # stop containers, keep data
# or, on the provider, just DESTROY the VM — billing stops.
```

---

## Using your own domain later (5-minute upgrade)
Buy a cheap domain, point an A record at the VM's IP, then in `caddy.env` set
`SITE_ADDRESS=demo.yourdomain.com` and `make up`. Caddy re-issues the cert for the
new name. Nothing else changes.

## Notes
- Under a full surge the box will use most of the 4 vCPUs — that's expected and
  by design (the point is showing it hold up). At idle it's light.
- The demo is stateless-friendly: `make down` keeps the Postgres volume; `make
  clean` wipes it (re-seeds on next `make up`).
