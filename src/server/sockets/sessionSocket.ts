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

    // ---- Live audio monitoring + recording ----
    //
    // The participant's browser mixes mic + assistant audio and tees a single
    // PCM16 stream for the whole session (always-on, so we can record it). The
    // server records every session to object storage and additionally relays
    // chunks live to any admin who has joined the session's audio room.

    // Admin joins/leaves a session's live audio room.
    authSocket.on('admin:audio-listen-start', ({ sessionId }: { sessionId: string }) => {
      if (!isAdmin || !sessionId) return;
      authSocket.join(`audio:${sessionId}`);
      log.info(`[audio] ${authSocket.username} listening live to ${sessionId}`);
    });

    authSocket.on('admin:audio-listen-stop', ({ sessionId }: { sessionId: string }) => {
      if (!sessionId) return;
      authSocket.leave(`audio:${sessionId}`);
    });

    // NOTE: participant audio is ingested over HTTP (POST /api/sessions/:id/audio
    // in sessions.routes.ts), not via this socket — the participant's Socket.io
    // connection is unreliable through the tunnel. That route appends to the
    // recording and relays 'audio:chunk' to the audio:<sessionId> room above.

    authSocket.on('disconnect', (reason: string) => {
      log.info(`User disconnected: ${reason}`);
      if (isAdmin) {
        authSocket.to('admin-broadcast').emit('admin:left', { username: authSocket.username });
      }
    });
  });
}
