import Fastify from "fastify";
import { config } from "./config";
import { registry, httpRequestDuration } from "./telemetry";
import { waitForDb } from "./lib/db";
import { getChannel } from "./lib/rabbit";
import { catalogRoutes } from "./routes/catalog";
import { discoverRoutes } from "./routes/discover";
import { searchRoutes } from "./routes/search";
import { eventRoutes } from "./routes/events";

export async function startServer() {
  const app = Fastify({ logger: { level: "warn" } });

  // Per-request latency into the Prometheus histogram. Route label uses the
  // matched route pattern (e.g. /titles/:id) so cardinality stays bounded.
  app.addHook("onResponse", async (req, reply) => {
    const route = (req.routeOptions?.url as string) ?? req.url ?? "unknown";
    httpRequestDuration
      .labels(req.method, route, String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  app.get("/health", async () => ({ status: "ok", role: config.role }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  await app.register(catalogRoutes);
  await app.register(discoverRoutes);
  await app.register(searchRoutes);
  await app.register(eventRoutes);

  await waitForDb();
  await getChannel(); // establish the publish channel up front

  await app.listen({ port: config.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${config.port}`);
}
