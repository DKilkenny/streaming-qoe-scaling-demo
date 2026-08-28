import amqp from "amqplib";
import { config } from "../config";

// Infer types from the library so we stay compatible across amqplib versions
// (0.10.x renamed the connection type to ChannelModel).
type Conn = Awaited<ReturnType<typeof amqp.connect>>;
type Ch = Awaited<ReturnType<Conn["createChannel"]>>;

let connection: Conn | null = null;
let channel: Ch | null = null;

async function connectWithRetry(retries = 30): Promise<Conn> {
  for (let i = 0; i < retries; i++) {
    try {
      return await amqp.connect(config.rabbitUrl);
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error("rabbitmq not reachable");
}

export async function getChannel(): Promise<Ch> {
  if (channel) return channel;
  connection = await connectWithRetry();
  connection.on("error", (err: Error) =>
    // eslint-disable-next-line no-console
    console.error("[rabbit] connection error:", err.message)
  );
  const ch = await connection.createChannel();
  await ch.assertQueue(config.engagementQueue, { durable: true });
  channel = ch;
  return ch;
}

export async function closeRabbit(): Promise<void> {
  try {
    await channel?.close();
    await connection?.close();
  } catch {
    /* ignore */
  }
}
