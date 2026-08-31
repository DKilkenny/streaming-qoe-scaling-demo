import Docker from "dockerode";
import { config } from "./config";

// Controls the worker pool by CREATING and REMOVING containers via the Docker
// API — not by starting/stopping a pre-scaled compose pool. A bare
// `docker compose up -d` reconciles the `worker` service back to its
// declared replica count and deletes anything outside it, so a warm pool of
// stopped containers is fragile: the control plane would have nothing left
// to start. Provisioning real containers on demand (and tearing them down on
// scale-down) survives that, and models an ECS/Fargate task lifecycle where
// "scale" means "run more/fewer tasks", not "wake up a standby".
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

let dockerAvailable = true;

async function workerContainers(): Promise<Docker.ContainerInfo[]> {
  const list = await docker.listContainers({
    all: true,
    filters: {
      label: [
        `com.docker.compose.project=${config.composeProject}`,
        `com.docker.compose.service=${config.workerService}`,
      ],
    },
  });
  return list.sort((a, b) => a.Names[0].localeCompare(b.Names[0]));
}

type WorkerState = {
  id: string;
  running: boolean;
  created: number; // epoch seconds (container creation time)
  startedAt: number; // epoch ms (most recent start time)
};

async function inspectWorkers(): Promise<WorkerState[]> {
  const infos = await workerContainers();
  const states: WorkerState[] = [];
  for (const info of infos) {
    try {
      const s = await docker.getContainer(info.Id).inspect();
      states.push({
        id: info.Id,
        // "running" excludes paused; we don't pause workers (a paused worker
        // misses AMQP heartbeats and the broker drops it after ~60s).
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

function isPastColdStart(startedAt: number): boolean {
  return Date.now() - startedAt >= config.workerColdStartMs;
}

export async function poolSize(): Promise<number> {
  return (await workerContainers()).length;
}

/** Running containers whose cold-start window has elapsed — actually consuming. */
export async function activeWorkers(): Promise<number> {
  if (!dockerAvailable) return -1;
  try {
    return (await inspectWorkers()).filter((s) => s.running && isPastColdStart(s.startedAt))
      .length;
  } catch (err) {
    dockerAvailable = false;
    // eslint-disable-next-line no-console
    console.error("[docker] unavailable:", (err as Error).message);
    return -1;
  }
}

/** Running containers still inside their cold-start window — provisioned but not yet consuming. */
export async function workersWarming(): Promise<number> {
  if (!dockerAvailable) return -1;
  try {
    return (await inspectWorkers()).filter((s) => s.running && !isPastColdStart(s.startedAt))
      .length;
  } catch {
    return -1;
  }
}

/**
 * Pick a live worker container to clone the spec from — the oldest one
 * (by creation time), which is stable across scale-ups/downs since
 * setDesiredWorkers always removes the newest extras first and never drops
 * below minWorkers. Works whether that's the original compose-created
 * container or (after it's gone) a previously-provisioned dynamic one.
 */
async function referenceContainer(): Promise<Docker.ContainerInspectInfo | undefined> {
  const infos = await workerContainers();
  if (infos.length === 0) return undefined;
  const oldest = [...infos].sort((a, b) => a.Created - b.Created)[0];
  try {
    return await docker.getContainer(oldest.Id).inspect();
  } catch {
    return undefined;
  }
}

let dynCounter = 0;

/** Create and start one worker container, cloned from a live reference. Returns its id, or undefined on failure. */
async function createWorker(): Promise<string | undefined> {
  let container: Docker.Container | undefined;
  try {
    const ref = await referenceContainer();
    if (!ref) {
      // eslint-disable-next-line no-console
      console.error("[docker] cannot create worker: no reference container found");
      return undefined;
    }
    const networkName = Object.keys(ref.NetworkSettings.Networks ?? {})[0];
    if (!networkName) {
      // eslint-disable-next-line no-console
      console.error("[docker] cannot create worker: reference container has no network");
      return undefined;
    }

    dynCounter += 1;
    const name = `${config.composeProject}-${config.workerService}-dyn-${Date.now()}-${dynCounter}`;
    const labels: Record<string, string> = { ...(ref.Config.Labels ?? {}) };
    // Carry the two labels workerContainers() filters on so this container is
    // discovered like any other worker, with a container-number that won't
    // collide with compose's own numbering.
    labels["com.docker.compose.project"] = config.composeProject;
    labels["com.docker.compose.service"] = config.workerService;
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
          [networkName]: {},
        },
      },
    });
    await container.start();
    return container.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[docker] createWorker failed:", (err as Error).message);
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

/** Stop and remove one worker container, ignoring errors (already gone, etc). */
async function removeWorker(id: string): Promise<void> {
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

/** Drive the pool to `desired` running workers by creating/removing containers. Returns the resulting active count. */
export async function setDesiredWorkers(desired: number): Promise<number> {
  const target = Math.max(config.minWorkers, Math.min(config.maxWorkers, desired));
  const states = await inspectWorkers();
  const running = states.filter((s) => s.running);

  if (running.length < target) {
    const need = target - running.length;
    await Promise.all(Array.from({ length: need }, () => createWorker()));
  } else if (running.length > target) {
    // Remove the newest extras; keep the oldest (the original minWorkers set)
    // and never drop below minWorkers.
    const extras = running.length - target;
    const toRemove = [...running].sort((a, b) => b.created - a.created).slice(0, extras);
    await Promise.all(toRemove.map((w) => removeWorker(w.id)));
  }
  return activeWorkers();
}

/** Chaos: stop every worker so the queue backs up (a real outage). Recovery is a fresh scale/create, not an unpause. */
export async function injectOutage(): Promise<void> {
  const running = (await inspectWorkers()).filter((s) => s.running);
  await Promise.all(
    running.map((w) => docker.getContainer(w.id).stop({ t: 3 }).catch(() => {}))
  );
}

/** On boot, reconcile to minWorkers — creating one if none exist. Never depends on pre-stopped containers. */
export async function initPool(): Promise<void> {
  try {
    await setDesiredWorkers(config.minWorkers);
  } catch (err) {
    dockerAvailable = false;
    // eslint-disable-next-line no-console
    console.error("[docker] pool init failed:", (err as Error).message);
  }
}

export function isDockerAvailable(): boolean {
  return dockerAvailable;
}
