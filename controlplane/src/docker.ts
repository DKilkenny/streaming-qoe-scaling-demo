import Docker from "dockerode";
import { config } from "./config";

// Controls the worker pool AND the api pool by CREATING and REMOVING
// containers via the Docker API — not by starting/stopping a pre-scaled
// compose pool. A bare `docker compose up -d` reconciles a service back to
// its declared replica count and deletes anything outside it, so a warm
// pool of stopped containers is fragile: the control plane would have
// nothing left to start. Provisioning real containers on demand (and
// tearing them down on scale-down) survives that, and models an
// ECS/Fargate task lifecycle where "scale" means "run more/fewer tasks",
// not "wake up a standby".
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

let dockerAvailable = true;

// The api pool's compose service name. It's also the Docker network alias
// every api container (compose-created or dynamically-provisioned) must
// carry, since the nginx LB resolves "api" through Docker's embedded DNS
// (see lb/nginx.conf).
const API_SERVICE = "api";

async function poolContainers(service: string): Promise<Docker.ContainerInfo[]> {
  const list = await docker.listContainers({
    all: true,
    filters: {
      label: [
        `com.docker.compose.project=${config.composeProject}`,
        `com.docker.compose.service=${service}`,
      ],
    },
  });
  return list.sort((a, b) => a.Names[0].localeCompare(b.Names[0]));
}

type InstanceState = {
  id: string;
  running: boolean;
  created: number; // epoch seconds (container creation time)
  startedAt: number; // epoch ms (most recent start time)
};

async function inspectPool(service: string): Promise<InstanceState[]> {
  const infos = await poolContainers(service);
  const states: InstanceState[] = [];
  for (const info of infos) {
    try {
      const s = await docker.getContainer(info.Id).inspect();
      states.push({
        id: info.Id,
        // "running" excludes paused; we don't pause instances (a paused
        // worker misses AMQP heartbeats and the broker drops it after ~60s;
        // a paused api container would just hang requests routed to it).
        running: s.State.Running === true && s.State.Paused !== true,
        created: info.Created,
        startedAt: Date.parse(s.State.StartedAt),
      });
    } catch {
      /* container vanished mid-scan */
    }
  }
  return states;
}

/** coldStartMs <= 0 means the service has no cold-start window — every running instance is immediately "active". */
function isPastColdStart(startedAt: number, coldStartMs: number): boolean {
  return Date.now() - startedAt >= coldStartMs;
}

export async function poolSize(): Promise<number> {
  return (await poolContainers(config.workerService)).length;
}

/** Running containers whose cold-start window has elapsed — actually consuming. -1 when docker is unavailable. */
async function activeInstances(service: string, coldStartMs: number): Promise<number> {
  if (!dockerAvailable) return -1;
  try {
    return (await inspectPool(service)).filter((s) => s.running && isPastColdStart(s.startedAt, coldStartMs))
      .length;
  } catch (err) {
    dockerAvailable = false;
    // eslint-disable-next-line no-console
    console.error("[docker] unavailable:", (err as Error).message);
    return -1;
  }
}

/** Running containers still inside their cold-start window — provisioned but not yet consuming. -1 when docker is unavailable. */
async function instancesWarming(service: string, coldStartMs: number): Promise<number> {
  if (!dockerAvailable) return -1;
  try {
    return (await inspectPool(service)).filter((s) => s.running && !isPastColdStart(s.startedAt, coldStartMs))
      .length;
  } catch {
    return -1;
  }
}

export async function activeWorkers(): Promise<number> {
  return activeInstances(config.workerService, config.workerColdStartMs);
}

export async function workersWarming(): Promise<number> {
  return instancesWarming(config.workerService, config.workerColdStartMs);
}

/** Running api containers. Api has no cold-start delay (unless one is added later), so "active" == "running". */
export async function activeApiInstances(): Promise<number> {
  return activeInstances(API_SERVICE, 0);
}

/** 0 for now — api has no cold-start window. Kept symmetric with workersWarming (including the -1-when-unavailable case) in case one is added later. */
export async function apiWarming(): Promise<number> {
  return instancesWarming(API_SERVICE, 0);
}

/**
 * Pick a live container of `service` to clone the spec from — the oldest
 * one (by creation time), which is stable across scale-ups/downs since
 * setDesiredInstances always removes the newest extras first and never
 * drops below the pool minimum. Works whether that's the original
 * compose-created container or (after it's gone) a previously-provisioned
 * dynamic one.
 */
async function referenceContainer(service: string): Promise<Docker.ContainerInspectInfo | undefined> {
  const infos = await poolContainers(service);
  if (infos.length === 0) return undefined;
  const oldest = [...infos].sort((a, b) => a.Created - b.Created)[0];
  try {
    return await docker.getContainer(oldest.Id).inspect();
  } catch {
    return undefined;
  }
}

let dynCounter = 0;

/** Create and start one container of `service`, cloned from a live reference. Returns its id, or undefined on failure. */
async function createInstance(service: string): Promise<string | undefined> {
  let container: Docker.Container | undefined;
  try {
    const ref = await referenceContainer(service);
    if (!ref) {
      // eslint-disable-next-line no-console
      console.error(`[docker] cannot create ${service}: no reference container found`);
      return undefined;
    }
    const networkName = Object.keys(ref.NetworkSettings.Networks ?? {})[0];
    if (!networkName) {
      // eslint-disable-next-line no-console
      console.error(`[docker] cannot create ${service}: reference container has no network`);
      return undefined;
    }

    dynCounter += 1;
    const name = `${config.composeProject}-${service}-dyn-${Date.now()}-${dynCounter}`;
    const labels: Record<string, string> = { ...(ref.Config.Labels ?? {}) };
    // Carry the two labels poolContainers() filters on so this container is
    // discovered like any other pool member, with a container-number that
    // won't collide with compose's own numbering.
    labels["com.docker.compose.project"] = config.composeProject;
    labels["com.docker.compose.service"] = service;
    labels["com.docker.compose.container-number"] = String(1000 + dynCounter);

    container = await docker.createContainer({
      name,
      Image: ref.Config.Image,
      Env: ref.Config.Env,
      Labels: labels,
      Cmd: ref.Config.Cmd,
      Entrypoint: ref.Config.Entrypoint,
      WorkingDir: ref.Config.WorkingDir,
      HostConfig: {
        ...ref.HostConfig,
        NetworkMode: networkName,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {
            // Compose assigns the service name as a network alias
            // automatically for containers IT creates, but containers
            // created directly via the Docker API (like this one) don't
            // get that for free — it has to be set explicitly. Without it,
            // Docker's embedded DNS wouldn't return this container for
            // lookups of "api", and the nginx LB (resolver 127.0.0.11 in
            // lb/nginx.conf) would never route to it. Harmless for
            // workers, which are discovered by label, not DNS.
            Aliases: [service],
          },
        },
      },
    });
    await container.start();
    return container.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[docker] createInstance(${service}) failed:`, (err as Error).message);
    // The container may have been created but never started (or started but
    // this branch was reached some other way) — don't leave a dangling
    // container behind: it would sit outside the running set forever (never
    // cleaned up by scale-down, which only inspects running containers) and
    // could later get picked as the clone reference by `referenceContainer()`
    // despite an incomplete/broken network config, cascading into every
    // future scale-up failing.
    if (container) {
      await container.remove({ force: true }).catch(() => {});
    }
    return undefined;
  }
}

/** Stop and remove one container, ignoring errors (already gone, etc). */
async function removeInstance(id: string): Promise<void> {
  const c = docker.getContainer(id);
  try {
    await c.stop({ t: 3 });
  } catch {
    /* already stopped */
  }
  try {
    await c.remove({ force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Remove stopped containers of `service` left behind by `injectOutage()`
 * (whose recovery path creates fresh containers via `setDesiredWorkers`
 * rather than restarting the stopped ones), so they don't accumulate in
 * `docker ps -a` across repeated outage cycles.
 *
 * Always leaves at least one container behind — running or stopped — so
 * `referenceContainer()` never runs out of a spec to clone: if any instance
 * is currently running, that's a safe reference and every stopped
 * container can go; otherwise the single oldest stopped container is kept
 * as the fallback reference and only the rest are removed.
 */
async function prunePoolStopped(service: string): Promise<void> {
  const states = await inspectPool(service);
  const stopped = states.filter((s) => !s.running);
  if (stopped.length === 0) return;

  const hasRunning = states.some((s) => s.running);
  const toRemove = hasRunning
    ? stopped
    : [...stopped].sort((a, b) => a.created - b.created).slice(1);

  await Promise.all(toRemove.map((w) => removeInstance(w.id)));
}

/** Drive `service`'s pool to `desired` running instances (clamped to [min, max]) by creating/removing containers. Returns the resulting active count. */
async function setDesiredInstances(
  service: string,
  min: number,
  max: number,
  coldStartMs: number,
  desired: number
): Promise<number> {
  const target = Math.max(min, Math.min(max, desired));
  const states = await inspectPool(service);
  const running = states.filter((s) => s.running);

  if (running.length < target) {
    const need = target - running.length;
    await Promise.all(Array.from({ length: need }, () => createInstance(service)));
  } else if (running.length > target) {
    // Remove the newest extras; keep the oldest (the original min set) and
    // never drop below the pool minimum.
    const extras = running.length - target;
    const toRemove = [...running].sort((a, b) => b.created - a.created).slice(0, extras);
    await Promise.all(toRemove.map((w) => removeInstance(w.id)));
  }

  // Bounded cleanup: outage recovery creates new containers rather than
  // restarting stopped ones, so without this, stopped instances would pile
  // up across repeated outage cycles. Runs on every call so cleanup happens
  // as soon as the pool has at least one running instance again; failures
  // here must never break the scale operation itself.
  await prunePoolStopped(service).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[docker] prunePoolStopped(${service}) failed:`, (err as Error).message);
  });

  return activeInstances(service, coldStartMs);
}

/** Drive the worker pool to `desired` running workers by creating/removing containers. Returns the resulting active count. */
export async function setDesiredWorkers(desired: number): Promise<number> {
  return setDesiredInstances(config.workerService, config.minWorkers, config.maxWorkers, config.workerColdStartMs, desired);
}

/** Drive the api pool to `desired` running instances (clamped to [minApi, maxApi]) by creating/removing containers. Returns the resulting active count. */
export async function setDesiredApiInstances(desired: number): Promise<number> {
  return setDesiredInstances(API_SERVICE, config.minApi, config.maxApi, 0, desired);
}

/** Chaos: stop every worker so the queue backs up (a real outage). Recovery is a fresh scale/create, not an unpause. */
export async function injectOutage(): Promise<void> {
  const running = (await inspectPool(config.workerService)).filter((s) => s.running);
  await Promise.all(
    running.map((w) => docker.getContainer(w.id).stop({ t: 3 }).catch(() => {}))
  );
}

/** On boot, reconcile both pools to their minimums — creating instances if none exist. Never depends on pre-stopped containers. */
export async function initPool(): Promise<void> {
  try {
    await setDesiredWorkers(config.minWorkers);
    await setDesiredApiInstances(config.minApi);
  } catch (err) {
    dockerAvailable = false;
    // eslint-disable-next-line no-console
    console.error("[docker] pool init failed:", (err as Error).message);
  }
}

export function isDockerAvailable(): boolean {
  return dockerAvailable;
}
