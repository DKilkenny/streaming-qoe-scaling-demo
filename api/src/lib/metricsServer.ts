import http from "node:http";
import { registry } from "../telemetry";

// Minimal metrics endpoint for the worker process (no Fastify/Redis pulled in).
// Lets Prometheus scrape worker-side counters like qoe_beacons_processed_total.
export function startMetricsServer(port: number) {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } else if (req.url === "/health") {
      res.end('{"status":"ok","role":"worker"}');
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  server.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[worker] metrics on :${port}`);
  });
  return server;
}
