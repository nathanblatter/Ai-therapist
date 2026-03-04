import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { insertMessagesBatch } from '../models/dbQueries.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('socket');

export function initializeSocketHandlers(io, pool) {
  const PgSession = connectPgSimple(session);

  // Socket.io authentication middleware
  io.use((socket, next) => {
    const req = socket.request;

    const sessionMiddleware = session({
      store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
      }
    });

    sessionMiddleware(req, {}, (err) => {
      if (err) {
        log.error({ err }, 'Session middleware error');
        return next(new Error('Session error'));
      }

      if (req.session?.userId) {
        socket.userId = req.session.userId;
        socket.username = req.session.username;
        socket.userRole = req.session.userRole;
        log.info(`Authenticated: ${socket.username} (${socket.userRole || 'participant'})`);
        next();
      } else {
        log.info('Anonymous participant connected');
        socket.userRole = 'anonymous';
        next();
      }
    });
  });

  // Connection handler
  io.on('connection', (socket) => {
    const isAdmin = socket.userRole === 'therapist' || socket.userRole === 'researcher';

    if (isAdmin) {
      log.info(`Admin connected: ${socket.username} (${socket.id})`);
      socket.join('admin-broadcast');
      socket.to('admin-broadcast').emit('admin:joined', {
        username: socket.username,
        role: socket.userRole
      });
    } else {
      log.info(`Participant connected (${socket.id})`);
    }

    socket.on('session:join', ({ sessionId }) => {
      log.info(`User joining session ${sessionId}`);
      socket.join(`session:${sessionId}`);
    });

    socket.on('session:leave', ({ sessionId }) => {
      log.info(`User leaving session ${sessionId}`);
      socket.leave(`session:${sessionId}`);
    });

    socket.on('admin:get-sideband-connections', async () => {
      if (!isAdmin) {
        log.warn(`Unauthorized admin:get-sideband-connections attempt from ${socket.id}`);
        return;
      }

      try {
        const { sidebandManager } = await import('../services/sidebandManager.service.js');
        const activeSessions = sidebandManager.getActiveConnections();

        const result = await pool.query(`
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

        const connections = result.rows.map(s => ({
          sessionId: s.session_id,
          callId: s.openai_call_id,
          connectedAt: s.sideband_connected_at,
          status: s.sideband_connected ? 'connected' : 'disconnected'
        }));

        socket.emit('admin:sideband-connections', connections);
      } catch (error) {
        log.error({ err: error }, 'Error fetching sideband connections');
        socket.emit('admin:sideband-connections', []);
      }
    });

    socket.on('admin:sendMessage', async ({ sessionId, message, messageType }) => {
      if (!isAdmin) {
        log.warn(`Unauthorized admin:sendMessage attempt from ${socket.id}`);
        return;
      }

      log.info(`Admin ${socket.username} sending ${messageType} message to session ${sessionId}`);

      socket.to(`session:${sessionId}`).emit('admin:message', {
        sessionId,
        message,
        messageType,
        senderName: socket.username,
        timestamp: new Date().toISOString()
      });

      const logData = {
        session_id: sessionId,
        role: 'system',
        message_type: `admin_${messageType}`,
        content: message,
        content_redacted: message,
        metadata: {
          admin_username: socket.username,
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

    socket.on('disconnect', (reason) => {
      log.info(`User disconnected: ${reason}`);
      if (isAdmin) {
        socket.to('admin-broadcast').emit('admin:left', { username: socket.username });
      }
    });
  });
}
