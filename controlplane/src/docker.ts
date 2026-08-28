import Docker from "dockerode";
import { config } from "./config";

// Controls a warm pool of worker containers by pausing/unpausing them. Activating
// a paused worker is near-instant, which models a pre-provisioned capacity pool
// (how you get fast scale-up without cold-start). "Active" = running and unpaused.
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
  // Stable ordering so scale decisions are deterministic across calls.
  return list.sort((a, b) => a.Id.localeCompare(b.Id));
}

type WorkerState = { id: string; running: boolean; paused: boolean };

async function inspectWorkers(): Promise<WorkerState[]> {
  const infos = await workerContainers();
  const states: WorkerState[] = [];
  for (const info of infos) {
    try {
      const s = await docker.getContainer(info.Id).inspect();
      states.push({
        id: info.Id,
        running: s.State.Running === true,
        paused: s.State.Paused === true,
      });
    } catch {
      /* container vanished mid-scan */
    }
  }
  return states;
}

export async function poolSize(): Promise<number> {
  return (await workerContainers()).length;
}

export async function activeWorkers(): Promise<number> {
  if (!dockerAvailable) return -1;
  try {
    const states = await inspectWorkers();
    return states.filter((s) => s.running && !s.paused).length;
  } catch (err) {
    dockerAvailable = false;
    // eslint-disable-next-line no-console
    console.error("[docker] unavailable:", (err as Error).message);
    return -1;
  }
}

/** Drive the pool to `desired` active workers. Returns the resulting active count. */
export async function setDesiredWorkers(desired: number): Promise<number> {
  const target = Math.max(config.minWorkers, Math.min(config.maxWorkers, desired));
  const states = await inspectWorkers();

  const active = states.filter((s) => s.running && !s.paused);
  const inactive = states.filter((s) => !s.running || s.paused);

  if (active.length < target) {
    // Activate paused/stopped workers up to target.
    const toActivate = inactive.slice(0, target - active.length);
    for (const w of toActivate) {
      const c = docker.getContainer(w.id);
      try {
        if (!w.running) await c.start();
        else if (w.paused) await c.unpause();
      } catch {
        /* ignore */
      }
    }
  } else if (active.length > target) {
    // Pause the extras (keep them warm, do not stop).
    const toPause = active.slice(target);
    for (const w of toPause) {
      try {
        await docker.getContainer(w.id).pause();
      } catch {
        /* ignore */
      }
    }
  }
  return activeWorkers();
}

/** Chaos: pause every worker so the queue backs up. */
export async function pauseAllWorkers(): Promise<void> {
  const states = await inspectWorkers();
  for (const w of states.filter((s) => s.running && !s.paused)) {
    try {
      await docker.getContainer(w.id).pause();
    } catch {
      /* ignore */
    }
  }
}

/** On boot, trim the warm pool down to the minimum active workers. */
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
