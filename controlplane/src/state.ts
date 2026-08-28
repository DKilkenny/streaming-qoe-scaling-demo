// Small ring buffer of notable events. The Console shows it as an activity feed,
// and the AI incident explainer reads it for context.
export type Event = { ts: number; kind: string; detail: string };

const MAX = 60;
const events: Event[] = [];

export function logEvent(kind: string, detail: string) {
  events.push({ ts: Date.now(), kind, detail });
  if (events.length > MAX) events.shift();
  // eslint-disable-next-line no-console
  console.log(`[event] ${kind}: ${detail}`);
}

export function recentEvents(n = 20): Event[] {
  return events.slice(-n);
}
