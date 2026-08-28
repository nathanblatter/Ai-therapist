// Persistent authenticated socket for the logged-in participant surface
// (caseworker portal messaging, docs/caseworker-portal.md section 4).
//
// The server joins every authenticated socket to its `user:<id>` room on
// connect (integration wiring in src/server/index.ts); that room carries ONLY
// messaging events (messaging:new-message / messaging:read /
// messaging:thread-frozen / messaging:message-scanned).
//
// IMPORTANT: this socket is latency sugar, never load-bearing. The known
// tunnel flakiness (see participantSocket.ts) means some deploys never get a
// participant websocket at all, so useMessaging.ts always HTTP-polls (on view
// focus + every 60s while the Messages view is open) and merely refreshes
// faster when a socket event lands. Same polling-first transport order as
// participantSocket.ts so the handshake survives proxy paths that drop raw
// Upgrade requests.
import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Get (lazily creating) the shared authenticated user socket. */
export function getUserSocket(): Socket {
  if (socket) return socket;

  socket = io({
    withCredentials: true,
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    // Unlike the session socket this one lives for the whole logged-in visit,
    // so keep retrying indefinitely (each attempt is cheap; polling fallback
    // in useMessaging covers correctness regardless).
    reconnectionAttempts: Infinity,
    timeout: 20000,
  });

  socket.on('connect', () => {
    console.log(`[socket:user] connected (${socket?.id})`);
  });
  socket.on('connect_error', (err) => {
    console.warn('[socket:user] connect_error (messaging falls back to polling):', err.message);
  });
  socket.on('disconnect', (reason) => {
    console.warn('[socket:user] disconnected:', reason);
  });

  return socket;
}

/** Tear down the shared socket (logout). */
export function closeUserSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
