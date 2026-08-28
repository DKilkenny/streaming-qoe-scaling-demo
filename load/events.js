import http from "k6/http";
import { check } from "k6";

// Event-storm: pushes engagement events far past one worker's drain rate so the
// RabbitMQ queue visibly backs up, then drains when you add workers:
//   docker compose run --rm k6 run /scripts/events.js
//   # in another terminal, mid-run:
//   docker compose up -d --scale worker=4 --no-recreate
//
// Tunables: PEAK_RATE (events/s at peak), RAMP, HOLD.
const BASE = __ENV.BASE_URL || "http://api:3000";
const PEAK_RATE = Number(__ENV.PEAK_RATE || 6000);
const RAMP = Number(__ENV.RAMP || 30);
const HOLD = Number(__ENV.HOLD || 40);

export const options = {
  scenarios: {
    storm: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 800,
      stages: [
        { duration: `${RAMP}s`, target: PEAK_RATE },
        { duration: `${HOLD}s`, target: PEAK_RATE },
        { duration: "10s", target: 0 },
      ],
    },
  },
};

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

export default function (data) {
  const ids = data.ids || [];
  if (!ids.length) return;
  const id = ids[Math.floor(Math.random() * ids.length)];
  const type = Math.random() < 0.3 ? "complete" : "play";
  const res = http.post(
    `${BASE}/events`,
    JSON.stringify({ titleId: id, type }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, { "202": (r) => r.status === 202 });
}
