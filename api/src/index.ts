// otel MUST be the first import so instrumentation patches libraries before they load.
import "./otel";
import { config } from "./config";

// Lazy-load per role so the worker process never pulls in the HTTP server (and
// its Redis client), and the API never loads the consumer. Each process holds
// only the connections it actually uses.
async function main() {
  if (config.role === "worker") {
    const { startWorker } = await import("./worker");
    await startWorker();
  } else {
    const { startServer } = await import("./server");
    await startServer();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
