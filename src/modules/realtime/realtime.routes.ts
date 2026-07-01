import type { FastifyInstance } from 'fastify';
import { realtime, type RealtimeEvent } from './broker.js';

// Clients connect to /ws?groupId=... and receive events for that group.
// The board client can connect without a groupId to receive all events.
export async function realtimeRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const groupId = url.searchParams.get('groupId');

    const unsubscribe = realtime.subscribe((event: RealtimeEvent) => {
      // Filter to this client's group if one was specified.
      if (groupId && 'groupId' in event && event.groupId !== groupId) return;
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    socket.on('close', () => unsubscribe());
    socket.send(JSON.stringify({ type: 'connected', groupId }));
  });
}
