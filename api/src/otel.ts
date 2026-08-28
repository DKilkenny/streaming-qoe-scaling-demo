// Loaded FIRST (before any instrumented library) so OpenTelemetry can patch
// pg / ioredis / amqplib / http. Tracing is opt-in via OTEL_ENABLED so the
// service runs identically with or without a collector attached. Prometheus
// metrics (see telemetry.ts) are always on and are what the Grafana dashboard
// reads; OTel here adds distributed traces when you point it at a collector
// (Grafana Cloud, a Datadog agent via OTLP, etc.).
import { config } from "./config";

if (config.otelEnabled) {
  // Require lazily so the (large) OTel tree only loads when actually enabled.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const {
    getNodeAutoInstrumentations,
  } = require("@opentelemetry/auto-instrumentations-node");
  const {
    OTLPTraceExporter,
  } = require("@opentelemetry/exporter-trace-otlp-http");
  const { Resource } = require("@opentelemetry/resources");
  const {
    SemanticResourceAttributes,
  } = require("@opentelemetry/semantic-conventions");

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: `streaming-${config.role}`,
    }),
    traceExporter: new OTLPTraceExporter(
      config.otelEndpoint ? { url: `${config.otelEndpoint}/v1/traces` } : {}
    ),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
  // eslint-disable-next-line no-console
  console.log(`[otel] tracing enabled for streaming-${config.role}`);
}
