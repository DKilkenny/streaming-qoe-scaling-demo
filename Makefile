.PHONY: up certs seed load load-heavy logs ps down clean urls

# Generate a locally-trusted TLS cert (idempotent). Requires mkcert:
#   brew install mkcert && mkcert -install
certs:
	@mkdir -p caddy/certs
	@command -v mkcert >/dev/null 2>&1 || { echo "mkcert not found. Run: brew install mkcert && mkcert -install"; exit 1; }
	@test -f caddy/certs/local.pem || mkcert -cert-file caddy/certs/local.pem -key-file caddy/certs/local-key.pem localhost 127.0.0.1 ::1 grafana.localhost api.localhost prometheus.localhost console.localhost jaeger.localhost
	@echo "TLS cert ready. If the browser distrusts it, run 'mkcert -install' once."

# Build images and start the full stack (worker runs as a warm pool of 5).
up: certs
	docker compose up -d --build --scale worker=5
	@echo "waiting for the API to become healthy..."
	@until curl -sf http://localhost:3000/health >/dev/null 2>&1; do sleep 2; done
	@echo "API is up."
	$(MAKE) seed
	$(MAKE) urls

# Seed the synthetic catalog (idempotent).
seed:
	docker compose run --rm -e ROLE=seed api node dist/seed.js

# Run a real load test (containerized k6). Tune with PEAK_VUS / RAMP / HOLD.
load:
	docker compose run --rm k6 run /scripts/discover.js

load-heavy:
	docker compose run --rm -e PEAK_VUS=400 -e RAMP=60 -e HOLD=120 k6 run /scripts/discover.js

logs:
	docker compose logs -f api worker

ps:
	docker compose ps

urls:
	@echo ""
	@echo "  HTTPS (trusted cert via mkcert + Caddy):"
	@echo "    Load Console  https://console.localhost   <- start here"
	@echo "    Grafana       https://grafana.localhost   (dashboard: Streaming Discovery API)"
	@echo "    Traces        https://jaeger.localhost"
	@echo "    Discover      https://api.localhost/discover"
	@echo "    Prometheus    https://prometheus.localhost"
	@echo ""
	@echo "  Plain HTTP (direct to containers):"
	@echo "    API        http://localhost:3000/discover"
	@echo "    Grafana    http://localhost:3001"
	@echo "    RabbitMQ   http://localhost:15673  (streaming / streaming)"
	@echo ""

# Stop everything, keep data volume.
down:
	docker compose down

# Stop and wipe data.
clean:
	docker compose down -v
