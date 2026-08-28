.PHONY: up seed load load-heavy logs ps down clean urls

# Build images and start the full stack.
up:
	docker compose up -d --build
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
	@echo "  API        http://localhost:3000/health"
	@echo "  Discover   http://localhost:3000/discover"
	@echo "  Metrics    http://localhost:3000/metrics"
	@echo "  Grafana    http://localhost:3001  (dashboard: Streaming Discovery API)"
	@echo "  Prometheus http://localhost:9090"
	@echo "  RabbitMQ   http://localhost:15673  (streaming / streaming)"
	@echo ""

# Stop everything, keep data volume.
down:
	docker compose down

# Stop and wipe data.
clean:
	docker compose down -v
