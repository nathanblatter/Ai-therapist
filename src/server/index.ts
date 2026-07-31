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
import {pool } from "./config/db.js";
import { requireRole } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { insertMessagesBatch, getSidebandConnectionsByIds, getSessionAccessInfo } from "./db/index.js";
import configRoutes from "./routes/public/config.routes.js";
import voicesRoutes from "./routes/public/voices.routes.js";
import authRoutes from "./routes/public/auth.routes.js";
import magicLinkRoutes from "./routes/public/magicLink.routes.js";
import demoRoutes from "./routes/demo.routes.js";
import mfaRoutes from "./routes/public/mfa.routes.js";
import usersRoutes from "./routes/public/users.routes.js";
import healthRoutes from "./routes/public/health.routes.js";
import bugReportRoutes from "./routes/public/bugReport.routes.js";
import contentRetentionRoutes from "./routes/admin/contentRetention.routes.js";
import userSessionsRoutes from "./routes/admin/userSessions.routes.js";
import crisisRoutes from "./routes/admin/crisis.routes.js";
import redactionRoutes from "./routes/admin/redaction.routes.js";
import adminConfigRoutes from "./routes/admin/config.routes.js";
import analyticsRoutes from "./routes/admin/analytics.routes.js";
import exportRoutes from "./routes/admin/export.routes.js";
import adminRateLimitsRoutes from "./routes/admin/rateLimits.routes.js";
import rateLimitsRoutes from "./routes/public/rateLimits.routes.js";
import adminSessionsRoutes from "./routes/admin/sessions.routes.js";
import sidebandRoutes from "./routes/admin/sideband.routes.js";
import insightsRoutes from "./routes/admin/insights.routes.js";
import knowledgeRoutes from "./routes/admin/knowledge.routes.js";
import evalsRoutes from "./routes/admin/evals.routes.js";
import chatRoutes from "./routes/public/chat.routes.js";
import sessionsRoutes from "./routes/public/sessions.routes.js";
import tokenRoutes from "./routes/public/token.routes.js";
import logsRoutes from "./routes/public/logs.routes.js";
import { restrictParticipantsToUs } from "./middleware/ipFilter.js";
import { startScheduler as startContentWipeScheduler } from "./services/contentWipe.service.js";
import { startDemoCleanupScheduler } from "./services/demoCleanup.service.js";

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
  transports: ['websocket', 'polling'],
  allowEIO3: true  // Allow older clients
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

// Security headers. CSP runs in REPORT-ONLY mode (production only — Vite dev
// injects its own inline scripts): nothing is blocked yet, but violations of
// the policy below are POSTed to /csp-report and logged. Once the logs run
// clean (nonce plumbing for any SSR inline scripts), flip reportOnly to false.
// script-src deliberately omits 'unsafe-inline' so reports reveal exactly
// which inline scripts still need nonces.
app.use(helmet({ contentSecurityPolicy: false }));
if (process.env.NODE_ENV === 'production') {
  app.use(
    helmet.contentSecurityPolicy({
      useDefaults: false,
      reportOnly: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"], // Tailwind/Recharts inline styles
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'font-src': ["'self'", 'data:'],
        // Same-origin API/socket.io + the OpenAI Realtime SDP/token exchange.
        'connect-src': ["'self'", 'https://api.openai.com', 'wss:'],
        'worker-src': ["'self'", 'blob:'], // audio worklets
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'self'"],
        'report-uri': ['/csp-report'],
      },
    })
  );
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

app.use(express.json()); // Needed to parse JSON bodies

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

    // Auto-join admin broadcast room
    socket.join('admin-broadcast');

    // Notify other admins
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

      const rows = await getSidebandConnectionsByIds(activeSessions);

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

    console.log(`[Socket.io] Admin ${socket.username} sending ${messageType} message to session ${sessionId}`);

    // Broadcast message to all participants in the session (but not back to the sending admin)
    socket.to(`session:${sessionId}`).emit('admin:message', {
      sessionId,
      message,
      messageType, // 'visible' or 'invisible'
      senderName: socket.username,
      timestamp: new Date().toISOString()
    });

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


// ===================== Admin API Routes =====================

// Admin session browser + message editing -> routes/admin/sessions.routes.ts.
app.use(adminSessionsRoutes());

// Admin analytics dashboard -> routes/admin/analytics.routes.ts.
app.use(analyticsRoutes());


// Research-data export (JSON/CSV) -> routes/admin/export.routes.ts.
app.use(exportRoutes());


// ===================== System Configuration API Routes =====================
// Public config + voice-preview endpoints are defined in routes/public/.
app.use(configRoutes());
app.use(voicesRoutes());
// Admin config read/write API -> routes/admin/config.routes.ts.
app.use(adminConfigRoutes());


// Content Retention / Data Wipe Endpoints -> routes/admin/contentRetention.routes.ts
app.use(contentRetentionRoutes());

// User session admin (list/force-logout) -> routes/admin/userSessions.routes.ts.
app.use(userSessionsRoutes());
// Admin rate-limited participants roster -> routes/admin/rateLimits.routes.ts.
app.use(adminRateLimitsRoutes());



// Crisis Management API Routes -> routes/admin/crisis.routes.ts
app.use(crisisRoutes());

// Redaction-verification API -> routes/admin/redaction.routes.ts
app.use(redactionRoutes());

// Session insights (memory summary + SOAP review) -> routes/admin/insights.routes.ts
app.use(insightsRoutes());

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

  // Dynamically import all SSR modules
  // @ts-ignore – these modules are generated at build time and not available during type-check
  const { render } = await import('../../dist/server/entry-server.js') as { render: (url: string) => Promise<{ html: string }> };
  // @ts-ignore – build-time module, see above
  const { render: renderAdmin } = await import('../../dist/admin-server/admin-entry-server.js') as { render: (url: string) => Promise<{ html: string }> };
  // @ts-ignore – build-time module, see above
  const { render: renderRedact } = await import('../../dist/redact-server/redact-entry-server.js') as { render: (url: string) => Promise<{ html: string }> };

  // Serve redact static assets
  app.use('/redact/assets', express.static(path.resolve(__dirname, '../../dist/redact-client/assets'), { setHeaders: staticCache }));

  // Admin panel route (demo accounts see a synthetic-data version — see demo.routes.ts)
  app.get('/admin', requireRole('therapist', 'researcher', 'demo'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/admin-client/admin.html'), 'utf-8');
      const appHtml = await renderAdmin(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store, must-revalidate' }).end(html);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.stack : String(e));
      res.status(500).send('Internal server error');
    }
  });

  // Redact verification page route
  app.get('/redact', requireRole('researcher'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/redact-client/redact.html'), 'utf-8');
      const appHtml = await renderRedact(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store, must-revalidate' }).end(html);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.stack : String(e));
      res.status(500).send('Internal server error');
    }
  });

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

  // Admin panel route in dev (demo accounts get synthetic data — see demo.routes.ts)
  app.get("/admin", requireRole('therapist', 'researcher', 'demo'), async (req, res, next) => {
    try {
      // Read the admin HTML template
      let template = fs.readFileSync(path.resolve(__dirname, "../client/admin/admin.html"), "utf-8");

      // Manually fix the script path for Vite in dev mode
      // Since Vite's root is src/client/main, we need to go up one level and into admin
      template = template.replace(
        'src="./admin-entry-client.jsx"',
        'src="/@fs' + path.resolve(__dirname, "../client/admin/admin-entry-client.jsx") + '"'
      );

      template = await vite.transformIndexHtml(req.originalUrl, template);

      const { render } = await vite.ssrLoadModule("src/client/admin/admin-entry-server.jsx");
      const appHtml = await render(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e: unknown) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });

  // Redact verification page route in dev
  app.get("/redact", requireRole('researcher'), async (req, res, next) => {
    try {
      // Read the redact HTML template
      let template = fs.readFileSync(path.resolve(__dirname, "../client/redact/redact.html"), "utf-8");

      // Manually fix the script path for Vite in dev mode
      template = template.replace(
        'src="./redact-entry-client.jsx"',
        'src="/@fs' + path.resolve(__dirname, "../client/redact/redact-entry-client.jsx") + '"'
      );

      template = await vite.transformIndexHtml(req.originalUrl, template);

      const { render } = await vite.ssrLoadModule("src/client/redact/redact-entry-server.jsx");
      const appHtml = await render(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e: unknown) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });

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

    // Daily sweep of expired magic-link demo accounts and their data
    startDemoCleanupScheduler();
  });
}

export { app, httpServer, io };