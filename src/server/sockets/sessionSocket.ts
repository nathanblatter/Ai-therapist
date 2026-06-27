import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { Pool } from 'pg';
import { insertMessagesBatch } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('socket');

// Extended socket type with our custom session fields
interface AuthenticatedSocket extends Socket {
  userId?: number;
  username?: string;
  userRole?: string;
}

export function initializeSocketHandlers(io: SocketIOServer, pool: Pool): void {
  const PgSession = connectPgSimple(session);

  // Live audio monitoring: which admin sockets are listening to each session.
  // The participant's browser only tees its assistant audio while at least one
  // admin is listening (on-demand), so we track listeners to start/stop teeing.
  const audioListeners = new Map<string, Set<string>>(); // sessionId → admin socket ids

  function addAudioListener(sessionId: string, socketId: string): boolean {
    let set = audioListeners.get(sessionId);
    if (!set) { set = new Set(); audioListeners.set(sessionId, set); }
    const wasEmpty = set.size === 0;
    set.add(socketId);
    return wasEmpty; // true if this is the first listener
  }

  function removeAudioListener(sessionId: string, socketId: string): boolean {
    const set = audioListeners.get(sessionId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) { audioListeners.delete(sessionId); return true; } // now empty
    return false;
  }

  // Socket.io authentication middleware
  io.use((socket, next) => {
    const req = socket.request as unknown as Express.Request & {
      session?: { userId?: number; username?: string; userRole?: string };
    };

    const sessionMiddleware = session({
      store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
      secret: process.env.SESSION_SECRET ?? 'fallback-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
      }
    });

    const authSocket = socket as AuthenticatedSocket;

    // Cast to any to satisfy express-session's strict Request type requirement;
    // socket.request is an IncomingMessage which is compatible at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionMiddleware(req as any, {} as any, (err: unknown) => {
      if (err) {
        log.error({ err }, 'Session middleware error');
        return next(new Error('Session error'));
      }

      if (req.session?.userId) {
        authSocket.userId = req.session.userId;
        authSocket.username = req.session.username;
        authSocket.userRole = req.session.userRole;
        log.info(`Authenticated: ${authSocket.username} (${authSocket.userRole || 'participant'})`);
        next();
      } else {
        log.info('Anonymous participant connected');
        authSocket.userRole = 'anonymous';
        next();
      }
    });
  });

  // Connection handler
  io.on('connection', (socket) => {
    const authSocket = socket as AuthenticatedSocket;
    const isAdmin = authSocket.userRole === 'therapist' || authSocket.userRole === 'researcher';

    if (isAdmin) {
      log.info(`Admin connected: ${authSocket.username} (${authSocket.id})`);
      authSocket.join('admin-broadcast');
      authSocket.to('admin-broadcast').emit('admin:joined', {
        username: authSocket.username,
        role: authSocket.userRole
      });
    } else {
      log.info(`Participant connected (${authSocket.id})`);
    }

    authSocket.on('session:join', ({ sessionId }: { sessionId: string }) => {
      log.info(`User joining session ${sessionId}`);
      authSocket.join(`session:${sessionId}`);
    });

    authSocket.on('session:leave', ({ sessionId }: { sessionId: string }) => {
      log.info(`User leaving session ${sessionId}`);
      authSocket.leave(`session:${sessionId}`);
    });

    authSocket.on('admin:get-sideband-connections', async () => {
      if (!isAdmin) {
        log.warn(`Unauthorized admin:get-sideband-connections attempt from ${authSocket.id}`);
        return;
      }

      try {
        const { sidebandManager } = await import('../services/sidebandManager.service.js');
        const activeSessions = sidebandManager.getActiveConnections();

        const result = await pool.query<{
          session_id: string;
          openai_call_id: string;
          sideband_connected: boolean;
          sideband_connected_at: Date;
          status: string;
        }>(`
          SELECT
            session_id,
            openai_call_id,
            sideband_connected,
            sideband_connected_at,
            status
          FROM therapy_sessions
          WHERE session_id = ANY($1)
          ORDER BY sideband_connected_at DESC
        `, [activeSessions]);

        const connections = result.rows.map((s) => ({
          sessionId: s.session_id,
          callId: s.openai_call_id,
          connectedAt: s.sideband_connected_at,
          status: s.sideband_connected ? 'connected' : 'disconnected'
        }));

        authSocket.emit('admin:sideband-connections', connections);
      } catch (error) {
        log.error({ err: error }, 'Error fetching sideband connections');
        authSocket.emit('admin:sideband-connections', []);
      }
    });

    authSocket.on('admin:sendMessage', async ({ sessionId, message, messageType }: { sessionId: string; message: string; messageType: string }) => {
      if (!isAdmin) {
        log.warn(`Unauthorized admin:sendMessage attempt from ${authSocket.id}`);
        return;
      }

      log.info(`Admin ${authSocket.username} sending ${messageType} message to session ${sessionId}`);

      authSocket.to(`session:${sessionId}`).emit('admin:message', {
        sessionId,
        message,
        messageType,
        senderName: authSocket.username,
        timestamp: new Date().toISOString()
      });

      const logData = {
        session_id: sessionId,
        role: 'system',
        message_type: `admin_${messageType}`,
        content: message,
        content_redacted: message,
        metadata: {
          admin_username: authSocket.username,
          message_type: messageType,
          sent_at: new Date().toISOString()
        },
        created_at: new Date()
      };

      try {
        await insertMessagesBatch([logData]);
        log.info('Admin message logged to database');
      } catch (err) {
        log.error({ err }, 'Failed to log admin message');
      }
    });

    // ---- Live assistant-audio monitoring ----

    // Admin asks to listen to a session's assistant audio.
    authSocket.on('admin:audio-listen-start', ({ sessionId }: { sessionId: string }) => {
      if (!isAdmin || !sessionId) return;
      authSocket.join(`audio:${sessionId}`);
      const first = addAudioListener(sessionId, authSocket.id);
      if (first) {
        // First listener — tell the participant's browser to start teeing.
        const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
        log.info(`[audio] tee-start → session:${sessionId} (${room?.size ?? 0} sockets in room)`);
        io.to(`session:${sessionId}`).emit('audio:tee-start', { sessionId });
      }
      log.info(`[audio] Admin ${authSocket.username} listening to audio for ${sessionId}`);
    });

    // Admin stops listening.
    authSocket.on('admin:audio-listen-stop', ({ sessionId }: { sessionId: string }) => {
      if (!isAdmin || !sessionId) return;
      authSocket.leave(`audio:${sessionId}`);
      const nowEmpty = removeAudioListener(sessionId, authSocket.id);
      if (nowEmpty) {
        io.to(`session:${sessionId}`).emit('audio:tee-stop', { sessionId });
      }
    });

    // Participant relays a chunk of teed assistant audio. Forward to listeners.
    let audioChunkLogCount = 0;
    authSocket.on('client:audio-chunk', ({ sessionId, pcm, sampleRate }: { sessionId: string; pcm: string; sampleRate: number }) => {
      if (!sessionId || !pcm) return;
      const set = audioListeners.get(sessionId);
      if (!set || set.size === 0) return; // nobody listening; drop
      if (audioChunkLogCount++ % 100 === 0) {
        log.info(`[audio] relaying chunk #${audioChunkLogCount} for ${sessionId} → ${set.size} listener(s), ${pcm.length}b @ ${sampleRate}Hz`);
      }
      authSocket.to(`audio:${sessionId}`).emit('audio:chunk', { sessionId, pcm, sampleRate });
    });

    authSocket.on('disconnect', (reason: string) => {
      log.info(`User disconnected: ${reason}`);
      if (isAdmin) {
        authSocket.to('admin-broadcast').emit('admin:left', { username: authSocket.username });
        // Drop this admin from any audio sessions; stop teeing if last listener.
        for (const [sessionId, set] of audioListeners) {
          if (set.has(authSocket.id)) {
            const nowEmpty = removeAudioListener(sessionId, authSocket.id);
            if (nowEmpty) io.to(`session:${sessionId}`).emit('audio:tee-stop', { sessionId });
          }
        }
      }
    });
  });
}
