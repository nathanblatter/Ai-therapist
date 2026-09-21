// WebSocket upgrade handling for the Grok Voice proxy (docs/grok-voice.md).
//
// Socket.io and Vite's HMR each attach their own 'upgrade' listener to the
// shared HTTP server and ignore paths that are not theirs; this adds a third
// for /api/grok/voice/<session_id>. Authentication reuses the express-session
// middleware exactly the way the Socket.io handshake does, then applies the
// same ownership rule as every session route (utils/sessionOwnership.ts):
// the cookie's ownedSessions list for anonymous participants, user_id for
// logged-in ones, admins always. Anything else gets an HTTP error on the raw
// socket and no WebSocket.

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request, RequestHandler, Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { GROK_VOICE_WS_PATH } from '../../shared/grokVoiceProtocol.js';

/** Session id from a request URL, or null when the path is not ours. */
export function parseGrokVoicePath(url: string | undefined): string | null {
  if (!url) return null;
  const pathOnly = url.split('?')[0];
  if (!pathOnly.startsWith(GROK_VOICE_WS_PATH)) return null;
  const rest = pathOnly.slice(GROK_VOICE_WS_PATH.length);
  if (!rest || rest.includes('/')) return null;
  try {
    const id = decodeURIComponent(rest);
    return /^grok_[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* socket already gone */ }
  socket.destroy();
}

export interface GrokUpgradeDeps {
  sessionMiddleware: RequestHandler;
  /** Ownership check, injected so this module stays free of DB imports. */
  canAccess: (req: Request, sessionId: string) => Promise<boolean>;
  onClient: (sessionId: string, ws: WebSocket) => Promise<void>;
}

/**
 * Attach the upgrade listener. Returns the WebSocketServer so a shutdown can
 * close it. Requests for other paths are ignored (not destroyed) — Socket.io
 * and Vite handle theirs on their own listeners.
 */
export function attachGrokVoiceUpgrade(httpServer: HttpServer, deps: GrokUpgradeDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const sessionId = parseGrokVoicePath(req.url);
    if (!sessionId) return;

    socket.on('error', err => console.warn('[Grok] upgrade socket error:', err.message));

    // Load the express-session from the cookie. express-session only needs a
    // response object for Set-Cookie on new sessions, which never happens here
    // (saveUninitialized is false), so an empty object suffices — the Socket.io
    // handshake in index.ts does exactly the same.
    deps.sessionMiddleware(req as unknown as Request, {} as Response, (err?: unknown) => {
      if (err) {
        console.error('[Grok] Session middleware error on upgrade:', err);
        return rejectUpgrade(socket, 500, 'Session error');
      }
      deps.canAccess(req as unknown as Request, sessionId)
        .then(ok => {
          if (!ok) {
            console.warn(`[Grok] Upgrade denied for ${sessionId.substring(0, 12)}...: not the session owner`);
            return rejectUpgrade(socket, 403, 'Forbidden');
          }
          wss.handleUpgrade(req, socket, head, ws => {
            deps.onClient(sessionId, ws).catch(e => {
              console.error(`[Grok] Client attach failed for ${sessionId.substring(0, 12)}...:`, e);
              try { ws.close(1011, 'attach failed'); } catch { /* ignore */ }
            });
          });
        })
        .catch(e => {
          console.error('[Grok] Ownership check failed on upgrade:', e);
          rejectUpgrade(socket, 500, 'Access check failed');
        });
    });
  });

  return wss;
}
