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
import {getOpenAIKey} from "./config/secrets.js"; // Import the function to get the OpenAI API key
import {pool } from "./config/db.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { createSession, getSession, insertMessagesBatch, upsertSessionConfig, updateSessionStatus, getAiModel, type InsertMessageInput } from "./models/dbQueries.js";
import configRoutes from "./routes/public/config.routes.js";
import voicesRoutes from "./routes/public/voices.routes.js";
import authRoutes from "./routes/public/auth.routes.js";
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
import { getSystemConfig, getSystemPrompt } from "./utils/sessionHelpers.js";
import { generateSessionNameAsync } from "./services/sessionName.service.js";
import { restrictParticipantsToUs } from "./middleware/ipFilter.js";
import { startScheduler as startContentWipeScheduler } from "./services/contentWipe.service.js";

// ---------- local type helpers ----------

/** Typed shape of a row in system_config.config_value (JSONB, arbitrary keys) */
type SystemConfig = Record<string, unknown>;

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

/** Return type of checkSessionLimits */
type SessionLimitResult =
  | { allowed: true; bypass?: string; limits?: { max_duration_minutes: number; max_sessions_per_day: number; sessions_today: number }; reason?: undefined; message?: undefined; limit?: undefined; current?: undefined; cooldown_minutes?: undefined; minutes_remaining?: undefined }
  | { allowed: false; reason: string; message: string; limit?: number; current?: number; cooldown_minutes?: number; minutes_remaining?: number };

/** Shape of user update fields */
interface UserUpdates {
  username?: string;
  password?: string;
  role?: string;
}

/** Typed voice/language option entry from system_config */
interface VoiceOption {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
  systemPromptAddition?: string;
}

interface VoicesConfig {
  voices?: VoiceOption[];
  default_voice: string;
}

interface LanguageOption {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
  systemPromptAddition?: string;
}

interface LanguagesConfig {
  languages?: LanguageOption[];
  default_language: string;
}

interface SessionLimitsConfig {
  enabled: boolean;
  max_sessions_per_day: number;
  cooldown_minutes: number;
  max_duration_minutes: number;
}

interface CrisisContactConfig {
  hotline: string;
  phone: string;
  text?: string;
  enabled: boolean;
}

interface SystemPromptEntry {
  prompt: string;
  last_modified?: string;
}

interface SystemPromptsConfig {
  realtime: SystemPromptEntry;
  chat: SystemPromptEntry;
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
    origin: process.env.NODE_ENV === 'production'
      ? (process.env.CORS_ORIGIN || true)  // Allow same-origin in production
      : 'http://localhost:5173',
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true  // Allow older clients
});

// Make 'io' available globally for event emission
global.io = io;

const port = process.env.PORT ;


const apiKey = await getOpenAIKey();


// Language instructions are now stored in the database system_config table
// They will be loaded dynamically from the 'languages' config

// getSystemConfig / getSystemPrompt (and their shared cache) live in
// utils/sessionHelpers.ts — imported above so config reads share one cache.

// Session limit enforcement helpers
async function checkSessionLimits(userId: number | string | null, userRole: string | null = null): Promise<SessionLimitResult> {
  if (!userId) {
    // Anonymous users don't have limits enforced
    return { allowed: true };
  }

  // Researcher accounts are exempt from limits
  if (userRole === 'researcher') {
    console.log(`Researcher ${userId} bypassing session limits`);
    return { allowed: true, bypass: 'researcher' };
  }

  const config = await getSystemConfig();
  const limits = (config.session_limits as SessionLimitsConfig | undefined) ?? ({ enabled: false } as SessionLimitsConfig);

  if (!limits.enabled) {
    return { allowed: true };
  }

  // Check daily session count (using Salt Lake City timezone)
  const todayStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  todayStart.setHours(0, 0, 0, 0);

  const todaySessionsResult = await pool.query(
    `SELECT COUNT(*) as session_count
     FROM therapy_sessions
     WHERE user_id = $1 AND created_at >= $2`,
    [userId, todayStart]
  );

  const todaySessionCount = parseInt(todaySessionsResult.rows[0].session_count);

  if (todaySessionCount >= limits.max_sessions_per_day) {
    return {
      allowed: false,
      reason: 'daily_limit',
      message: `You have reached your daily limit of ${limits.max_sessions_per_day} sessions. Please try again tomorrow.`,
      limit: limits.max_sessions_per_day,
      current: todaySessionCount
    };
  }

  // Check cooldown period
  if (limits.cooldown_minutes > 0) {
    const recentSessionResult = await pool.query(
      `SELECT ended_at
       FROM therapy_sessions
       WHERE user_id = $1 AND ended_at IS NOT NULL
       ORDER BY ended_at DESC
       LIMIT 1`,
      [userId]
    );

    if (recentSessionResult.rows.length > 0) {
      const lastEndedAt = new Date(recentSessionResult.rows[0].ended_at);
      const now = new Date();
      const timeSinceEndMs = now.getTime() - lastEndedAt.getTime();
      const cooldownMs = limits.cooldown_minutes * 60 * 1000;

      // Debug logging
      console.log('Cooldown check:', {
        lastEndedAt: lastEndedAt.toISOString(),
        now: now.toISOString(),
        timeSinceEndMs,
        timeSinceEndMinutes: timeSinceEndMs / 60000,
        cooldownMinutes: limits.cooldown_minutes,
        cooldownMs,
        isInCooldown: timeSinceEndMs < cooldownMs
      });

      if (timeSinceEndMs < cooldownMs) {
        const remainingMs = cooldownMs - timeSinceEndMs;
        const minutesRemaining = Math.ceil(remainingMs / 60000);

        return {
          allowed: false,
          reason: 'cooldown',
          message: `Please wait ${minutesRemaining} more minute${minutesRemaining !== 1 ? 's' : ''} before starting a new session.`,
          cooldown_minutes: limits.cooldown_minutes,
          minutes_remaining: minutesRemaining
        };
      }
    }
  }

  return {
    allowed: true,
    limits: {
      max_duration_minutes: limits.max_duration_minutes,
      max_sessions_per_day: limits.max_sessions_per_day,
      sessions_today: todaySessionCount
    }
  };
}

// SLC timezone helpers (getNextMidnightSLC/getHoursUntilReset/getStartOfTodaySLC)
// live in utils/timezoneHelpers.ts and are used by the rate-limit route modules.

app.use(express.json()); // Needed to parse JSON bodies

// Health + bug-report (public, pre-session/IP middleware).
app.use(healthRoutes());
app.use(bugReportRoutes());

// Session configuration with PostgreSQL store
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: false // We create table via migration
  }),
  secret: process.env.SESSION_SECRET || 'ai-therapist-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' ? true : false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax' // Prevent CSRF while allowing navigation
  }
}));

// IP-based geolocation filtering
// Restricts participants to US-based access only
// Therapists and researchers can access from anywhere
app.use(restrictParticipantsToUs);

// ==================== SOCKET.IO SETUP ====================
// Socket.io authentication middleware
io.use((socket: AuthSocket, next) => {
  const req = socket.request as SessionRequest;

  // Get session from socket handshake
  const sessionMiddleware = session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET || 'ai-therapist-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.COOKIE_SECURE === 'true',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    }
  });

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

  // Handle session room subscriptions (available to all users)
  socket.on('session:join', ({ sessionId }) => {
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

      const connections = result.rows.map(session => ({
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

const sessionConfig = JSON.stringify({
  session: {
      type: "realtime",
       tools: [
            
        ],
        tool_choice: "auto",
      model: "gpt-realtime-mini",
      instructions: await getSystemPrompt('en', 'realtime'),
      audio: {
          input:{
            transcription:{
              model: "whisper-1",
            }

          },
          output: {
              voice: "cedar",
          },
      },
      
  },
});


// ===================== Authentication Routes =====================
// Login, register, logout, status live in routes/public/auth.routes.ts.
app.use(authRoutes());

// ===================== MFA (Multi-Factor Authentication) Routes =====================

// MFA setup/verify/disable + backup codes live in routes/public/mfa.routes.ts.
app.use(mfaRoutes());
// Per-user rate-limit status -> routes/public/rateLimits.routes.ts.
app.use(rateLimitsRoutes());


// ===================== User Management API Routes =====================
// /api/users + /api/users/preferences live in routes/public/users.routes.ts.
app.use(usersRoutes());

// ===================== Session Token and Creation Endpoints =====================

// An endpoint which would work with the client code above - it returns
// the contents of a REST API request to this protected endpoint
// Accept both GET (backward compatibility) and POST (with settings)
app.all("/token", async (req, res) => {
  try {
      const userId = req.session?.userId || null;
      const userRole = req.session?.userRole || null;

      // RATE LIMITING CHECK: Enforce session limits (researchers are exempt)
      const limitCheck = await checkSessionLimits(userId, userRole);
      if (!limitCheck.allowed) {
        console.log(`Session limit exceeded for user ${userId}:`, limitCheck.reason);
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          reason: limitCheck.reason,
          message: limitCheck.message,
          details: {
            limit: limitCheck.limit,
            current: limitCheck.current,
            cooldown_minutes: limitCheck.cooldown_minutes,
            minutes_remaining: limitCheck.minutes_remaining
          }
        });
      }

      // IDEMPOTENCY CHECK: Look for existing active session
      if (userId) {
        const { getActiveSessionForUser } = await import("./models/dbQueries.js");
        const existingSession = await getActiveSessionForUser(userId);

        if (existingSession) {
          console.log(`Returning existing active session for user ${userId}:`, {
            sessionId: existingSession.session_id.substring(0, 12) + '...',
            created_at: existingSession.created_at
          });

          return res.status(200).json({
            session: {
              id: existingSession.session_id,
              exists: true,
              created_at: existingSession.created_at
            },
            message: "Active session already exists. Please end current session before starting a new one."
          });
        }
      }

      // No active session - proceed with creating new one
      // Get user settings: First check saved preferences, then request body, then defaults
      let userVoice = req.body?.voice;
      let userLanguage = req.body?.language;

      console.log(`[Token] Request body - voice: ${userVoice}, language: ${userLanguage}`);
      console.log(`[Token] User ID: ${userId}`);

      // If not provided in request, load from user preferences
      if (!userVoice || !userLanguage) {
        console.log('[Token] Loading preferences from database...');
        try {
          const prefsResult = await pool.query(
            'SELECT preferred_voice, preferred_language FROM users WHERE userid = $1',
            [userId]
          );

          console.log(`[Token] Database query result:`, prefsResult.rows);

          if (prefsResult.rows.length > 0) {
            const dbVoice = prefsResult.rows[0].preferred_voice;
            const dbLanguage = prefsResult.rows[0].preferred_language;
            console.log(`[Token] DB values - voice: ${dbVoice}, language: ${dbLanguage}`);

            userVoice = userVoice || dbVoice || 'cedar';
            userLanguage = userLanguage || dbLanguage || 'en';

            console.log(`[Token] Final values - voice: ${userVoice}, language: ${userLanguage}`);
          } else {
            console.log('[Token] No user found in database, using defaults');
            userVoice = userVoice || 'cedar';
            userLanguage = userLanguage || 'en';
          }
        } catch (err) {
          console.error('[Token] Failed to load user preferences, using defaults:', err);
          userVoice = userVoice || 'cedar';
          userLanguage = userLanguage || 'en';
        }
      }

      console.log(`[Token] Using voice: ${userVoice}, language: ${userLanguage} for user ${userId}`);

      // Save preferences for next time (async, don't block)
      if (userId) {
        pool.query(
          'UPDATE users SET preferred_voice = $1, preferred_language = $2 WHERE userid = $3',
          [userVoice, userLanguage, userId]
        ).then(() => {
          console.log(`[Token] Saved preferences for user ${userId}: voice=${userVoice}, language=${userLanguage}`);
        }).catch(err => console.error('[Token] Failed to save user preferences:', err));
      }

      const temperature = 0.8; // Fixed temperature

      // Get AI model from system config
      const aiModel = await getAiModel();

      // Get tools from registry
      const { toolRegistry } = await import('./services/toolRegistry.service.js');
      const tools = toolRegistry.getAllToolDefinitions();

      // Create dynamic session config with user settings
      const dynamicSessionConfig = JSON.stringify({
        session: {
            type: "realtime",
            tools: tools,
            tool_choice: "auto",
            model: aiModel,
            instructions: await getSystemPrompt(userLanguage, 'realtime'),
            audio: {
                input:{
                  transcription:{
                    model: "whisper-1",
                  }
                },
                output: {
                    voice: userVoice,
                },
            },
        },
      });

      console.log("Sending session config to OpenAI:", {
        voice: userVoice,
        language: userLanguage,
        configLength: dynamicSessionConfig.length
      });

      const response = await fetch(
          "https://api.openai.com/v1/realtime/client_secrets",
          {
              method: "POST",
              headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
              },
              body: dynamicSessionConfig,
          }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("OpenAI API error:", response.status, errorText);
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      console.log("OpenAI response data:", JSON.stringify(data, null, 2));

      if (!data || !data.session || !data.session.id) {
        console.error("Invalid OpenAI response structure:", data);
        throw new Error("Invalid response from OpenAI API - missing session.id");
      }

      // Create session in database with user association
      const sessionId = data.session.id;
      const username = req.session?.username || null;

      // Debug logging
      console.log('Creating therapy session:', {
        sessionId: sessionId.substring(0, 12) + '...',
        userId: userId,
        username: username,
        hasSession: !!req.session,
        sessionData: req.session
      });

      try {
        await pool.query(
          `INSERT INTO therapy_sessions (session_id, user_id, status, created_at, updated_at)
           VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (session_id) DO NOTHING`,
          [sessionId, userId]
        );
        console.log(`Therapy session created with user_id: ${userId}`);

        // Emit session created event to Socket.io
        global.io.to('admin-broadcast').emit('session:created', {
          sessionId,
          userId,
          username,
          status: 'active',
          created_at: new Date()
        });

        // Schedule auto-termination if session limits are enabled (not for researchers)
        if (limitCheck.limits && limitCheck.limits.max_duration_minutes && !limitCheck.bypass) {
          const sessionLimits = limitCheck.limits; // captured for closure
          const durationMs = sessionLimits.max_duration_minutes * 60 * 1000;
          setTimeout(async () => {
            try {
              // Check if session is still active
              const checkResult = await pool.query(
                'SELECT status FROM therapy_sessions WHERE session_id = $1',
                [sessionId]
              );

              if (checkResult.rows.length > 0 && checkResult.rows[0].status === 'active') {
                console.log(`⏰ Auto-terminating session ${sessionId} after ${sessionLimits.max_duration_minutes} minutes`);

                // End the session
                const { updateSessionStatus } = await import("./models/dbQueries.js");
                await updateSessionStatus(sessionId, 'ended', 'system');

                // Notify the user via Socket.io
                global.io.to(`session:${sessionId}`).emit('session:status', {
                  status: 'ended',
                  endedBy: 'system',
                  reason: 'duration_limit',
                  message: `Your session has ended after ${sessionLimits.max_duration_minutes} minutes (maximum session duration).`,
                  remoteTermination: true
                });

                // Notify admins
                global.io.to('admin-broadcast').emit('session:ended', {
                  sessionId,
                  endedAt: new Date(),
                  endedBy: 'system',
                  reason: 'duration_limit'
                });
              }
            } catch (err) {
              console.error(`Failed to auto-terminate session ${sessionId}:`, err);
            }
          }, durationMs);

          console.log(`Session ${sessionId} will auto-terminate in ${sessionLimits.max_duration_minutes} minutes`);
        }

        // Insert session configuration
        const sessionConfigObj = JSON.parse(dynamicSessionConfig);
        await upsertSessionConfig(sessionId, {
          voice: userVoice,
          modalities: ['text', 'audio'],
          instructions: sessionConfigObj.session?.instructions || null,
          turn_detection: sessionConfigObj.session?.turn_detection || null,
          tools: sessionConfigObj.session?.tools || null,
          temperature: temperature,
          max_response_output_tokens: sessionConfigObj.session?.max_response_output_tokens || 4096,
          language: userLanguage
        });
        console.log(`Session configuration created for session: ${sessionId.substring(0, 12)}... (voice: ${userVoice}, language: ${userLanguage})`);
      } catch (dbError) {
        console.error("Failed to create session in database:", dbError);
        // Continue anyway - session will be created by logs/batch endpoint
      }

      // Include session limits in response for client-side timer
      const responseData = {
        ...data,
        session_limits: limitCheck.limits || null
      };

      res.json(responseData);
  } catch (error) {
      console.error("Token generation error:", error);
      res.status(500).json({ error: "Failed to generate token" });
  }
});

// ===================== Chat-Only Therapy Endpoints =====================
// Used when voice is disabled - routes to GPT-5 chat completions instead of Realtime API

// POST /api/chat/start - Start a chat-only therapy session
app.post("/api/chat/start", async (req, res) => {
  const userId: number | string = req.session?.userId ?? req.sessionID; // Use session userId or fallback to sessionID for anonymous
  const numericUserId: number | null = typeof userId === 'number' ? userId : null;

  try {
    // Check session limits (same as /token endpoint)
    const userRole = req.session?.userRole || 'participant';
    const limitCheck = await checkSessionLimits(userId, userRole);

    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: 'Session limit exceeded',
        reason: limitCheck.reason,
        minutes_remaining: limitCheck.minutes_remaining
      });
    }

    // Check for existing active session (prevent multiple simultaneous sessions)
    const { getActiveSessionForUser } = await import("./models/dbQueries.js");
    const existingSession = await getActiveSessionForUser(userId);
    if (existingSession) {
      return res.status(200).json({
        message: "Active session already exists",
        sessionId: existingSession.session_id,
        alreadyActive: true
      });
    }

    // Get language setting: First check saved preferences, then request body, then defaults
    let userLanguage = req.body?.language;

    console.log(`[ChatStart] Request body - language: ${userLanguage}`);
    console.log(`[ChatStart] User ID: ${userId}`);

    // If not provided in request, load from user preferences
    if (!userLanguage && req.session?.userId) {
      console.log('[ChatStart] Loading language preference from database...');
      try {
        const prefsResult = await pool.query(
          'SELECT preferred_language FROM users WHERE userid = $1',
          [userId]
        );

        console.log(`[ChatStart] Database query result:`, prefsResult.rows);

        if (prefsResult.rows.length > 0) {
          const dbLanguage = prefsResult.rows[0].preferred_language;
          console.log(`[ChatStart] DB language: ${dbLanguage}`);
          userLanguage = dbLanguage || 'en';
        } else {
          console.log('[ChatStart] No user found in database, using default');
          userLanguage = 'en';
        }
      } catch (err) {
        console.error('[ChatStart] Failed to load user preferences, using default:', err);
        userLanguage = 'en';
      }
    } else {
      userLanguage = userLanguage || 'en';
    }

    console.log(`[ChatStart] Using language: ${userLanguage} for user ${userId}`);

    // Save language preference for next time (async, don't block)
    if (req.session?.userId) {
      pool.query(
        'UPDATE users SET preferred_language = $1 WHERE userid = $2',
        [userLanguage, userId]
      ).then(() => {
        console.log(`[ChatStart] Saved language preference for user ${userId}: ${userLanguage}`);
      }).catch(err => console.error('[ChatStart] Failed to save user language preference:', err));
    }

    // Generate unique session ID
    const sessionId = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Get system prompt for chat sessions
    const systemPrompt = await getSystemPrompt(userLanguage, 'chat');

    // Initialize chat session in memory
    const { initializeChatSession } = await import('./services/chatTherapy.service.js');
    initializeChatSession(sessionId, systemPrompt);

    // Create session in database
    const username = req.session?.username || null;
    await createSession({
      sessionId,
      userId: numericUserId,
      sessionName: null,  // Will be generated from conversation when session ends
      status: 'active',
      sessionType: 'chat'  // Mark as chat-only session
    });

    // Emit session started event to Socket.io
    global.io.to('admin-broadcast').emit('session:started', {
      sessionId,
      userId,
      username,
      sessionType: 'chat',
      startedAt: new Date()
    });

    console.log(`Chat-only session started: ${sessionId.substring(0, 12)}... for user ${userId}`);

    res.json({
      success: true,
      sessionId,
      sessionType: 'chat',
      message: 'Chat therapy session started'
    });

  } catch (error: unknown) {
    console.error('Failed to start chat session:', error);
    res.status(500).json({
      error: 'Failed to start chat session',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// POST /api/chat/message - Send a message and get AI response
app.post("/api/chat/message", async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  try {
    // Verify session exists and is active
    const sessionCheck = await pool.query(
      'SELECT status, user_id, session_type FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionCheck.rows[0];

    if (session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    if (session.session_type !== 'chat') {
      return res.status(400).json({ error: 'Session is not a chat-only session' });
    }

    // Verify user owns this session (security check)
    const userId = req.session?.userId || req.sessionID;
    if (session.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
    }

    // Send message and get AI response
    const { sendMessage } = await import('./services/chatTherapy.service.js');
    const aiResponse = await sendMessage(sessionId, message);

    // Store both messages in database (content_redacted will be null initially)
    const insertedMessages = await insertMessagesBatch([
      {
        session_id: sessionId,
        role: 'user',
        message_type: 'text',
        content: message,
        content_redacted: null  // Will be populated by async redaction
      },
      {
        session_id: sessionId,
        role: 'assistant',
        message_type: 'text',
        content: aiResponse,
        content_redacted: null  // Will be populated by async redaction
      }
    ]);

    // Queue messages for async PHI/PII redaction
    const { queueRedactionBatch } = await import('./services/redactionQueue.service.js');
    const redactionJobs = insertedMessages.map(msg => ({
      messageId: msg.message_id,
      content: msg.content,
      sessionId: msg.session_id
    }));
    queueRedactionBatch(redactionJobs);
    console.log(`📋 Queued ${redactionJobs.length} chat messages for async redaction`);

    // Emit message events to Socket.io for real-time monitoring
    global.io.to(`session:${sessionId}`).emit('message:new', {
      sessionId,
      role: 'user',
      message,
      timestamp: new Date()
    });

    global.io.to(`session:${sessionId}`).emit('message:new', {
      sessionId,
      role: 'assistant',
      message: aiResponse,
      timestamp: new Date()
    });

    console.log(`[ChatTherapy] Message exchanged for session ${sessionId.substring(0, 12)}...`);

    res.json({
      success: true,
      response: aiResponse,
      sessionId
    });

  } catch (error: unknown) {
    console.error('Failed to process chat message:', error);
    res.status(500).json({
      error: 'Failed to process message',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// POST /api/chat/end - End a chat therapy session
app.post("/api/chat/end", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    // Verify session exists
    const sessionCheck = await pool.query(
      'SELECT status, user_id FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionCheck.rows[0];

    // Verify user owns this session (security check)
    const userId = req.session?.userId || req.sessionID;
    if (session.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
    }

    // If already ended, return success (idempotent)
    if (session.status === 'ended') {
      console.log(`Chat session ${sessionId} already ended, returning existing data (idempotent)`);
      return res.status(200).json({
        ...session,
        alreadyEnded: true,
        message: "Session was already ended"
      });
    }

    // End the chat session (clean up memory)
    const { endChatSession } = await import('./services/chatTherapy.service.js');
    endChatSession(sessionId);

    // Update database
    const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

    // Emit session ended events to Socket.io
    global.io.to('admin-broadcast').emit('session:ended', {
      sessionId,
      endedBy: 'user',
      endedAt: new Date()
    });

    global.io.to(`session:${sessionId}`).emit('session:ended', {
      sessionId,
      endedAt: new Date()
    });

    // Generate session name from conversation history (async, don't block response)
    generateSessionNameAsync(sessionId);

    console.log(`Chat session ${sessionId.substring(0, 12)}... ended by user`);

    res.json({
      success: true,
      message: 'Chat session ended',
      session: updatedSession
    });

  } catch (error: unknown) {
    console.error('Failed to end chat session:', error);
    res.status(500).json({
      error: 'Failed to end session',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// ===================== Sideband WebSocket Control Endpoints =====================

// POST /api/sessions/:sessionId/register-call - Register call_id and establish sideband connection
app.post("/api/sessions/:sessionId/register-call", async (req, res) => {
  const { sessionId } = req.params;
  const { call_id } = req.body;

  if (!call_id) {
    return res.status(400).json({ error: 'call_id is required' });
  }

  try {
    // Verify session exists and is active
    const sessionCheck = await pool.query(
      'SELECT status FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (sessionCheck.rows[0].status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    // Update session with call_id
    await pool.query(
      'UPDATE therapy_sessions SET openai_call_id = $1 WHERE session_id = $2',
      [call_id, sessionId]
    );

    // TODO: Sideband connection - disabled (OpenAI returns 404 for WebRTC sessions)
    // Re-enable when properly researched and implemented
    /*
    const { sidebandManager } = await import('./services/sidebandManager.service.js');
    const apiKey = await getOpenAIKey();

    // Try to connect, but don't wait for it or fail if it errors
    sidebandManager.connect(sessionId, call_id, apiKey).catch(err => {
      console.warn(`[Sideband] Failed to establish connection (feature may not be available): ${err.message}`);
    });

    console.log(`Sideband connection attempt initiated for session ${sessionId.substring(0, 12)}...`);
    */

    res.json({
      success: true,
      message: 'Call registered',
      sessionId,
      call_id
    });

  } catch (error: unknown) {
    console.error('Failed to establish sideband connection:', error);
    res.status(500).json({
      error: 'Failed to establish sideband connection',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// POST /admin/api/sessions/:sessionId/update-instructions - Update AI instructions mid-session
app.post("/admin/api/sessions/:sessionId/update-instructions", requireRole('therapist', 'researcher'), async (req, res) => {
  const { sessionId } = req.params;
  const { instructions } = req.body;

  if (!instructions) {
    return res.status(400).json({ error: 'instructions field is required' });
  }

  try {
    const { sidebandManager } = await import('./services/sidebandManager.service.js');

    if (!sidebandManager.isConnected(sessionId)) {
      return res.status(400).json({ error: 'No active sideband connection for this session' });
    }

    // Send session.update event via sideband
    await sidebandManager.updateSession(sessionId, {
      instructions
    });

    // Emit to admins
    global.io.to('admin-broadcast').emit('session:instructions-updated', {
      sessionId,
      updatedBy: req.session.username,
      timestamp: new Date()
    });

    console.log(`Instructions updated for session ${sessionId} by ${req.session.username}`);

    res.json({
      success: true,
      message: 'Instructions updated successfully'
    });

  } catch (error: unknown) {
    console.error('Failed to update instructions:', error);
    res.status(500).json({
      error: 'Failed to update instructions',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// GET /admin/api/sideband/status - Get global sideband connection status
app.get("/admin/api/sideband/status", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { sidebandManager } = await import('./services/sidebandManager.service.js');

    const activeSessions = sidebandManager.getActiveConnections();

    const result = await pool.query(`
      SELECT
        session_id,
        openai_call_id,
        sideband_connected,
        sideband_connected_at,
        sideband_disconnected_at,
        sideband_error,
        status
      FROM therapy_sessions
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);

    const sessions = result.rows.map(session => ({
      ...session,
      connection_active: activeSessions.includes(session.session_id)
    }));

    res.json({
      total_active_sessions: result.rows.length,
      sideband_connected_count: sessions.filter(s => s.connection_active).length,
      sessions
    });

  } catch (error: unknown) {
    console.error('Failed to fetch sideband status:', error);
    res.status(500).json({
      error: 'Failed to fetch sideband status',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// POST /admin/api/sideband/update-session - Update session instructions via sideband
app.post("/admin/api/sideband/update-session", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { sessionId, instructions } = req.body;

    if (!sessionId || !instructions) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'sessionId and instructions are required'
      });
    }

    const { sidebandManager } = await import('./services/sidebandManager.service.js');

    // Check if connection is active
    if (!sidebandManager.isConnected(sessionId)) {
      return res.status(400).json({
        error: 'No active sideband connection',
        details: 'Session must have an active sideband connection'
      });
    }

    // Update session via sideband
    await sidebandManager.updateSession(sessionId, {
      instructions: instructions.trim()
    });

    // Log the update
    await pool.query(`
      INSERT INTO messages (session_id, role, type, message, metadata)
      VALUES ($1, 'system', 'admin_action', 'Instructions updated via sideband', $2)
    `, [sessionId, JSON.stringify({
      admin_user: req.session.user?.username,
      action: 'update_instructions'
    })]);

    res.json({
      success: true,
      message: 'Session instructions updated successfully'
    });

  } catch (error: unknown) {
    console.error('Failed to update session via sideband:', error);
    res.status(500).json({
      error: 'Failed to update session',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// POST /admin/api/sideband/disconnect - Disconnect sideband connection
app.post("/admin/api/sideband/disconnect", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing sessionId'
      });
    }

    const { sidebandManager } = await import('./services/sidebandManager.service.js');

    // Check if connection exists
    if (!sidebandManager.isConnected(sessionId)) {
      return res.status(400).json({
        error: 'No active sideband connection for this session'
      });
    }

    // Disconnect
    await sidebandManager.disconnect(sessionId);

    // Log the disconnection
    await pool.query(`
      INSERT INTO messages (session_id, role, type, message, metadata)
      VALUES ($1, 'system', 'admin_action', 'Sideband connection manually disconnected', $2)
    `, [sessionId, JSON.stringify({
      admin_user: req.session.user?.username,
      action: 'disconnect_sideband'
    })]);

    res.json({
      success: true,
      message: 'Sideband connection disconnected successfully'
    });

  } catch (error: unknown) {
    console.error('Failed to disconnect sideband:', error);
    res.status(500).json({
      error: 'Failed to disconnect sideband connection',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// // === OLD LOGGING ENDPOINT ===
// app.post("/log", async (req, res) => {
//   const { timestamp, sessionId, role, type, message, extras } = req.body;

//   if (!timestamp || !sessionId || !role || !type || !message) {
//     return res.status(400).send("Missing required log fields");
//   }

//   try {
//     await pool.query(
//       `INSERT INTO conversation_logs (session_id, role, message_type, message, extras, created_at)
//        VALUES ($1, $2, $3, $4, $5, $6)`,
//       [sessionId, role, type, message, extras || null, new Date(timestamp)]
//     );
//     res.sendStatus(200);
//   } catch (err) {
//     console.error("Failed to insert log into DB:", err);
//     res.sendStatus(500);
//   }
// });

// ===================== Session Management API Routes =====================

// POST /api/sessions/create - Create a new therapy session
app.post("/api/sessions/create", async (req, res) => {
  try {
    const userId = req.session?.userId || null; // Use logged-in user if available
    const { sessionName } = req.body;

    const session = await createSession(userId, sessionName);
    res.json(session);
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// GET /api/sessions - List user's sessions (requires auth)
app.get("/api/sessions", requireAuth, async (req, res) => {
  try {
    const { getUserSessions } = await import("./models/dbQueries.js");
    const sessions = await getUserSessions(req.session.userId!);
    res.json(sessions);
  } catch (err) {
    console.error("Failed to fetch sessions:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// GET /api/sessions/:sessionId - Get session details
app.get("/api/sessions/:sessionId", async (req, res) => {
  try {
    const { getSession, getSessionMessages, getSessionConfig } = await import("./models/dbQueries.js");
    const { sessionId } = req.params;
    const session = await getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Check if user has access to this session
    if (session.user_id && session.user_id !== req.session?.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Users can see their own unredacted content
    const messages = await getSessionMessages(sessionId, false); // Unredacted for session owners
    const config = await getSessionConfig(sessionId);

    res.json({
      session,
      messages,
      config
    });
  } catch (err) {
    console.error("Failed to fetch session details:", err);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

// POST /api/sessions/:sessionId/end - End a session (triggers auto-naming)
app.post("/api/sessions/:sessionId/end", async (req, res) => {
  try {
    const { updateSessionStatus } = await import("./models/dbQueries.js");
    const { sessionId } = req.params;

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Check if user has access to this session
    if (session.user_id && session.user_id !== req.session?.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // IDEMPOTENCY CHECK: If already ended, return existing session
    if (session.status === 'ended') {
      console.log(`Session ${sessionId} already ended, returning existing data (idempotent)`);
      return res.status(200).json({
        ...session,
        alreadyEnded: true,
        message: "Session was already ended"
      });
    }

    // Session is active - proceed with ending it (ended by user)
    // TODO: Sideband disconnect - currently disabled
    /*
    const { sidebandManager } = await import('./services/sidebandManager.service.js');
    await sidebandManager.disconnect(sessionId);
    */

    const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

    // Emit session ended events to Socket.io
    global.io.to('admin-broadcast').emit('session:ended', {
      sessionId,
      endedAt: new Date(),
      endedBy: 'user'
    });
    global.io.to(`session:${sessionId}`).emit('session:status', {
      status: 'ended',
      endedBy: 'user'
    });

    // Trigger auto-naming in the background ONLY if we just ended the session
    generateSessionNameAsync(sessionId);

    res.json({
      ...updatedSession,
      message: "Session ended successfully"
    });
  } catch (err) {
    console.error("Failed to end session:", err);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// ===================== Logs batch route with redaction =====================
app.post("/logs/batch", async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).send("No records provided");
  }

  try {
    const messages: InsertMessageInput[] = [];
    const sessionIds = new Set<string>();

    // Process records and collect unique session IDs
    for (const record of records) {
      const { timestamp, sessionId, role, type, message, extras } = record;
      if (!timestamp || !sessionId || !role || !type) continue;

      sessionIds.add(sessionId);

      // Save immediately without waiting for redaction (async queue processing)
      messages.push({
        session_id: sessionId as string,
        role: role as string,
        message_type: type as string,
        content: (message as string | null) ?? null,
        content_redacted: null, // Will be updated asynchronously
        metadata: (extras as Record<string, unknown> | null) || null,
        created_at: new Date(timestamp as string | number)
      });
    }

    if (messages.length === 0) {
      return res.status(400).send("No valid records to insert");
    }

    // Ensure all sessions exist in therapy_sessions table
    const userId = req.session?.userId || null; // Get logged-in user ID from session

    // Debug logging
    if (sessionIds.size > 0) {
      console.log('Processing batch logs with user context:', {
        userId: userId,
        username: req.session?.username,
        sessionCount: sessionIds.size
      });
    }

    for (const sessionId of sessionIds) {
      const existingSession = await getSession(sessionId);
      if (!existingSession) {
        // Create session with user association
        await pool.query(
          `INSERT INTO therapy_sessions (session_id, user_id, status, created_at, updated_at)
           VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (session_id) DO NOTHING`,
          [sessionId, userId]
        );
        console.log(`Created session ${sessionId.substring(0, 12)}... with user_id: ${userId}`);

        // Insert session configuration for newly created session
        try {
          const sessionConfigObj = JSON.parse(sessionConfig);
          await upsertSessionConfig(sessionId, {
            voice: sessionConfigObj.session?.audio?.output?.voice || 'cedar',
            modalities: ['text', 'audio'],
            instructions: sessionConfigObj.session?.instructions || null,
            turn_detection: sessionConfigObj.session?.turn_detection || null,
            tools: sessionConfigObj.session?.tools || null,
            temperature: sessionConfigObj.session?.temperature || 0.8,
            max_response_output_tokens: sessionConfigObj.session?.max_response_output_tokens || 4096
          });
          console.log(`Session configuration created for session: ${sessionId.substring(0, 12)}...`);
        } catch (configError) {
          console.error(`Failed to create session configuration for ${sessionId}:`, configError);
          // Continue anyway - configuration is not critical for message logging
        }
      }
    }

    // Insert all messages
    const insertedMessages = await insertMessagesBatch(messages);

    // ========== QUEUE ASYNC REDACTION ==========
    const { queueRedactionBatch } = await import('./services/redactionQueue.service.js');
    const redactionJobs = insertedMessages.map(msg => ({
      messageId: msg.message_id,
      content: msg.content,
      sessionId: msg.session_id
    }));
    queueRedactionBatch(redactionJobs);
    console.log(`📋 Queued ${redactionJobs.length} messages for async redaction`);

    // ========== MULTI-LAYERED CRISIS DETECTION ==========
    const { analyzeMessageRisk, flagSessionCrisis, logInterventionAction } = await import('./services/crisisDetection.service.js');
    const { executeGraduatedResponse } = await import('./services/crisisIntervention.service.js');

    for (const msg of insertedMessages) {
      // Analyze risk for user and assistant messages
      if (msg.role === 'user' || msg.role === 'assistant') {
        // Get conversation history (last 10 messages)
        const historyResult = await pool.query(
          `SELECT * FROM messages
           WHERE session_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [msg.session_id]
        );

        const conversationHistory = historyResult.rows.reverse(); // Chronological order

        // Perform multi-layered risk analysis
        const riskAnalysis = await analyzeMessageRisk(
          { content: msg.content ?? '', session_id: msg.session_id, message_id: msg.message_id },
          conversationHistory
        );

        if (riskAnalysis.riskScore > 0) {
          console.log(` Risk detected in session ${msg.session_id}:
            Score=${riskAnalysis.riskScore},
            Severity=${riskAnalysis.severity},
            Factors=${JSON.stringify(riskAnalysis.factors)}`);

          // Check current session state
          const sessionCheck = await pool.query(
            `SELECT crisis_flagged, crisis_severity, crisis_risk_score
             FROM therapy_sessions
             WHERE session_id = $1`,
            [msg.session_id]
          );

          const session = sessionCheck.rows[0];
          const currentScore = session?.crisis_risk_score || 0;

          // Flag only on imminent/explicit crisis keywords (severity === 'high')
          const shouldFlag = riskAnalysis.severity === 'high' &&
            (!session.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);

          if (shouldFlag) {
            // Flag session with risk score and factors
            await flagSessionCrisis(
              msg.session_id,
              riskAnalysis.severity,
              riskAnalysis.riskScore,
              'system',
              'auto',
              msg.message_id,
              riskAnalysis.factors,
              `Risk score: ${riskAnalysis.riskScore} - Factors: ${riskAnalysis.factors.join(', ')}`
            );

            // Log intervention triggered
            await logInterventionAction(msg.session_id, 'auto_flag', {
              riskScore: riskAnalysis.riskScore,
              severity: riskAnalysis.severity,
              messageId: msg.message_id,
              factors: riskAnalysis.factors
            });

            // Emit real-time alert to admins
            global.io.to('admin-broadcast').emit('session:crisis-detected', {
              sessionId: msg.session_id,
              severity: riskAnalysis.severity,
              riskScore: riskAnalysis.riskScore,
              factors: riskAnalysis.factors,
              messageId: msg.message_id,
              detectedAt: new Date(),
              message: `${riskAnalysis.severity.toUpperCase()} risk detected (score: ${riskAnalysis.riskScore})`
            });

            // Execute graduated response based on severity
            await executeGraduatedResponse(msg.session_id, riskAnalysis.severity, riskAnalysis.riskScore);

            console.log(`Session ${msg.session_id} flagged as ${riskAnalysis.severity} risk (score: ${riskAnalysis.riskScore})`);
          }
        }
      }
    }
    // ========== END CRISIS DETECTION ==========

    // ========== SOCKET.IO EVENT EMISSION ==========
    // Group messages by session for efficient emission
    type MsgSummary = { message_id: number; role: string; message_type: string; content: string | null; content_redacted: string | null; created_at: Date };
    const sessionGroups: Record<string, MsgSummary[]> = {};
    insertedMessages.forEach(msg => {
      if (!sessionGroups[msg.session_id]) sessionGroups[msg.session_id] = [];
      sessionGroups[msg.session_id].push({
        message_id: msg.message_id,
        role: msg.role,
        message_type: msg.message_type,
        content: msg.content,                   // Original for therapists
        content_redacted: msg.content_redacted, // Redacted for researchers (may be null initially)
        created_at: msg.created_at
      });
    });

    // Emit to Socket.io
    Object.entries(sessionGroups).forEach(([sessionId, msgs]) => {
      // To admins watching this specific session
      global.io.to(`session:${sessionId}`).emit('messages:new', {
        sessionId,
        messages: msgs
      });

      // To all admins (for activity indicators)
      global.io.to('admin-broadcast').emit('session:activity', {
        sessionId,
        messageCount: msgs.length,
        lastActivity: new Date()
      });
    });
    // ========== END SOCKET.IO EVENT EMISSION ==========

    res.sendStatus(200);
  } catch (err) {
    console.error("Failed to insert batch logs into DB:", err);
    res.sendStatus(500);
  }
});

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

async function startProdServer() {
  console.log("Starting in production mode...");

  // Serve static files from the client build directory.
  app.use(express.static(path.resolve(__dirname, '../../dist/client')));

  // Serve admin static assets (CSS, JS) - admin assets are prefixed with "admin-" so no conflicts
  app.use('/assets', express.static(path.resolve(__dirname, '../../dist/admin-client/assets')));

  // Dynamically import all SSR modules
  // @ts-ignore – these modules are generated at build time and not available during type-check
  const { render } = await import('../../dist/server/entry-server.js') as { render: (url: string) => Promise<{ html: string }> };
  // @ts-ignore
  const { render: renderAdmin } = await import('../../dist/admin-server/admin-entry-server.js') as { render: (url: string) => Promise<{ html: string }> };
  // @ts-ignore
  const { render: renderRedact } = await import('../../dist/redact-server/redact-entry-server.js') as { render: (url: string) => Promise<{ html: string }> };

  // Serve redact static assets
  app.use('/redact/assets', express.static(path.resolve(__dirname, '../../dist/redact-client/assets')));

  // Admin panel route
  app.get('/admin', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/admin-client/admin.html'), 'utf-8');
      const appHtml = await renderAdmin(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (e: unknown) {
      const stack = e instanceof Error ? e.stack : String(e);
      console.error(stack);
      res.status(500).end(stack);
    }
  });

  // Redact verification page route
  app.get('/redact', requireRole('researcher'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/redact-client/redact.html'), 'utf-8');
      const appHtml = await renderRedact(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (e: unknown) {
      const stack = e instanceof Error ? e.stack : String(e);
      console.error(stack);
      res.status(500).end(stack);
    }
  });

  // Handle all other requests with main app SSR.
  app.use('*', async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/client/index.html'), 'utf-8');
      const appHtml = await render(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (e: unknown) {
      const stack = e instanceof Error ? e.stack : String(e);
      console.error(stack);
      res.status(500).end(stack);
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

  // Admin panel route in dev
  app.get("/admin", requireRole('therapist', 'researcher'), async (req, res, next) => {
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
  });
}

export { app, httpServer, io };