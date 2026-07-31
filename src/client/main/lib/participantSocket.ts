// Shared Socket.io client factory for the participant page (ai-therapist-18).
//
// The participant's socket is known to never connect through the Cloudflare
// tunnel in some deploys (no `connect`, no `connect_error` — i.e. the
// connection attempt appears to never even fire), while the admin dashboard's
// otherwise-identical socket on the same origin works fine. Nothing in this
// file can fix a network-path issue on its own, but two things ARE
// code-side-fixable and are applied here:
//
//   1. Start the handshake on polling and let engine.io upgrade to websocket,
//      instead of attempting websocket first. A raw Upgrade request through
//      some reverse-proxy paths (including certain Cloudflare Tunnel ingress
//      configs) can be dropped silently, which looks exactly like "no
//      connect, no connect_error" from the client — the initial polling GET
//      that would normally kick off the handshake never completes either
//      because the browser is stuck retrying the upgrade. `['polling',
//      'websocket']` (polling first, matching socket.io's own default) avoids
//      that first attempt being the one kind of request that's blocked.
//   2. Full lifecycle logging (connect / connect_error / disconnect /
//      reconnect_attempt / reconnect_error / reconnect_failed), so the next
//      live session gives real signal instead of silence either way.
//
// Nothing here depends on this socket for correctness: audio is uploaded over
// plain HTTP (see audioUploader.ts) specifically because this channel is
// unreliable, and session abandonment is now also handled server-side via
// sessionLifecycle.service.ts independent of a clean disconnect. This socket
// is used only for remote-termination notices and live crisis messages.
import { io, type Socket } from 'socket.io-client';

export function createParticipantSocket(sessionId: string, label: string): Socket {
  const socket = io({
    // Same-origin only; explicit for clarity and to fail fast/loud rather than
    // silently reflecting an unexpected origin if this file is ever reused.
    withCredentials: true,
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 10,
    timeout: 20000,
  });

  socket.on('connect', () => {
    console.log(`[socket:${label}] connected (${socket.id}); joining session ${sessionId}`);
    socket.emit('session:join', { sessionId });
  });

  socket.on('connect_error', (err) => {
    console.error(`[socket:${label}] connect_error:`, err.message, err);
  });

  socket.on('disconnect', (reason) => {
    console.warn(`[socket:${label}] disconnected:`, reason);
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    console.log(`[socket:${label}] reconnect_attempt #${attempt}`);
  });

  socket.io.on('reconnect', (attempt) => {
    console.log(`[socket:${label}] reconnected after ${attempt} attempt(s); rejoining session ${sessionId}`);
    socket.emit('session:join', { sessionId });
  });

  socket.io.on('reconnect_error', (err) => {
    console.error(`[socket:${label}] reconnect_error:`, err.message);
  });

  socket.io.on('reconnect_failed', () => {
    console.error(`[socket:${label}] reconnect_failed: giving up after max attempts`);
  });

  return socket;
}
