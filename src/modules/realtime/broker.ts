import { makeRedis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';

// Lightweight pub/sub broker. The API server publishes domain events to Redis;
// every server instance subscribes and fans out to its connected WebSocket
// clients. This keeps realtime working across multiple API instances behind a
// load balancer (the reason we don't just hold sockets in memory on one box).

export type RealtimeEvent =
  | { type: 'group.updated'; groupId: string }
  | { type: 'group.locked'; groupId: string; targetReadyAt: string }
  | { type: 'ticket.updated'; groupId: string; ticketId: string; status: string };

type Handler = (event: RealtimeEvent) => void;

const CHANNEL = 'foodhall:events';

class RealtimeBroker {
  private pub = makeRedis();
  private sub = makeRedis();
  private handlers = new Set<Handler>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.sub.subscribe(CHANNEL).catch((err) => logger.error({ err }, 'subscribe failed'));
    this.sub.on('message', (_channel, message) => {
      try {
        const event = JSON.parse(message) as RealtimeEvent;
        for (const h of this.handlers) h(event);
      } catch (err) {
        logger.error({ err }, 'failed to parse realtime event');
      }
    });
  }

  async publish(event: RealtimeEvent) {
    await this.pub.publish(CHANNEL, JSON.stringify(event));
  }

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Close both Redis connections. Used by integration-test teardown; long-
  // running processes never call this.
  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export const realtime = new RealtimeBroker();
