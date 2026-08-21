import express, { type Request, type Response } from "express";
import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import session, { type Session, type SessionData } from "express-session";
import type { IncomingMessage } from "http";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { randomUUID } from "crypto";
import { opsMetricsMiddleware } from "./services/opsMetrics.service.js";
import { createAdapter as createPostgresAdapter } from "@socket.io/postgres-adapter";
import {pool } from "./config/db.js";
import { requireRole } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { insertMessagesBatch, getSidebandConnectionsByIds, getSessionAccessInfo } from "./db/index.js";
import configRoutes from "./routes/public/config.routes.js";
import voicesRoutes from "./routes/public/voices.routes.js";
import authRoutes from "./routes/public/auth.routes.js";
import magicLinkRoutes from "./routes/public/magicLink.routes.js";
import demoRoutes from "./routes/demo.routes.js";
import { canAdminAccessSessionLive } from "./middleware/caseload.js";
import { getCaseloadClientIds } from "./db/index.js";
import mfaRoutes from "./routes/public/mfa.routes.js";
import usersRoutes from "./routes/public/users.routes.js";
import healthRoutes from "./routes/public/health.routes.js";
import bugReportRoutes from "./routes/public/bugReport.routes.js";
import contentRetentionRoutes from "./routes/admin/contentRetention.routes.js";
import userSessionsRoutes from "./routes/admin/userSessions.routes.js";
import crisisRoutes from "./routes/admin/crisis.routes.js";
import adverseEventsRoutes from "./routes/admin/adverseEvents.routes.js";
import redactionRoutes from "./routes/admin/redaction.routes.js";
import adminConfigRoutes from "./routes/admin/config.routes.js";
import analyticsRoutes from "./routes/admin/analytics.routes.js";
import studyOpsRoutes from "./routes/admin/studyOps.routes.js";
import exportRoutes from "./routes/admin/export.routes.js";
import adminRateLimitsRoutes from "./routes/admin/rateLimits.routes.js";
import rateLimitsRoutes from "./routes/public/rateLimits.routes.js";
import adminSessionsRoutes from "./routes/admin/sessions.routes.js";
import sidebandRoutes from "./routes/admin/sideband.routes.js";
import insightsRoutes from "./routes/admin/insights.routes.js";
import participantProfileRoutes from "./routes/admin/participantProfile.routes.js";
import knowledgeRoutes from "./routes/admin/knowledge.routes.js";
import prepRoutes from "./routes/admin/prep.routes.js";
import evalsRoutes from "./routes/admin/evals.routes.js";
import chatRoutes from "./routes/public/chat.routes.js";
import sessionsRoutes from "./routes/public/sessions.routes.js";
import tokenRoutes from "./routes/public/token.routes.js";
import logsRoutes from "./routes/public/logs.routes.js";
import clientEventsRoutes from "./routes/public/clientEvents.routes.js";
import opsRoutes from "./routes/admin/ops.routes.js";
import consentRoutes from "./routes/public/consent.routes.js";
import progressRoutes from "./routes/public/progress.routes.js";
import adminConsentRoutes from "./routes/admin/consent.routes.js";
import caseloadRoutes from "./routes/admin/caseload.routes.js";
import invitesRoutes from "./routes/admin/invites.routes.js";
import joinRoutes from "./routes/join.routes.js";
import { restrictParticipantsToUs } from "./middleware/ipFilter.js";
import { startScheduler as startContentWipeScheduler } from "./services/contentWipe.service.js";
import { startScheduler as startDataRetentionScheduler } from "./services/dataRetention.service.js";
import { startDemoCleanupScheduler } from "./services/demoCleanup.service.js";
import { noteSessionActivity, scheduleAbandonCheck, startAbandonedSessionSweeper } from "./services/sessionLifecycle.service.js";

// ---------- local type helpers ----------

/** Minimal typed request used inside socket.io session middleware */
type SessionRequest = IncomingMessage & {
  session: Session & Partial<SessionData>;
};

/** Socket with extra per-connection fields we attach after auth */
interface AuthSocket extends Socket {
  userId?: number;
  username?: string;
  userRole?: string;
}

// ES module-compatible __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



const app = express();

// Trust first proxy (Cloudflare Tunnel / cloudflared) for secure cookies and correct client IP
app.set('trust proxy', 1);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    // Same-origin requests never need CORS headers, so production defaults to
    // denying cross-origin entirely (`false`). `origin: true` would reflect
    // ANY origin with credentials — never do that.
    origin: process.env.NODE_ENV === 'production'
      ? (process.env.CORS_ORIGIN || false)
      : 'http://localhost:5173',
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Fan socket.io packets (rooms/broadcasts: admin-broadcast, session:<id>, etc.)
// out across processes via Postgres NOTIFY/LISTEN. Without this, a blue-green
// deploy window with two app containers briefly running loses events between
// sockets connected to different containers — a participant's `messages:new`
// might land on the old container while the admin watching is on the new one.
// Uses the same pg pool as everything else; failures here are logged but never
// crash the process (in-memory adapter still works for same-container rooms).
// The eval harness (redteam cli/replay) boots this app in a CHILD process
// against the same DB and sets SOCKET_PG_ADAPTER=off — without that, its
// crisis emissions would fan out through Postgres to real admin dashboards.
if (process.env.SOCKET_PG_ADAPTER !== 'off') {
  io.adapter(createPostgresAdapter(pool));
}
pool.on('error', (err) => {
  console.error('[Postgres adapter] pool error:', err);
});

// Make 'io' available globally for event emission
global.io = io;

const port = process.env.PORT || 3067;


// Language instructions are now stored in the database system_config table
// They will be loaded dynamically from the 'languages' config

// Session config + limits (getSystemConfig/getSystemPrompt/checkSessionLimits)
// live in utils/sessionHelpers.ts and are used directly by the route modules.

// SLC timezone helpers (getNextMidnightSLC/getHoursUntilReset/getStartOfTodaySLC)
// live in utils/timezoneHelpers.ts and are used by the rate-limit route modules.

// Security headers. CSP runs in REPORT-ONLY mode by default (production only).
// Violations are POSTed to /csp-report and logged.
//
// CSP Enforcement flow:
// 1. Deployed with CSP_ENFORCE=false (default) — policy runs in report-only mode,
//    collecting violations at /csp-report.
// 2. Once violation logs are clean, set CSP_ENFORCE=true to flip to enforcement
//    (reject inline scripts/styles that violate the policy).
//
// Violations occur when:
// - Inline scripts lack nonces (SSR scripts, demo notice bootstraps, etc.)
// - Inline styles without nonces or 'unsafe-inline' (currently allowed for Tailwind/Recharts)
// - External resources from unauthorized origins
//
// script-src deliberately omits 'unsafe-inline' so violations reveal exactly which
// inline scripts and styles still need nonces.

const CSP_ENFORCE = process.env.CSP_ENFORCE === 'true';

app.use(helmet({ contentSecurityPolicy: false }));
if (process.env.NODE_ENV === 'production') {
  app.use(
    helmet.contentSecurityPolicy({
      useDefaults: false,
      reportOnly: !CSP_ENFORCE,  // report-only by default; set CSP_ENFORCE=true to enforce
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"], // Tailwind/Recharts inline styles (TODO: migrate to nonces)
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'font-src': ["'self'", 'data:'],
        // Same-origin API/socket.io + OpenAI Realtime (https://api.openai.com for token/config,
        // wss: for WebRTC media). Media streams and RTC endpoints use blob: URIs.
        'connect-src': ["'self'", 'https://api.openai.com', 'wss:'],
        'worker-src': ["'self'", 'blob:'], // audio worklets
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'self'"],
        'report-uri': ['/csp-report'],
      },
    })
  );

  if (CSP_ENFORCE) {
    console.log('[CSP] Enforcement mode enabled (CSP_ENFORCE=true)');
  } else {
    console.log('[CSP] Report-only mode (CSP_ENFORCE not set); violations logged to /csp-report');
  }
}

// CSP violation reports (browsers send content-type application/csp-report).
app.post(
  '/csp-report',
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '50kb' }),
  (req, res) => {
    console.warn('[CSP] violation report:', JSON.stringify(req.body));
    res.sendStatus(204);
  }
);

// Global JSON body parsing — except routes that mount their own parser with a
// different limit: the client-events beacon (tighter, 4kb) and the session
// audio ingest (larger, 8mb — without this exemption the global 100kb default
// parsed first and 413'd any audio batch bigger than ~1.5s of PCM, silently
// dropping recording audio whenever a client uploads a backlog).
const globalJsonParser = express.json();
const OWN_PARSER_PATHS = /^\/api\/(client-events$|sessions\/[^/]+\/audio$)/;
app.use((req, res, next) =>
  OWN_PARSER_PATHS.test(req.path) ? next() : globalJsonParser(req, res, next)
);

// ==================== HTTP TELEMETRY ====================
// In-process ops metrics (rolling 60-min request/error/latency window per
// route group) feed the admin ops dashboard. Independent of logging.
app.use(opsMetricsMiddleware());

// Structured request logging (pino-http). Quiet paths — health checks,
// static/build assets, vite HMR internals, socket.io polling — are skipped
// entirely to keep production log volume sane; everything else logs one line
// per response: info for 2xx/3xx, warn for 4xx, error for 5xx.
const QUIET_PATH_PREFIXES = ['/health', '/socket.io', '/assets/', '/@vite', '/@fs', '/@react-refresh', '/node_modules/', '/src/', '/favicon'];
const STATIC_ASSET_RE = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp|mp3|wasm)(\?|$)/;
function isQuietPath(url: string): boolean {
  const pathOnly = url.split('?')[0];
  return QUIET_PATH_PREFIXES.some((p) => pathOnly.startsWith(p)) || STATIC_ASSET_RE.test(pathOnly);
}
app.use(
  pinoHttp({
    // Silent under vitest so integration tests don't drown their output in
    // request lines; LOG_LEVEL still wins everywhere when set explicitly.
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    autoLogging: { ignore: (req) => isQuietPath(req.url || '') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  })
);
// ==================== END HTTP TELEMETRY ====================

// Health + bug-report (public, pre-session/IP middleware).
app.use(healthRoutes());
app.use(bugReportRoutes());

// Session configuration with PostgreSQL store. One middleware instance shared
// by HTTP and the Socket.io handshake so cookie/secret settings can't drift.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
const PgSession = connectPgSimple(session);
const sessionMiddleware = session({
  store: new PgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: false // We create table via migration
  }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' ? true : false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax' // Prevent CSRF while allowing navigation
  }
});
app.use(sessionMiddleware);

// IP-based geolocation filtering
// Restricts participants to US-based access only
// Therapists and researchers can access from anywhere
app.use(restrictParticipantsToUs);

// ==================== SOCKET.IO SETUP ====================
// Socket.io authentication middleware
io.use((socket: AuthSocket, next) => {
  const req = socket.request as SessionRequest;

  // Reuse the same session middleware as HTTP to load the handshake session.
  sessionMiddleware(req as unknown as Request, {} as Response, (err) => {
    if (err) {
      console.error('[Socket.io] Session middleware error:', err);
      return next(new Error('Session error'));
    }

    // Allow both admin users and participants
    if (req.session?.userId) {
      socket.userId = req.session.userId;
      socket.username = req.session.username;
      socket.userRole = req.session.userRole;
      console.log(`[Socket.io] Authenticated: ${socket.username} (${socket.userRole || 'participant'})`);
      next();
    } else {
      // Allow anonymous connections for participants (they can still join session rooms)
      console.log('[Socket.io] Anonymous participant connected');
      socket.userRole = 'anonymous';
      next();
    }
  });
});

// Connection handler
io.on('connection', (socket: AuthSocket) => {
  const isAdmin = socket.userRole === 'therapist' || socket.userRole === 'researcher';

  if (isAdmin) {
    console.log(`[Socket.io] Admin connected: ${socket.username} (${socket.id})`);

    // Caseload RBAC (docs/caseload-rbac.md): 'admin-broadcast' is
    // researchers-only. Therapists join their own therapist:<id> room and
    // receive participant-linked events only via broadcastAdminEvent, which
    // fans out per-caseload.
    if (socket.userRole === 'therapist') {
      // Fail closed: a therapist socket never joins admin-broadcast.
      if (typeof socket.userId === 'number') {
        socket.join(`therapist:${socket.userId}`);
      }
    } else {
      socket.join('admin-broadcast');
    }

    // Notify other admins. Carries no participant data; researchers-only is
    // acceptable (therapists don't need presence pings).
    socket.to('admin-broadcast').emit('admin:joined', {
      username: socket.username,
      role: socket.userRole
    });
  } else {
    console.log(`[Socket.io] Participant connected (${socket.id})`);
  }

  // Handle session room subscriptions. Session rooms receive live unredacted
  // transcripts (`messages:new`), so joins must be authorized: admins may join
  // anything; participants only sessions they own — via the ownedSessions list
  // in their handshake cookie (set by /token, /api/chat/start, or
  // /api/sessions/create before the socket connects) or, for logged-in users,
  // the session row's user_id.
  socket.on('session:join', async ({ sessionId }: { sessionId?: string }) => {
    if (typeof sessionId !== 'string' || !sessionId) return;

    if (isAdmin) {
      // Caseload RBAC (docs/caseload-rbac.md): researchers join anything;
      // therapists only assigned clients' sessions. Same 404-style silence
      // as the HTTP layer — deny without confirming existence.
      if (socket.userRole === 'therapist') {
        try {
          const info = await getSessionAccessInfo(sessionId);
          const ownerId = info && info.user_id != null ? Number(info.user_id) : null;
          const ok = await canAdminAccessSessionLive(socket.userRole, socket.userId, Number.isInteger(ownerId) ? ownerId : null);
          if (!ok) {
            console.warn(`[Socket.io] Denied therapist session:join for ${sessionId.substring(0, 12)}... (${socket.username}: not in caseload)`);
            return;
          }
        } catch (err) {
          console.error('[Socket.io] caseload session:join check failed:', err);
          return;
        }
      }
      socket.join(`session:${sessionId}`);
      return;
    }

    const req = socket.request as SessionRequest;
    let allowed = (req.session?.ownedSessions ?? []).includes(sessionId);
    if (!allowed && socket.userId) {
      try {
        const info = await getSessionAccessInfo(sessionId);
        allowed = !!info && info.user_id === socket.userId;
      } catch (err) {
        console.error('[Socket.io] session:join ownership lookup failed:', err);
      }
    }

    if (!allowed) {
      console.warn(`[Socket.io] Denied session:join for ${sessionId.substring(0, 12)}... from ${socket.id} (not owner)`);
      return;
    }

    console.log(`[Socket.io] User joining session ${sessionId}`);
    socket.join(`session:${sessionId}`);
    if (!isAdmin) {
      // A live participant socket in the room is a sign of life: cancel any
      // pending abandon-check from an earlier disconnect/reconnect blip.
      noteSessionActivity(sessionId);
    }
  });

  socket.on('session:leave', ({ sessionId }) => {
    console.log(`[Socket.io] User leaving session ${sessionId}`);
    socket.leave(`session:${sessionId}`);
  });

  // Handle admin request for sideband connections (admin only)
  socket.on('admin:get-sideband-connections', async () => {
    if (!isAdmin) {
      console.warn(`[Socket.io] Unauthorized admin:get-sideband-connections attempt from ${socket.id}`);
      return;
    }

    try {
      const { sidebandManager } = await import('./services/sidebandManager.service.js');
      const activeSessions = sidebandManager.getActiveConnections();

      let rows = await getSidebandConnectionsByIds(activeSessions);

      // Caseload RBAC: therapists only see their assigned clients' live
      // connections (mirrors the HTTP /admin/api/sideband/status filter).
      if (socket.userRole === 'therapist' && socket.userId != null) {
        const caseload = new Set(await getCaseloadClientIds(socket.userId));
        const allowed: typeof rows = [];
        for (const row of rows) {
          const info = await getSessionAccessInfo(String(row.session_id));
          const ownerId = info && info.user_id != null ? Number(info.user_id) : null;
          if (ownerId != null && caseload.has(ownerId)) allowed.push(row);
        }
        rows = allowed;
      }

      const connections = rows.map(session => ({
        sessionId: session.session_id,
        callId: session.openai_call_id,
        connectedAt: session.sideband_connected_at,
        status: session.sideband_connected ? 'connected' : 'disconnected'
      }));

      socket.emit('admin:sideband-connections', connections);
    } catch (error) {
      console.error('[Socket.io] Error fetching sideband connections:', error);
      socket.emit('admin:sideband-connections', []);
    }
  });

  // Handle admin messages to participants (admin only)
  socket.on('admin:sendMessage', async ({ sessionId, message, messageType }) => {
    if (!isAdmin) {
      console.warn(`[Socket.io] Unauthorized admin:sendMessage attempt from ${socket.id}`);
      return;
    }

    // Caseload RBAC (docs/caseload-rbac.md): therapists may only steer/message
    // assigned clients' sessions. Same silent-deny semantics as session:join.
    if (socket.userRole === 'therapist') {
      try {
        const info = await getSessionAccessInfo(sessionId);
        const ownerId = info && info.user_id != null ? Number(info.user_id) : null;
        const ok = await canAdminAccessSessionLive(socket.userRole, socket.userId, Number.isInteger(ownerId) ? ownerId : null);
        if (!ok) {
          console.warn(`[Socket.io] Denied therapist admin:sendMessage for ${String(sessionId).substring(0, 12)}... (${socket.username}: not in caseload)`);
          return;
        }
      } catch (err) {
        console.error('[Socket.io] caseload admin:sendMessage check failed:', err);
        return;
      }
    }

    console.log(`[Socket.io] Admin ${socket.username} sending ${messageType} message to session ${sessionId}`);

    // Invisible steers go over the server-side sideband when one is live —
    // the old path (relay to the participant's browser, which re-injects over
    // its WebRTC data channel) silently drops the steer whenever the
    // participant socket is flaky (ai-therapist-18/112). The client relay
    // remains only as the fallback (chat sessions, no sideband).
    let deliveredVia = 'client-relay';
    if (messageType === 'invisible') {
      try {
        const { sidebandManager } = await import('./services/sidebandManager.service.js');
        if (await sidebandManager.tryInject(sessionId, 'system', message, true)) {
          deliveredVia = 'sideband';
        }
      } catch (err) {
        console.error('[Socket.io] Sideband inject for admin message failed, falling back to relay:', err);
      }
    }

    // Visible messages are display-only and always go to the participant's
    // screen; invisible ones are relayed only when the sideband couldn't
    // deliver them (otherwise the model would receive the steer twice).
    if (messageType === 'visible' || deliveredVia === 'client-relay') {
      socket.to(`session:${sessionId}`).emit('admin:message', {
        sessionId,
        message,
        messageType, // 'visible' or 'invisible'
        senderName: socket.username,
        timestamp: new Date().toISOString()
      });
    }

    // Log the admin intervention
    const logData = {
      session_id: sessionId,
      role: 'system',
      message_type: `admin_${messageType}`,
      content: message,
      content_redacted: message,
      metadata: {
        admin_username: socket.username,
        message_type: messageType,
        delivered_via: deliveredVia,
        sent_at: new Date().toISOString()
      },
      created_at: new Date()
    };

    // Insert admin message into database
    try {
      await insertMessagesBatch([logData]);
      console.log(`Admin message logged to database`);
    } catch (err) {
      console.error('Failed to log admin message:', err);
    }
  });

  // Disconnect handler
  socket.on('disconnect', (reason) => {
    console.log(`[Socket.io] User disconnected: ${reason}`);
    if (isAdmin) {
      socket.to('admin-broadcast').emit('admin:left', { username: socket.username });
    } else {
      // Participant sockets over the tunnel are known to be flaky (reconnect
      // storms, brief drops) — don't end the session on disconnect alone.
      // Instead schedule a grace-window check: if there's no new activity
      // (rejoin, audio chunk) for the session within the window, treat it as
      // abandoned and finalize it. See sessionLifecycle.service.ts.
      for (const room of socket.rooms) {
        if (room.startsWith('session:')) {
          const sessionId = room.slice('session:'.length);
          scheduleAbandonCheck(sessionId);
        }
      }
    }
  });
});
// ==================== END SOCKET.IO SETUP ====================


// ===================== Authentication Routes =====================
// Login, register, logout, status live in routes/public/auth.routes.ts.
app.use(authRoutes());

// Magic-link demo access (/demo/:token) — auto-provisions a capped demo account.
app.use(magicLinkRoutes());

// Demo dashboard interceptor. Mounted BEFORE the real admin/users routers so
// that for 'demo' accounts every /admin/api/* (and /api/users) request is
// served synthetic fixtures and never reaches the database. No-op for everyone
// else (see routes/demo.routes.ts).
app.use(demoRoutes());

// ===================== MFA (Multi-Factor Authentication) Routes =====================

// MFA setup/verify/disable + backup codes live in routes/public/mfa.routes.ts.
app.use(mfaRoutes());
// Per-user rate-limit status -> routes/public/rateLimits.routes.ts.
app.use(rateLimitsRoutes());


// ===================== User Management API Routes =====================
// /api/users + /api/users/preferences live in routes/public/users.routes.ts.
app.use(usersRoutes());

// ===================== Session Token and Creation Endpoints =====================

// Realtime session token minting -> routes/public/token.routes.js.
app.use(tokenRoutes());

// Participant consent screen (accept/status) -> routes/public/consent.routes.ts.
app.use(consentRoutes());

// Participant progress home (/api/me/*) -> routes/public/progress.routes.ts.
app.use(progressRoutes());


// ===================== Chat-Only Therapy Endpoints =====================
// Voice-disabled flow (GPT chat completions) -> routes/public/chat.routes.ts.
app.use(chatRoutes());



// Admin sideband control (status / live instruction updates) -> routes/admin/sideband.routes.ts.
app.use(sidebandRoutes());


// ===================== Session Management API Routes =====================
// Public session create/list/view/end + register-call -> routes/public/sessions.routes.ts.
app.use(sessionsRoutes());



// ===================== Logs batch route with redaction =====================
// Batch message logging + crisis detection -> routes/public/logs.routes.ts.
app.use(logsRoutes());

// Client error beacon (rate-limited, allowlisted kinds) -> routes/public/clientEvents.routes.ts.
app.use(clientEventsRoutes());


// ===================== Admin API Routes =====================

// Admin session browser + message editing -> routes/admin/sessions.routes.ts.
app.use(adminSessionsRoutes());

// Admin analytics dashboard -> routes/admin/analytics.routes.ts.
app.use(analyticsRoutes());

// Ops telemetry + product funnel -> routes/admin/ops.routes.ts.
app.use(opsRoutes());

// Study-ops dashboard (enrollment/arm-balance/deviations) -> routes/admin/studyOps.routes.ts.
app.use(studyOpsRoutes());


// Research-data export (JSON/CSV) -> routes/admin/export.routes.ts.
app.use(exportRoutes());


// ===================== System Configuration API Routes =====================
// Public config + voice-preview endpoints are defined in routes/public/.
app.use(configRoutes());
app.use(voicesRoutes());
// Admin config read/write API -> routes/admin/config.routes.ts.
app.use(adminConfigRoutes());

// Versioned IRB consent documents (publish/re-consent) -> routes/admin/consent.routes.ts.
app.use(adminConsentRoutes());


// Content Retention / Data Wipe Endpoints -> routes/admin/contentRetention.routes.ts
app.use(contentRetentionRoutes());

// User session admin (list/force-logout) -> routes/admin/userSessions.routes.ts.
app.use(userSessionsRoutes());
// Admin rate-limited participants roster -> routes/admin/rateLimits.routes.ts.
app.use(adminRateLimitsRoutes());



// Crisis Management API Routes -> routes/admin/crisis.routes.ts
app.use(crisisRoutes());

// IRB adverse-event reports -> routes/admin/adverseEvents.routes.ts
app.use(adverseEventsRoutes());

// Redaction-verification API -> routes/admin/redaction.routes.ts
app.use(redactionRoutes());

// Session insights (memory summary + SOAP review) -> routes/admin/insights.routes.ts
app.use(insightsRoutes());

// Participant profile (memory-first clinical view + per-user sessions) -> routes/admin/participantProfile.routes.ts
app.use(participantProfileRoutes());

// Clinician pre-session prep digest -> routes/admin/prep.routes.ts
app.use(prepRoutes());

// Therapist caseload assignments + management API -> routes/admin/caseload.routes.ts (docs/caseload-rbac.md)
app.use(caseloadRoutes());

// Client invite links (therapist-generated, single-use) -> routes/admin/invites.routes.ts
app.use(invitesRoutes());

// Public invite acceptance / client self-registration -> routes/join.routes.ts
app.use(joinRoutes());

// RAG knowledge-base curation (Knowledge Base tab) -> routes/admin/knowledge.routes.ts.
app.use(knowledgeRoutes());

// Session eval harness (LLM-judge quality scores) -> routes/admin/evals.routes.ts
app.use(evalsRoutes());

async function startProdServer() {
  console.log("Starting in production mode...");

  // Cache policy: hashed build assets are content-addressed, so cache them
  // forever (immutable); HTML must never be cached or browsers keep loading a
  // stale bundle after a deploy.
  const staticCache = (res: express.Response, filePath: string) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    } else if (/[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpe?g|gif|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  };

  // Serve static files from the client build directory.
  app.use(express.static(path.resolve(__dirname, '../../dist/client'), { setHeaders: staticCache }));

  // Serve admin static assets (CSS, JS) - admin assets are prefixed with "admin-" so no conflicts
  app.use('/assets', express.static(path.resolve(__dirname, '../../dist/admin-client/assets'), { setHeaders: staticCache }));

  // Only the main app is SSR'd; admin is a plain SPA.
  // @ts-ignore – this module is generated at build time and not available during type-check
  const { render } = await import('../../dist/server/entry-server.js') as { render: (url: string) => Promise<{ html: string }> };

  // Admin panel route (demo accounts see a synthetic-data version — see demo.routes.ts)
  app.get('/admin', requireRole('therapist', 'researcher', 'demo'), (_req, res) => {
    try {
      const html = fs.readFileSync(path.resolve(__dirname, '../../dist/admin-client/admin.html'), 'utf-8');
      res.status(200).set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store, must-revalidate' }).end(html);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.stack : String(e));
      res.status(500).send('Internal server error');
    }
  });

  // The standalone /redact app was merged into admin (Research > Redaction
  // Review); redirect old bookmarks. /redact/api/* stays (redaction.routes.ts).
  app.get('/redact', (_req, res) => res.redirect('/admin'));

  // Handle all other requests with main app SSR.
  app.use('*', async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/client/index.html'), 'utf-8');
      const appHtml = await render(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store, must-revalidate' }).end(html);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.stack : String(e));
      res.status(500).send('Internal server error');
    }
  });
}

async function startDevServer() {
  console.log("Starting in development mode...");

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(vite.middlewares);

  // Admin panel route in dev (demo accounts get synthetic data — see
  // demo.routes.ts). Admin is a plain SPA — no SSR pass, just the transformed
  // template with the entry script pointed at its real location (Vite's root
  // is src/client/main, so the relative src in admin.html won't resolve).
  app.get("/admin", requireRole('therapist', 'researcher', 'demo'), async (req, res, next) => {
    try {
      let template = fs.readFileSync(path.resolve(__dirname, "../client/admin/admin.html"), "utf-8");
      template = template.replace(
        'src="./admin-entry-client.tsx"',
        'src="/@fs' + path.resolve(__dirname, "../client/admin/admin-entry-client.tsx") + '"'
      );
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e: unknown) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });

  // The standalone /redact app was merged into admin (Research > Redaction
  // Review); redirect old bookmarks. /redact/api/* stays (redaction.routes.ts).
  app.get("/redact", (_req, res) => res.redirect('/admin'));

  // Main app SSR (catch-all)
  app.use("/", async (req, res, next) => {
    try {
      const template = await vite.transformIndexHtml(
        req.originalUrl,
        fs.readFileSync(path.resolve(__dirname, "../client/main/index.html"), "utf-8")
      );
      // Make sure the path here is relative to the project root for ssrLoadModule
      const { render } = await vite.ssrLoadModule("src/client/main/entry-server.jsx");
      const appHtml = await render(req.originalUrl);

      // This line is the critical fix
      const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);

      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e: unknown) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

// --- Main Server Initialization ---

async function initializeServer() {
  if (process.env.NODE_ENV === "production") {
    await startProdServer();
  } else {
    await startDevServer();
  }

  // Final error handler: logs and returns a generic JSON error (stack only in
  // non-production). Must be mounted after every route.
  app.use(errorHandler);
}

// Only boot the HTTP server / SSR when run as the entrypoint (npm start, Docker).
// When imported (e.g. by integration tests), we export `app` without listening.
// Compare via realpath so symlinked paths (e.g. macOS /tmp, tsx's resolution)
// still match a direct invocation.
function isRunAsEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
const isEntrypoint = isRunAsEntrypoint();

if (isEntrypoint) {
  initializeServer();

  httpServer.listen(port, async () => {
    console.log(`Express server running on http://localhost:${port}`);
    console.log(`Socket.io server ready for real-time connections`);

    // Start the content wipe scheduler
    try {
      await startContentWipeScheduler();
      console.log(`Content wipe scheduler initialized`);
    } catch (err) {
      console.error('Failed to start content wipe scheduler:', err);
    }

    // Start the data retention scheduler (ai-therapist-97). Ships disabled via
    // system_config.data_retention.enabled; no-ops until enabled deliberately.
    try {
      await startDataRetentionScheduler();
      console.log(`Data retention scheduler initialized`);
    } catch (err) {
      console.error('Failed to start data retention scheduler:', err);
    }

    // Daily sweep of expired magic-link demo accounts and their data
    startDemoCleanupScheduler();

    // Nightly simulation-eval runs (config-gated via evals.harness_schedule;
    // the admin Simulation Runs panel controls it). Never runs in the harness
    // child itself (it sets SOCKET_PG_ADAPTER=off, used here as the marker).
    if (process.env.SOCKET_PG_ADAPTER !== 'off') {
      import('./services/harnessRunner.service.js')
        .then(m => m.startHarnessScheduler())
        .catch(err => console.error('Failed to start harness scheduler:', err));
    }

    // Backstop sweep for sessions abandoned without a clean /end (dropped
    // tunnel connection, closed tab, crashed browser): finalizes recording +
    // triggers redaction so they don't sit "active" forever.
    startAbandonedSessionSweeper();

    // Re-attach sidebands orphaned by a blue-green cutover: the old container
    // dies with every in-memory sideband WS, which silently kills tool
    // execution + crisis steering for sessions that stay live through the
    // deploy (ai-therapist-112). Small delay so the tunnel/route flip settles.
    setTimeout(async () => {
      try {
        const { getOpenAIKey } = await import('./config/secrets.js');
        const { sidebandManager } = await import('./services/sidebandManager.service.js');
        await sidebandManager.reattachActiveSessions(await getOpenAIKey());
      } catch (err) {
        console.error('[Sideband] startup re-attach sweep failed:', err);
      }
    }, 5000);
  });
}

export { app, httpServer, io };