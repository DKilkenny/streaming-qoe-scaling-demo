import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

// Real load against the discovery API. Runs in a container on the compose
// network so it never touches your home uplink:
//   docker compose run --rm -e BASE_URL=http://api:3000 k6 run /scripts/discover.js
//
// Tunables (env):
//   PEAK_VUS   peak concurrent virtual users   (default 200)
//   RAMP       seconds to ramp to peak         (default 45)
//   HOLD       seconds to hold at peak         (default 60)

const BASE = __ENV.BASE_URL || "http://api:3000";
const PEAK = Number(__ENV.PEAK_VUS || 200);
const RAMP = Number(__ENV.RAMP || 45);
const HOLD = Number(__ENV.HOLD || 60);

const errorRate = new Rate("app_errors");

export const options = {
  scenarios: {
    browse: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: `${RAMP}s`, target: PEAK },
        { duration: `${HOLD}s`, target: PEAK },
        { duration: "20s", target: 0 },
      ],
      gracefulStop: "10s",
    },
  },
  thresholds: {
    // SLO the demo is arguing for: reads stay fast under load.
    http_req_duration: ["p(95)<250", "p(99)<600"],
    app_errors: ["rate<0.01"],
  },
};

// Grab a working set of title IDs so detail/event calls hit real rows.
export function setup() {
  const res = http.get(`${BASE}/discover`);
  const ids = [];
  try {
    const body = JSON.parse(res.body);
    for (const rail of body.rails || []) {
      for (const t of rail.titles || []) ids.push(t.id);
    }
  } catch (_e) {
    /* ignore */
  }
  return { ids: [...new Set(ids)] };
}

const TERMS = ["the", "last", "golden", "silent", "rising", "faithful"];

export default function (data) {
  const ids = data.ids || [];

  // Traffic mix skewed the way a streaming home screen actually behaves:
  // mostly discover, some detail, some search, a steady trickle of events.
  const roll = Math.random();

  if (roll < 0.55) {
    const res = http.get(`${BASE}/discover`, { tags: { name: "discover" } });
    check(res, { "discover 200": (r) => r.status === 200 }) ||
      errorRate.add(1);
  } else if (roll < 0.8 && ids.length) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const res = http.get(`${BASE}/titles/${id}`, {
      tags: { name: "title_detail" },
    });
    check(res, { "detail 200": (r) => r.status === 200 }) || errorRate.add(1);
  } else if (roll < 0.92) {
    const q = TERMS[Math.floor(Math.random() * TERMS.length)];
    const res = http.get(`${BASE}/search?q=${q}`, { tags: { name: "search" } });
    check(res, { "search ok": (r) => r.status === 200 }) || errorRate.add(1);
  } else if (ids.length) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const type = Math.random() < 0.3 ? "complete" : "play";
    const res = http.post(
      `${BASE}/events`,
      JSON.stringify({ titleId: id, type }),
      { headers: { "Content-Type": "application/json" }, tags: { name: "event" } }
    );
    check(res, { "event 202": (r) => r.status === 202 }) || errorRate.add(1);
  }

  sleep(Math.random() * 0.5);
}
