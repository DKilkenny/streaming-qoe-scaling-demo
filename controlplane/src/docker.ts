import Docker from "dockerode";
import { config } from "./config";

// Controls the worker pool by STOPPING and STARTING containers (not pause/unpause).
// A started container is a fresh process that opens a live RabbitMQ consumer, so
// scaling up actually adds processing capacity. Pausing was unreliable: a paused
// worker misses AMQP heartbeats, the broker drops it after ~60s, and unpausing
// left a running-but-not-consuming zombie.
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

type WorkerState = { id: string; running: boolean };

async function inspectWorkers(): Promise<WorkerState[]> {
  const infos = await workerContainers();
  const states: WorkerState[] = [];
  for (const info of infos) {
    try {
      const s = await docker.getContainer(info.Id).inspect();
      // "running" excludes paused; we no longer pause, but guard anyway.
      states.push({ id: info.Id, running: s.State.Running === true && s.State.Paused !== true });
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
    return (await inspectWorkers()).filter((s) => s.running).length;
  } catch (err) {
    dockerAvailable = false;
    // eslint-disable-next-line no-console
    console.error("[docker] unavailable:", (err as Error).message);
    return -1;
  }
}

/** Drive the pool to `desired` running workers. Returns the resulting count. */
export async function setDesiredWorkers(desired: number): Promise<number> {
  const target = Math.max(config.minWorkers, Math.min(config.maxWorkers, desired));
  const states = await inspectWorkers();
  const running = states.filter((s) => s.running);
  const stopped = states.filter((s) => !s.running);

  if (running.length < target) {
    // Start stopped containers (fresh process -> live consumer).
    const toStart = stopped.slice(0, target - running.length);
    await Promise.all(
      toStart.map((w) => docker.getContainer(w.id).start().catch(() => {}))
    );
  } else if (running.length > target) {
    // Stop the extras. Workers exit promptly on SIGTERM (see index.ts).
    const toStop = running.slice(target);
    await Promise.all(
      toStop.map((w) => docker.getContainer(w.id).stop({ t: 3 }).catch(() => {}))
    );
  }
  return activeWorkers();
}

/** Chaos: stop every worker so the queue backs up (a real outage). */
export async function injectOutage(): Promise<void> {
  const running = (await inspectWorkers()).filter((s) => s.running);
  await Promise.all(
    running.map((w) => docker.getContainer(w.id).stop({ t: 3 }).catch(() => {}))
  );
}

/** On boot, trim the pool down to the minimum running workers. */
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
