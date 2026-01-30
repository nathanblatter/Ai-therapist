import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import {getOpenAIKey} from "./config/secrets.js"; // Import the function to get the OpenAI API key
import {pool } from "./config/db.js";
import { requireAuth, requireRole, verifyCredentials, createUser, getAllUsers, getUserById, updateUser, deleteUser } from "./middleware/auth.js";
import { createSession, getSession, insertMessagesBatch, upsertSessionConfig, updateSessionStatus, getAiModel } from "./models/dbQueries.js";
import { generateSessionNameAsync } from "./services/sessionName.service.js";
import { restrictParticipantsToUs } from "./middleware/ipFilter.js";
import { getRetentionSettings, updateRetentionSettings, executeContentWipe, getWipeStats, startScheduler as startContentWipeScheduler, getSchedulerStatus } from "./services/contentWipe.service.js";

// ES module-compatible __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



const app = express();

// Trust first proxy (Nginx) for secure cookies and correct client IP
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

// Cache for system config to avoid database hits on every request
let systemConfigCache = null;
let configCacheTime = null;
const CONFIG_CACHE_TTL = 60000; // 1 minute

async function getSystemConfig() {
  const now = Date.now();

  // Return cached config if still valid
  if (systemConfigCache && configCacheTime && (now - configCacheTime < CONFIG_CACHE_TTL)) {
    return systemConfigCache;
  }

  try {
    const result = await pool.query('SELECT * FROM system_config');
    const config = {};
    result.rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });

    systemConfigCache = config;
    configCacheTime = now;
    return config;
  } catch (err) {
    console.error('Failed to fetch system config:', err);
    // Return defaults if database fails
    return {
      crisis_contact: {
        hotline: 'BYU Counseling and Psychological Services',
        phone: '(801) 422-3035',
        text: 'HELLO to 741741',
        enabled: true
      },
      session_limits: {
        max_duration_minutes: 30,
        max_sessions_per_day: 3,
        cooldown_minutes: 30,
        enabled: true
      }
    };
  }
}

// Session limit enforcement helpers
async function checkSessionLimits(userId, userRole = null) {
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
  const limits = config.session_limits || { enabled: false };

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
      const timeSinceEndMs = now - lastEndedAt;
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

// Helper functions for Salt Lake City timezone calculations
function getNextMidnightSLC() {
  const nowSLC = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const nextMidnight = new Date(nowSLC);
  nextMidnight.setHours(24, 0, 0, 0); // Next midnight SLC time
  return nextMidnight;
}

function getHoursUntilReset() {
  const now = new Date();
  const resetTime = getNextMidnightSLC();
  return (resetTime - now) / (1000 * 60 * 60); // hours
}

// Default system prompt used as fallback if database config is unavailable
const DEFAULT_SYSTEM_PROMPT = `## Purpose & Scope
You are an AI **therapeutic assistant** for adults, providing **general emotional support and therapeutic conversation** only. Use empathy and evidence-based self-help (e.g., **CBT, DBT, mindfulness, journaling**) to help users cope with stress, anxiety, and common emotions. Make it clear: you **support and guide, not replace a human therapist**. Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**. Encourage seeking a **licensed therapist for serious issues**. Stay within **support, coping, active listening, and psycho-education**—no clinical claims.

## Boundaries & Limitations
**Never diagnose, give medication, or legal advice.** Avoid medical or legal topics; instead, offer **non-medication coping, self-care, lifestyle tips, relaxation, and gentle suggestions**. Do not suggest specific drugs/supplements or treatment plans. If asked for diagnosis or medical/legal advice, **politely decline** and clarify your non-professional status. Never misrepresent your credentials. Do not set up treatment plans or contracts or act as a human/professional; **focus on user's goals and autonomy**, using open-ended questions and suggestions.

## Crisis Protocol
**If user expresses risk (suicidality, harm, acute crisis):**
- **Immediately stop normal conversation**
- Urge them to seek emergency help (e.g., {{crisis_text}}).
- State: you are **AI and cannot handle crises**
- Give resources and ask if they'll seek help.
- Do not provide advice or continue therapeutic conversation until user is safe.
- If user reports hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**

## Tone & Interaction Guidelines
Maintain a **calm, nonjudgmental, warm, and inclusive tone**. Validate user experiences and avoid any critical, dismissive, or biased responses. Respect all backgrounds and use **inclusive, trauma-informed language**—let users control how much they share. Avoid pushing for details; gently prompt for preferences. **Empower users**: offer choices, invitations, not commands. Use active listening without oversharing about yourself. Keep responses simple, clear, compassionate—avoid jargon or explain it simply if needed. Always prioritize user autonomy and safety.

## Privacy (HIPAA) Principles
**Treat all communications as confidential**. Do not request or repeat unnecessary personal info. If users provide identifiers, do NOT store unless secure/HIPAA-compliant (if must, de-identify and encrypt). Gently remind users not to overshare sensitive details. At the session start, state: this chat is confidential, you are AI (not a healthcare provider), and users should not provide PHI unless comfortable. **Never share data with outside parties** except required by law or explicit, user-consented emergencies. No user info for ads or non-support purposes.

## Session Framing & Disclaimers
At each session's start, present a brief disclaimer about your **AI identity, purpose, limits, and crisis response** (e.g.: "Hello, I'm an AI mental health support assistant—not a therapist/doctor. I can't diagnose, but I'll listen and offer coping ideas. If you're in crisis, contact {{crisis_text}}. What would you like to talk about?"). Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics). If persistent, reinforce boundaries and suggest consulting professionals. Suggest healthy breaks and discourage dependency if user chats excessively.

At session close, remind users: you're a support tool and for ongoing or serious issues, professional help is best. Reiterate crisis resources as needed. Include legal/safety disclaimers ("This AI is not a licensed healthcare provider."). Encourage users to agree/acknowledge the service boundaries before chatting as required by your platform.

## Content Moderation & Guardrails
- **No diagnosis, no medical or legal advice**
- **Never facilitate harm or illegal activity**
- If user requests inappropriate/graphic help, **refuse and redirect** (especially for non-therapy sexual, violent, or criminal content)
- **Safely escalate to professional help** when issues seem severe/persistent
- **Maintain boundaries**: Refuse inappropriate requests or dependency; reinforce you're AI, not a human/relationship/secret-keeper
- **Technical guardrails**: Abide by system flags or moderation protocols—always prioritize user safety, not engagement
- If a request risks harm or crosses ethical/safety lines, **refuse firmly but empathetically**; safety overrides user satisfaction

**Summary:**
You provide supportive, ethical guidance, never diagnose/prescribe, keep all conversations safe/private, transparently communicate limits, and always refer to professional help in crisis. Be calm, caring, and user-centered—empower, don't direct. Prioritize user safety, confidentiality, and professional boundaries at all times.`;

async function getSystemPrompt(language = 'en', sessionType = 'realtime') {
  const config = await getSystemConfig();
  const crisisContact = config.crisis_contact || {
    hotline: 'BYU Counseling and Psychological Services',
    phone: '(801) 422-3035',
    text: 'HELLO to 741741'
  };

  // Build the crisis text for interpolation
  const crisisText = crisisContact.enabled
    ? `${crisisContact.hotline} ${crisisContact.phone}${crisisContact.text ? ', text ' + crisisContact.text : ''}, or 911`
    : '911 or your local emergency services';

  // Get the prompt from database config, or use default fallback
  let basePrompt = DEFAULT_SYSTEM_PROMPT;
  const systemPrompts = config.system_prompts;
  if (systemPrompts && systemPrompts[sessionType] && systemPrompts[sessionType].prompt) {
    basePrompt = systemPrompts[sessionType].prompt;
  }

  // Interpolate {{crisis_text}} placeholder
  basePrompt = basePrompt.replace(/\{\{crisis_text\}\}/g, crisisText);

  // Get language-specific addition from database config
  const languagesConfig = config.languages || { languages: [], default_language: 'en' };
  const languageObj = languagesConfig.languages
    ? languagesConfig.languages.find(l => l.value === language)
    : null;
  const languageAddition = languageObj?.systemPromptAddition || '';

  return basePrompt + languageAddition;
}

app.use(express.json()); // Needed to parse JSON bodies

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
    secure: false, // Only use secure cookies when explicitly enabled (for HTTPS deployments)
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
io.use((socket, next) => {
  const req = socket.request;

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

  sessionMiddleware(req, {}, (err) => {
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
io.on('connection', (socket) => {
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

// Login endpoint
app.post("/api/auth/login", async (req, res) => {
  const { username, password, mfaToken, backupCode } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await verifyCredentials(username, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Check if MFA is enabled for this user
    console.log('User MFA enabled?', user.mfa_enabled);
    console.log('MFA token provided?', !!mfaToken);
    console.log('Backup code provided?', !!backupCode);

    if (user.mfa_enabled) {
      // MFA is enabled - verify MFA token or backup code
      if (!mfaToken && !backupCode) {
        // First login step - credentials valid, but MFA required
        console.log('Returning mfaRequired response');
        return res.json({
          success: false,
          mfaRequired: true,
          userId: user.userid // Pass userId for MFA verification
        });
      }

      // Verify MFA token or backup code
      const { verifyTOTP, verifyBackupCode, updateBackupCodes, updateMFAVerificationTime } = await import('./services/mfa.service.js');

      let mfaValid = false;

      if (mfaToken) {
        // Verify TOTP token
        mfaValid = verifyTOTP(mfaToken, user.mfa_secret);
      } else if (backupCode) {
        // Verify backup code
        const verification = await verifyBackupCode(backupCode, user.mfa_backup_codes);
        mfaValid = verification.valid;

        if (mfaValid) {
          // Remove used backup code
          await updateBackupCodes(user.userid, verification.remainingCodes);
          console.log(`Backup code used for user ${user.username}. Remaining codes: ${verification.remainingCodes.length}`);
        }
      }

      if (!mfaValid) {
        return res.status(401).json({ error: 'Invalid MFA token or backup code' });
      }

      // Update last MFA verification timestamp
      await updateMFAVerificationTime(user.userid);
    }

    // Set session (after successful MFA or if MFA not enabled)
    req.session.userId = user.userid;
    req.session.username = user.username;
    req.session.userRole = user.role;
    req.session.mfaVerified = true; // Mark that MFA was verified (or not required)

    // Explicitly save session to ensure it persists
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
      } else {
        console.log('User logged in and session saved:', {
          userId: user.userid,
          username: user.username,
          role: user.role,
          mfaVerified: true
        });
      }
    });

    res.json({
      success: true,
      user: {
        userid: user.userid,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Register endpoint (admin only - can be modified based on requirements)
app.post("/api/auth/register", requireRole('researcher'), async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' });
  }

  if (!['therapist', 'researcher', 'participant'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const user = await createUser(username, password, role);

    res.json({
      success: true,
      user: {
        userid: user.userid,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Logout endpoint
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Check auth status
app.get("/api/auth/status", (req, res) => {
  if (req.session?.userId) {
    res.json({
      authenticated: true,
      user: {
        userid: req.session.userId,
        username: req.session.username,
        role: req.session.userRole
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ===================== MFA (Multi-Factor Authentication) Routes =====================

// GET /api/mfa/status - Get MFA status for current user
app.get("/api/mfa/status", requireAuth, async (req, res) => {
  try {
    const { getMFAStatus } = await import('./services/mfa.service.js');
    const status = await getMFAStatus(req.session.userId);

    // Don't send the secret to the client
    delete status.secret;

    res.json({
      success: true,
      mfa: status
    });
  } catch (error) {
    console.error('Failed to get MFA status:', error);
    res.status(500).json({ error: 'Failed to get MFA status' });
  }
});

// POST /api/mfa/setup/init - Initialize MFA setup (generate secret and QR code)
app.post("/api/mfa/setup/init", requireAuth, async (req, res) => {
  try {
    const { generateMFASecret, generateQRCode } = await import('./services/mfa.service.js');

    // Only allow therapists and researchers to enable MFA
    if (req.session.userRole !== 'therapist' && req.session.userRole !== 'researcher') {
      return res.status(403).json({ error: 'MFA is only available for therapist and researcher accounts' });
    }

    // Generate secret
    const { secret, otpauthUrl } = generateMFASecret(req.session.username);

    // Generate QR code
    const qrCode = await generateQRCode(otpauthUrl);

    // Store secret in session temporarily (not in database yet)
    req.session.tempMFASecret = secret;

    res.json({
      success: true,
      secret: secret, // Show to user so they can enter manually if QR code fails
      qrCode: qrCode  // Data URL for QR code image
    });
  } catch (error) {
    console.error('Failed to initialize MFA setup:', error);
    res.status(500).json({ error: 'Failed to initialize MFA setup' });
  }
});

// POST /api/mfa/setup/verify - Verify MFA token and complete setup
app.post("/api/mfa/setup/verify", requireAuth, async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const { verifyTOTP, generateBackupCodes, enableMFA } = await import('./services/mfa.service.js');

    // Get temporary secret from session
    const secret = req.session.tempMFASecret;

    if (!secret) {
      return res.status(400).json({ error: 'MFA setup not initialized. Please start setup again.' });
    }

    // Verify the token
    const isValid = verifyTOTP(token, secret);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid token. Please try again.' });
    }

    // Generate backup codes
    const { codes, hashedCodes } = await generateBackupCodes(10);

    // Enable MFA in database
    await enableMFA(req.session.userId, secret, hashedCodes);

    // Clear temporary secret from session
    delete req.session.tempMFASecret;

    console.log(`MFA enabled for user ${req.session.username}`);

    res.json({
      success: true,
      message: 'MFA enabled successfully',
      backupCodes: codes // Return plain codes to user (only time they're shown)
    });
  } catch (error) {
    console.error('Failed to verify MFA setup:', error);
    res.status(500).json({ error: 'Failed to complete MFA setup' });
  }
});

// POST /api/mfa/disable - Disable MFA for current user
app.post("/api/mfa/disable", requireAuth, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password is required to disable MFA' });
  }

  try {
    const { verifyCredentials } = await import('./middleware/auth.js');
    const { disableMFA } = await import('./services/mfa.service.js');

    // Verify password before disabling MFA
    const user = await verifyCredentials(req.session.username, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Disable MFA
    await disableMFA(req.session.userId);

    console.log(`MFA disabled for user ${req.session.username}`);

    res.json({
      success: true,
      message: 'MFA disabled successfully'
    });
  } catch (error) {
    console.error('Failed to disable MFA:', error);
    res.status(500).json({ error: 'Failed to disable MFA' });
  }
});

// POST /api/mfa/regenerate-backup-codes - Generate new backup codes
app.post("/api/mfa/regenerate-backup-codes", requireAuth, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password is required to regenerate backup codes' });
  }

  try {
    const { verifyCredentials } = await import('./middleware/auth.js');
    const { generateBackupCodes, updateBackupCodes, getMFAStatus } = await import('./services/mfa.service.js');

    // Verify password
    const user = await verifyCredentials(req.session.username, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Check if MFA is enabled
    const mfaStatus = await getMFAStatus(req.session.userId);

    if (!mfaStatus.enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    // Generate new backup codes
    const { codes, hashedCodes } = await generateBackupCodes(10);

    // Update backup codes in database
    await updateBackupCodes(req.session.userId, hashedCodes);

    console.log(`Backup codes regenerated for user ${req.session.username}`);

    res.json({
      success: true,
      message: 'Backup codes regenerated successfully',
      backupCodes: codes // Return new codes to user
    });
  } catch (error) {
    console.error('Failed to regenerate backup codes:', error);
    res.status(500).json({ error: 'Failed to regenerate backup codes' });
  }
});

// GET /api/rate-limits/status - Get current user's rate limit status
app.get('/api/rate-limits/status', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const userRole = req.session.userRole;

    // Check if user is exempt
    if (userRole === 'researcher') {
      return res.json({
        is_rate_limited: false,
        is_exempt: true,
        exemption_reason: 'researcher'
      });
    }

    const config = await getSystemConfig();
    const limits = config.session_limits || { enabled: false };

    if (!limits.enabled) {
      return res.json({ is_rate_limited: false, is_exempt: true, exemption_reason: 'limits_disabled' });
    }

    // Get today's session count
    const todayStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
    todayStart.setHours(0, 0, 0, 0);

    const result = await pool.query(`
      SELECT COUNT(*) as session_count, MAX(created_at) as last_session_at
      FROM therapy_sessions
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, todayStart]);

    const sessionsToday = parseInt(result.rows[0].session_count);
    const isRateLimited = sessionsToday >= limits.max_sessions_per_day;

    res.json({
      is_rate_limited: isRateLimited,
      sessions_used_today: sessionsToday,
      session_limit: limits.max_sessions_per_day,
      limit_resets_at: getNextMidnightSLC().toISOString(),
      hours_until_reset: getHoursUntilReset(),
      last_session_at: result.rows[0].last_session_at,
      is_exempt: false,
      exemption_reason: null
    });
  } catch (err) {
    console.error('Error fetching rate limit status:', err);
    res.status(500).json({ error: 'Failed to fetch rate limit status' });
  }
});

// ===================== User Management API Routes =====================

// GET /api/users - Get all users (researcher only)
app.get("/api/users", requireRole('researcher'), async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ===================== User Preferences Endpoints =====================
// NOTE: These MUST come before /api/users/:userid to avoid route conflicts

// GET /api/users/preferences - Get user's voice and language preferences
app.get("/api/users/preferences", requireAuth, async (req, res) => {
  const userId = req.session.userId;

  try {
    const result = await pool.query(
      'SELECT preferred_voice, preferred_language FROM users WHERE userid = $1',
      [userId]
    );

    // Get system config for enabled voices/languages
    const config = await getSystemConfig();
    const voicesConfig = config.voices || {
      voices: [
        { value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }
      ],
      default_voice: 'cedar'
    };
    const languagesConfig = config.languages || {
      languages: [
        { value: 'en', label: 'English', description: 'English', enabled: true }
      ],
      default_language: 'en'
    };

    let voice = voicesConfig.default_voice;
    let language = languagesConfig.default_language;

    if (result.rows.length > 0) {
      const userVoice = result.rows[0].preferred_voice;
      const userLanguage = result.rows[0].preferred_language;

      // Check if user's preference is still enabled
      const voiceEnabled = voicesConfig.voices
        ? voicesConfig.voices.find(v => v.value === userVoice && v.enabled)
        : null;
      const languageEnabled = languagesConfig.languages
        ? languagesConfig.languages.find(l => l.value === userLanguage && l.enabled)
        : null;

      voice = voiceEnabled ? userVoice : voicesConfig.default_voice;
      language = languageEnabled ? userLanguage : languagesConfig.default_language;

      // Log fallback
      if (userVoice && !voiceEnabled) {
        console.log(`User ${userId} preferred voice '${userVoice}' is disabled, falling back to '${voice}'`);
      }
      if (userLanguage && !languageEnabled) {
        console.log(`User ${userId} preferred language '${userLanguage}' is disabled, falling back to '${language}'`);
      }
    }

    res.json({ voice, language });
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// PUT /api/users/preferences - Save user preferences
app.put("/api/users/preferences", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { voice, language } = req.body;

  if (!voice || !language) {
    return res.status(400).json({ error: 'Voice and language are required' });
  }

  try {
    // Validate against enabled options
    const config = await getSystemConfig();
    const voicesConfig = config.voices || {
      voices: [
        { value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }
      ],
      default_voice: 'cedar'
    };
    const languagesConfig = config.languages || {
      languages: [
        { value: 'en', label: 'English', description: 'English', enabled: true }
      ],
      default_language: 'en'
    };

    const voiceEnabled = voicesConfig.voices
      ? voicesConfig.voices.find(v => v.value === voice && v.enabled)
      : null;
    const languageEnabled = languagesConfig.languages
      ? languagesConfig.languages.find(l => l.value === language && l.enabled)
      : null;

    if (!voiceEnabled) {
      return res.status(400).json({ error: `Voice '${voice}' is not available` });
    }
    if (!languageEnabled) {
      return res.status(400).json({ error: `Language '${language}' is not available` });
    }

    await pool.query(
      'UPDATE users SET preferred_voice = $1, preferred_language = $2 WHERE userid = $3',
      [voice, language, userId]
    );

    console.log(`Updated preferences for user ${userId}: voice=${voice}, language=${language}`);

    res.json({ success: true, voice, language });
  } catch (error) {
    console.error('Error saving user preferences:', error);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// GET /api/users/:userid - Get user by ID (researcher only or self)
app.get("/api/users/:userid", requireAuth, async (req, res) => {
  const { userid } = req.params;
  const requestingUserId = req.session.userId;
  const requestingUserRole = req.session.userRole;

  // Users can only view their own profile unless they're a researcher
  if (requestingUserRole !== 'researcher' && parseInt(userid) !== requestingUserId) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const user = await getUserById(userid);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT /api/users/:userid - Update user (researcher only or self with restrictions)
app.put("/api/users/:userid", requireAuth, async (req, res) => {
  const { userid } = req.params;
  const requestingUserId = req.session.userId;
  const requestingUserRole = req.session.userRole;
  const { username, password, role } = req.body;

  // Check permissions
  const isSelf = parseInt(userid) === requestingUserId;
  const isResearcher = requestingUserRole === 'researcher';

  if (!isSelf && !isResearcher) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // Non-researchers can only update their own username and password, not role
  if (!isResearcher && role !== undefined) {
    return res.status(403).json({ error: 'Only researchers can change user roles' });
  }

  try {
    const updates = {};
    if (username !== undefined) updates.username = username;
    if (password !== undefined) updates.password = password;
    if (role !== undefined && isResearcher) updates.role = role;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const updatedUser = await updateUser(userid, updates);

    // Update session if user updated their own info
    if (isSelf) {
      if (updates.username) req.session.username = updatedUser.username;
      if (updates.role) req.session.userRole = updatedUser.role;
    }

    res.json({
      success: true,
      user: updatedUser
    });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    if (error.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:userid - Delete user (researcher only)
app.delete("/api/users/:userid", requireRole('researcher'), async (req, res) => {
  const { userid } = req.params;

  try {
    const deletedUser = await deleteUser(userid);
    res.json({
      success: true,
      message: `User ${deletedUser.username} deleted successfully`
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// POST /api/users - Create new user (researcher only)
app.post("/api/users", requireRole('researcher'), async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' });
  }

  if (!['therapist', 'researcher', 'participant'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const user = await createUser(username, password, role);

    res.json({
      success: true,
      user: {
        userid: user.userid,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('User creation error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

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
          const durationMs = limitCheck.limits.max_duration_minutes * 60 * 1000;
          setTimeout(async () => {
            try {
              // Check if session is still active
              const checkResult = await pool.query(
                'SELECT status FROM therapy_sessions WHERE session_id = $1',
                [sessionId]
              );

              if (checkResult.rows.length > 0 && checkResult.rows[0].status === 'active') {
                console.log(`⏰ Auto-terminating session ${sessionId} after ${limitCheck.limits.max_duration_minutes} minutes`);

                // End the session
                const { updateSessionStatus } = await import("./models/dbQueries.js");
                await updateSessionStatus(sessionId, 'ended', 'system');

                // Handle room assignment cleanup and queue promotion
                await handleSessionEndRoomCleanup(sessionId);

                // Notify the user via Socket.io
                global.io.to(`session:${sessionId}`).emit('session:status', {
                  status: 'ended',
                  endedBy: 'system',
                  reason: 'duration_limit',
                  message: `Your session has ended after ${limitCheck.limits.max_duration_minutes} minutes (maximum session duration).`,
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

          console.log(`Session ${sessionId} will auto-terminate in ${limitCheck.limits.max_duration_minutes} minutes`);
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
  const userId = req.session?.userId || req.sessionID; // Use session userId or fallback to sessionID for anonymous

  try {
    // Check session limits (same as /token endpoint)
    const userRole = req.session?.userRole || 'participant';
    const limitCheck = await checkSessionLimits(userId, userRole);

    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: 'Session limit exceeded',
        reason: limitCheck.reason,
        timeRemaining: limitCheck.timeRemaining
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
      userId,
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

  } catch (error) {
    console.error('Failed to start chat session:', error);
    res.status(500).json({
      error: 'Failed to start chat session',
      details: error.message
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

  } catch (error) {
    console.error('Failed to process chat message:', error);
    res.status(500).json({
      error: 'Failed to process message',
      details: error.message
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

    // Handle room assignment cleanup and queue promotion
    await handleSessionEndRoomCleanup(sessionId);

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

  } catch (error) {
    console.error('Failed to end chat session:', error);
    res.status(500).json({
      error: 'Failed to end session',
      details: error.message
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

  } catch (error) {
    console.error('Failed to establish sideband connection:', error);
    res.status(500).json({
      error: 'Failed to establish sideband connection',
      details: error.message
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

  } catch (error) {
    console.error('Failed to update instructions:', error);
    res.status(500).json({
      error: 'Failed to update instructions',
      details: error.message
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

  } catch (error) {
    console.error('Failed to fetch sideband status:', error);
    res.status(500).json({
      error: 'Failed to fetch sideband status',
      details: error.message
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

  } catch (error) {
    console.error('Failed to update session via sideband:', error);
    res.status(500).json({
      error: 'Failed to update session',
      details: error.message
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

  } catch (error) {
    console.error('Failed to disconnect sideband:', error);
    res.status(500).json({
      error: 'Failed to disconnect sideband connection',
      details: error.message
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
    const sessions = await getUserSessions(req.session.userId);
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

    // Handle room assignment cleanup and queue promotion
    await handleSessionEndRoomCleanup(sessionId);

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
    const messages = [];
    const sessionIds = new Set();

    // Process records and collect unique session IDs
    for (const record of records) {
      const { timestamp, sessionId, role, type, message, extras } = record;
      if (!timestamp || !sessionId || !role || !type) continue;

      sessionIds.add(sessionId);

      // Save immediately without waiting for redaction (async queue processing)
      messages.push({
        session_id: sessionId,
        role: role,
        message_type: type,
        content: message,
        content_redacted: null, // Will be updated asynchronously
        metadata: extras || null,
        created_at: new Date(timestamp)
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
        const riskAnalysis = await analyzeMessageRisk(msg, conversationHistory);

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

          // Flag if score exceeds threshold (>30) or increases significantly
          const shouldFlag = riskAnalysis.riskScore > 30 &&
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
    const sessionGroups = {};
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

// GET /admin/api/sessions/active - List all active sessions
app.get("/admin/api/sessions/active", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ts.session_id,
        ts.user_id,
        ts.session_name,
        u.username,
        ts.status,
        ts.created_at,
        ts.crisis_flagged,
        ts.crisis_severity,
        ts.crisis_risk_score,
        ts.crisis_flagged_at,
        ts.crisis_flagged_by,
        COUNT(m.message_id) as message_count,
        MAX(m.created_at) as last_activity,
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ts.created_at)) as duration_seconds
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      LEFT JOIN messages m ON ts.session_id = m.session_id
      WHERE ts.status = 'active'
      GROUP BY ts.session_id, u.username
      ORDER BY ts.crisis_flagged DESC, ts.created_at DESC
    `);

    res.json({ sessions: result.rows });
  } catch (err) {
    console.error("Failed to fetch active sessions:", err);
    res.status(500).json({ error: "Failed to fetch active sessions" });
  }
});

// POST /admin/api/sessions/:sessionId/end - Admin remote session termination
app.post("/admin/api/sessions/:sessionId/end", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { updateSessionStatus } = await import("./models/dbQueries.js");
    const { sessionId } = req.params;

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Admin bypass: therapists and researchers can end any session

    // IDEMPOTENCY CHECK: If already ended, return existing session
    if (session.status === 'ended') {
      console.log(`Admin: Session ${sessionId} already ended, returning existing data (idempotent)`);
      return res.status(200).json({
        ...session,
        alreadyEnded: true,
        message: "Session was already ended"
      });
    }

    // Session is active - proceed with ending it (ended by admin)
    // TODO: Sideband disconnect - currently disabled
    /*
    const { sidebandManager } = await import('./services/sidebandManager.service.js');
    await sidebandManager.disconnect(sessionId);
    */

    const updatedSession = await updateSessionStatus(sessionId, 'ended', req.session.username);

    // Handle room assignment cleanup and queue promotion
    await handleSessionEndRoomCleanup(sessionId);

    // Emit session ended events to Socket.io
    global.io.to('admin-broadcast').emit('session:ended', {
      sessionId,
      endedAt: new Date(),
      endedBy: req.session.username  // Track who ended it
    });
    global.io.to(`session:${sessionId}`).emit('session:status', {
      status: 'ended',
      endedBy: req.session.username,
      remoteTermination: true  // Flag to indicate this was a remote termination
    });

    // Trigger auto-naming in the background
    generateSessionNameAsync(sessionId);

    console.log(`Admin ${req.session.username} remotely ended session ${sessionId}`);

    res.json({
      ...updatedSession,
      message: "Session ended successfully by admin",
      endedBy: req.session.username
    });
  } catch (err) {
    console.error("Failed to end session:", err);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// GET /admin/api/sessions - List all sessions with filters
app.get("/admin/api/sessions", requireRole('therapist', 'researcher'), async (req, res) => {
  const {
    search, startDate, endDate, minMessages, maxMessages,
    page = 1, limit = 50,
    // New filters
    voices, languages, durations, sessionTypes, statuses, endedBy,
    crisisFlagged, crisisSeverity
  } = req.query;

  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Parse comma-separated arrays
    const voiceArray = voices ? voices.split(',').filter(Boolean) : null;
    const languageArray = languages ? languages.split(',').filter(Boolean) : null;
    const durationArray = durations ? durations.split(',').filter(Boolean) : null;
    const sessionTypeArray = sessionTypes ? sessionTypes.split(',').filter(Boolean) : null;
    const statusArray = statuses ? statuses.split(',').filter(Boolean) : null;
    const endedByArray = endedBy ? endedBy.split(',').filter(Boolean) : null;

    const result = await pool.query(`
      WITH session_stats AS (
        SELECT
          ts.session_id,
          ts.session_name,
          ts.user_id,
          u.username,
          ts.status,
          ts.session_type,
          ts.created_at AS start_time,
          ts.ended_at AS end_time,
          ts.ended_by,
          ts.crisis_flagged,
          ts.crisis_severity,
          sc.voice,
          sc.language,
          EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) AS duration_seconds,
          CASE
            WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 300 THEN 'short'
            WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 1800 THEN 'medium'
            ELSE 'long'
          END AS duration_category,
          COUNT(m.message_id) AS total_messages,
          COUNT(m.message_id) FILTER (WHERE m.role = 'user') AS user_messages,
          COUNT(m.message_id) FILTER (WHERE m.role = 'assistant') AS assistant_messages,
          COUNT(m.message_id) FILTER (WHERE m.message_type = 'voice') AS voice_messages,
          COUNT(m.message_id) FILTER (WHERE m.message_type = 'chat') AS chat_messages
        FROM therapy_sessions ts
        LEFT JOIN users u ON ts.user_id = u.userid
        LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
        LEFT JOIN messages m ON ts.session_id = m.session_id
        WHERE
          ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
          AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
          AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
          AND ($8::TEXT[] IS NULL OR sc.voice = ANY($8))
          AND ($9::TEXT[] IS NULL OR sc.language = ANY($9))
          AND ($10::TEXT[] IS NULL OR ts.session_type = ANY($10))
          AND ($11::TEXT[] IS NULL OR ts.status = ANY($11))
          AND ($12::TEXT[] IS NULL OR ts.ended_by = ANY($12))
          AND ($13::BOOLEAN IS NULL OR ts.crisis_flagged = $13)
          AND ($14::TEXT IS NULL OR ts.crisis_severity = $14)
        GROUP BY ts.session_id, u.username, ts.ended_by, ts.session_type, ts.crisis_flagged, ts.crisis_severity, sc.voice, sc.language
      )
      SELECT * FROM session_stats
      WHERE
        ($4::INT IS NULL OR total_messages >= $4)
        AND ($5::INT IS NULL OR total_messages <= $5)
        AND ($15::TEXT[] IS NULL OR duration_category = ANY($15))
      ORDER BY start_time DESC
      LIMIT $6 OFFSET $7
    `, [
      search || null,                                    // $1
      startDate || null,                                 // $2
      endDate || null,                                   // $3
      minMessages ? parseInt(minMessages) : null,        // $4
      maxMessages ? parseInt(maxMessages) : null,        // $5
      parseInt(limit),                                   // $6
      offset,                                            // $7
      voiceArray,                                        // $8
      languageArray,                                     // $9
      sessionTypeArray,                                  // $10
      statusArray,                                       // $11
      endedByArray,                                      // $12
      crisisFlagged === 'true' ? true :                  // $13
        crisisFlagged === 'false' ? false : null,
      crisisSeverity || null,                            // $14
      durationArray                                      // $15
    ]);

    // Get total count for pagination
    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT ts.session_id) as total
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
      WHERE
        ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
        AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
        AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
        AND ($4::TEXT[] IS NULL OR sc.voice = ANY($4))
        AND ($5::TEXT[] IS NULL OR sc.language = ANY($5))
        AND ($6::TEXT[] IS NULL OR ts.session_type = ANY($6))
        AND ($7::TEXT[] IS NULL OR ts.status = ANY($7))
        AND ($8::TEXT[] IS NULL OR ts.ended_by = ANY($8))
        AND ($9::BOOLEAN IS NULL OR ts.crisis_flagged = $9)
        AND ($10::TEXT IS NULL OR ts.crisis_severity = $10)
    `, [
      search || null,
      startDate || null,
      endDate || null,
      voiceArray,
      languageArray,
      sessionTypeArray,
      statusArray,
      endedByArray,
      crisisFlagged === 'true' ? true : crisisFlagged === 'false' ? false : null,
      crisisSeverity || null
    ]);

    res.json({
      sessions: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount: parseInt(countResult.rows[0].total)
      }
    });
  } catch (err) {
    console.error("Failed to fetch sessions:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// GET /admin/api/sessions/:sessionId - Get full conversation
app.get("/admin/api/sessions/:sessionId", requireRole('therapist', 'researcher'), async (req, res) => {
  const { sessionId } = req.params;

  try {
    // Get session metadata
    const sessionResult = await pool.query(`
      SELECT
        ts.*,
        u.username
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      WHERE ts.session_id = $1
    `, [sessionId]);

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Get messages - use content_redacted for researchers, full content for therapists
    const contentColumn = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';
    const messagesResult = await pool.query(`
      SELECT
        message_id,
        session_id,
        role,
        message_type,
        ${contentColumn} as message,
        metadata as extras,
        created_at
      FROM messages
      WHERE session_id = $1
      ORDER BY created_at ASC
    `, [sessionId]);

    res.json({
      session: sessionResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (err) {
    console.error("Failed to fetch session details:", err);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

// DELETE /admin/api/sessions/:sessionId - Delete a session and all associated data
app.delete("/admin/api/sessions/:sessionId", requireRole('therapist', 'researcher'), async (req, res) => {
  const { sessionId } = req.params;

  try {
    const { deleteSession } = await import("./models/dbQueries.js");
    const deletedSession = await deleteSession(sessionId);

    res.json({
      success: true,
      message: `Session ${deletedSession.session_name || sessionId} deleted successfully`
    });
  } catch (error) {
    if (error.message === 'Session not found') {
      return res.status(404).json({ error: 'Session not found' });
    }
    console.error("Failed to delete session:", error);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// PUT /admin/api/messages/:messageId - Update a message
app.put("/admin/api/messages/:messageId", requireRole('therapist', 'researcher'), async (req, res) => {
  const { messageId } = req.params;
  const { content } = req.body;

  // Validation
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message content cannot be empty' });
  }

  try {
    const { updateMessage } = await import("./models/dbQueries.js");

    // Determine which field to update based on user role
    const fieldToUpdate = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';

    // Create edit metadata
    const editMetadata = {
      edited: true,
      edited_at: new Date().toISOString(),
      edited_by: req.session.username
    };

    const updatedMessage = await updateMessage(messageId, content, fieldToUpdate, editMetadata);

    // Return message in same format as GET endpoint - with 'message' field containing the appropriate content for the user's role
    const contentField = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';
    const formattedMessage = {
      message_id: updatedMessage.message_id,
      session_id: updatedMessage.session_id,
      role: updatedMessage.role,
      message_type: updatedMessage.message_type,
      message: updatedMessage[contentField], // Use the appropriate field based on role
      extras: updatedMessage.metadata,
      created_at: updatedMessage.created_at
    };

    res.json({
      success: true,
      message: formattedMessage
    });
  } catch (error) {
    if (error.message === 'Message not found') {
      return res.status(404).json({ error: 'Message not found' });
    }
    console.error("Failed to update message:", error);
    res.status(500).json({ error: "Failed to update message" });
  }
});

// DELETE /admin/api/messages/:messageId - Delete a message
app.delete("/admin/api/messages/:messageId", requireRole('therapist', 'researcher'), async (req, res) => {
  const { messageId } = req.params;

  try {
    const { deleteMessage } = await import("./models/dbQueries.js");
    const deletedMessage = await deleteMessage(messageId);

    res.json({
      success: true,
      message: "Message deleted successfully",
      deletedMessage
    });
  } catch (error) {
    if (error.message === 'Message not found') {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (error.message === 'Cannot delete the last message in a session') {
      return res.status(400).json({ error: 'Cannot delete the last message in a session' });
    }
    console.error("Failed to delete message:", error);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

// GET /admin/api/analytics - Dashboard metrics
app.get("/admin/api/analytics", requireRole('therapist', 'researcher'), async (req, res) => {
  const {
    startDate, endDate,
    // New filters
    voices, languages, sessionTypes, statuses, endedBy, crisisFlagged
  } = req.query;

  try {
    // Parse comma-separated arrays
    const voiceArray = voices ? voices.split(',').filter(Boolean) : null;
    const languageArray = languages ? languages.split(',').filter(Boolean) : null;
    const sessionTypeArray = sessionTypes ? sessionTypes.split(',').filter(Boolean) : null;
    const statusArray = statuses ? statuses.split(',').filter(Boolean) : null;
    const endedByArray = endedBy ? endedBy.split(',').filter(Boolean) : null;

    const result = await pool.query(`
      WITH date_filtered_sessions AS (
        SELECT ts.*
        FROM therapy_sessions ts
        LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
        WHERE
          ($1::TIMESTAMP IS NULL OR ts.created_at >= $1)
          AND ($2::TIMESTAMP IS NULL OR ts.created_at <= $2)
          AND ($3::TEXT[] IS NULL OR sc.voice = ANY($3))
          AND ($4::TEXT[] IS NULL OR sc.language = ANY($4))
          AND ($5::TEXT[] IS NULL OR ts.session_type = ANY($5))
          AND ($6::TEXT[] IS NULL OR ts.status = ANY($6))
          AND ($7::TEXT[] IS NULL OR ts.ended_by = ANY($7))
          AND ($8::BOOLEAN IS NULL OR ts.crisis_flagged = $8)
      ),
      date_filtered_messages AS (
        SELECT m.* FROM messages m
        INNER JOIN date_filtered_sessions ts ON m.session_id = ts.session_id
      ),
      session_metrics AS (
        SELECT
          COUNT(DISTINCT ts.session_id) AS total_sessions,
          COUNT(DISTINCT ts.user_id) FILTER (WHERE ts.user_id IS NOT NULL) AS authenticated_sessions,
          COUNT(*) FILTER (WHERE ts.status = 'active') AS active_sessions,
          COUNT(*) FILTER (WHERE ts.status = 'ended') AS ended_sessions,
          AVG(EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at))) FILTER (WHERE ts.ended_at IS NOT NULL) AS avg_duration_seconds
        FROM date_filtered_sessions ts
      ),
      message_metrics AS (
        SELECT
          COUNT(*) AS total_messages,
          AVG(msg_count) AS avg_messages_per_session
        FROM (
          SELECT
            session_id,
            COUNT(*) AS msg_count
          FROM date_filtered_messages
          GROUP BY session_id
        ) AS session_msg_counts
      ),
      message_breakdown AS (
        SELECT
          COUNT(*) FILTER (WHERE message_type = 'voice') AS voice_messages,
          COUNT(*) FILTER (WHERE message_type = 'chat') AS chat_messages,
          COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_messages
        FROM date_filtered_messages
      ),
      daily_sessions AS (
        SELECT
          DATE(created_at) AS date,
          COUNT(*) AS session_count
        FROM date_filtered_sessions
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      ),
      user_session_counts AS (
        SELECT
          u.username,
          u.userid,
          COUNT(DISTINCT ts.session_id) AS session_count
        FROM users u
        LEFT JOIN date_filtered_sessions ts ON u.userid = ts.user_id
        WHERE ts.user_id IS NOT NULL
        GROUP BY u.userid, u.username
        ORDER BY session_count DESC
        LIMIT 50
      ),
      time_period_distribution AS (
        SELECT
          CASE
            WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') >= 7
                 AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') < 12
            THEN 'Morning'
            WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') >= 12
                 AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') < 17
            THEN 'Afternoon'
            ELSE 'Evening'
          END AS time_period,
          COUNT(*) AS session_count
        FROM date_filtered_sessions
        GROUP BY time_period
      ),
      duration_distribution AS (
        SELECT
          CASE
            WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 300 THEN 'Short (0-5 min)'
            WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 1800 THEN 'Medium (5-30 min)'
            ELSE 'Long (30+ min)'
          END AS duration_category,
          COUNT(*) AS session_count
        FROM date_filtered_sessions
        WHERE ended_at IS NOT NULL
        GROUP BY duration_category
      ),
      daily_duration AS (
        SELECT
          DATE(created_at) AS date,
          AVG(EXTRACT(EPOCH FROM (ended_at - created_at))) AS avg_duration_seconds
        FROM date_filtered_sessions
        WHERE ended_at IS NOT NULL
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      ),
      language_stats AS (
        SELECT
          sc.language,
          COUNT(*) AS session_count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS percentage
        FROM session_configurations sc
        JOIN date_filtered_sessions ts ON sc.session_id = ts.session_id
        WHERE sc.language IS NOT NULL
        GROUP BY sc.language
        ORDER BY session_count DESC
      ),
      voice_stats AS (
        SELECT
          sc.voice,
          COUNT(*) AS session_count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS percentage
        FROM session_configurations sc
        JOIN date_filtered_sessions ts ON sc.session_id = ts.session_id
        WHERE sc.voice IS NOT NULL
        GROUP BY sc.voice
        ORDER BY session_count DESC
      ),
      -- Session Completion Patterns
      completion_by_ended_by AS (
        SELECT
          COALESCE(ended_by, 'unknown') AS ended_by,
          COUNT(*) AS session_count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS percentage
        FROM date_filtered_sessions
        WHERE status = 'ended'
        GROUP BY ended_by
      ),
      abandonment_rate AS (
        SELECT
          COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (ended_at - created_at)) < 60) AS abandoned_sessions,
          COUNT(*) FILTER (WHERE ended_at IS NOT NULL) AS completed_sessions,
          ROUND(
            COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (ended_at - created_at)) < 60) * 100.0 /
            NULLIF(COUNT(*) FILTER (WHERE ended_at IS NOT NULL), 0),
            2
          ) AS abandonment_rate_percentage
        FROM date_filtered_sessions
      ),
      session_depth_by_user_type AS (
        SELECT
          CASE
            WHEN ts.user_id IS NOT NULL THEN 'authenticated'
            ELSE 'anonymous'
          END AS user_type,
          AVG(msg_count) AS avg_messages,
          COUNT(*) AS session_count
        FROM (
          SELECT
            ts.session_id,
            ts.user_id,
            COUNT(m.message_id) AS msg_count
          FROM date_filtered_sessions ts
          LEFT JOIN messages m ON ts.session_id = m.session_id
          GROUP BY ts.session_id, ts.user_id
        ) ts
        GROUP BY user_type
      ),
      -- Engagement Metrics
      messages_per_minute AS (
        SELECT
          AVG(
            CASE
              WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) > 0
              THEN msg_count / (EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) / 60.0)
              ELSE 0
            END
          ) AS avg_messages_per_minute
        FROM (
          SELECT
            ts.session_id,
            ts.created_at,
            ts.ended_at,
            COUNT(m.message_id) AS msg_count
          FROM date_filtered_sessions ts
          LEFT JOIN messages m ON ts.session_id = m.session_id
          WHERE ts.ended_at IS NOT NULL
          GROUP BY ts.session_id, ts.created_at, ts.ended_at
        ) ts
      ),
      response_times AS (
        SELECT
          AVG(response_time_seconds) AS avg_response_time_seconds,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_seconds) AS median_response_time_seconds,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_seconds) AS p95_response_time_seconds
        FROM (
          SELECT
            EXTRACT(EPOCH FROM (assistant_msg.created_at - user_msg.created_at)) AS response_time_seconds
          FROM (
            SELECT
              session_id,
              created_at,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at) AS msg_order
            FROM messages
            WHERE role = 'user'
          ) user_msg
          INNER JOIN (
            SELECT
              session_id,
              created_at,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at) AS msg_order
            FROM messages
            WHERE role = 'assistant'
          ) assistant_msg
          ON user_msg.session_id = assistant_msg.session_id
          AND assistant_msg.msg_order = user_msg.msg_order + 1
          WHERE assistant_msg.created_at > user_msg.created_at
        ) response_times
      ),
      turn_taking_ratio AS (
        SELECT
          COUNT(*) FILTER (WHERE role = 'user')::DECIMAL /
          NULLIF(COUNT(*) FILTER (WHERE role = 'assistant'), 0) AS user_to_assistant_ratio,
          COUNT(*) FILTER (WHERE role = 'user') AS total_user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') AS total_assistant_messages
        FROM date_filtered_messages
      )
      SELECT
        (SELECT row_to_json(sm.*) FROM (SELECT sm.*, mm.total_messages, mm.avg_messages_per_session FROM session_metrics sm, message_metrics mm) sm) AS metrics,
        (SELECT row_to_json(message_breakdown.*) FROM message_breakdown) AS breakdown,
        (SELECT json_agg(daily_sessions.*) FROM daily_sessions) AS daily_trend,
        (SELECT json_agg(user_session_counts.*) FROM user_session_counts) AS user_sessions,
        (SELECT json_agg(time_period_distribution.*) FROM time_period_distribution) AS time_distribution,
        (SELECT json_agg(duration_distribution.*) FROM duration_distribution) AS duration_distribution,
        (SELECT json_agg(daily_duration.*) FROM daily_duration) AS duration_trend,
        (SELECT json_agg(language_stats.*) FROM language_stats) AS language_distribution,
        (SELECT json_agg(voice_stats.*) FROM voice_stats) AS voice_distribution,
        (SELECT json_agg(completion_by_ended_by.*) FROM completion_by_ended_by) AS completion_patterns,
        (SELECT row_to_json(abandonment_rate.*) FROM abandonment_rate) AS abandonment_stats,
        (SELECT json_agg(session_depth_by_user_type.*) FROM session_depth_by_user_type) AS session_depth,
        (SELECT row_to_json(messages_per_minute.*) FROM messages_per_minute) AS engagement_pace,
        (SELECT row_to_json(response_times.*) FROM response_times) AS response_times,
        (SELECT row_to_json(turn_taking_ratio.*) FROM turn_taking_ratio) AS turn_taking
    `, [
      startDate || null,                                 // $1
      endDate || null,                                   // $2
      voiceArray,                                        // $3
      languageArray,                                     // $4
      sessionTypeArray,                                  // $5
      statusArray,                                       // $6
      endedByArray,                                      // $7
      crisisFlagged === 'true' ? true :                  // $8
        crisisFlagged === 'false' ? false : null
    ]);

    const data = result.rows[0];
    res.json({
      metrics: data.metrics || {},
      breakdown: data.breakdown || {},
      daily_trend: data.daily_trend || [],
      user_sessions: data.user_sessions || [],
      time_distribution: data.time_distribution || [],
      duration_distribution: data.duration_distribution || [],
      duration_trend: data.duration_trend || [],
      language_distribution: data.language_distribution || [],
      voice_distribution: data.voice_distribution || [],
      completion_patterns: data.completion_patterns || [],
      abandonment_stats: data.abandonment_stats || {},
      session_depth: data.session_depth || [],
      engagement_pace: data.engagement_pace || {},
      response_times: data.response_times || {},
      turn_taking: data.turn_taking || {}
    });
  } catch (err) {
    console.error("Failed to fetch analytics:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// GET /admin/api/sessions/:sessionId/redaction-status - Check redaction completion status
app.get('/admin/api/sessions/:sessionId/redaction-status',
  requireRole('therapist', 'researcher'),
  async (req, res) => {
    const { sessionId } = req.params;

    try {
      const result = await pool.query(
        `SELECT COUNT(*) as pending_count
         FROM messages
         WHERE session_id = $1 AND content_redacted IS NULL`,
        [sessionId]
      );

      res.json({
        sessionId,
        pendingCount: parseInt(result.rows[0].pending_count),
        allComplete: result.rows[0].pending_count === '0'
      });
    } catch (err) {
      console.error('Failed to check redaction status:', err);
      res.status(500).json({ error: 'Failed to check redaction status' });
    }
  }
);

// GET /admin/api/export - Export data as JSON or CSV with research-focused options
app.get("/admin/api/export", requireRole('therapist', 'researcher'), async (req, res) => {
  const {
    format = 'json',
    exportType = 'full',
    sessionId,
    startDate,
    endDate,
    aggregationPeriod = 'day',
    crisisFlaggedOnly = 'false'
  } = req.query;

  try {
    let result;
    const contentColumn = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';
    const isCrisisOnly = crisisFlaggedOnly === 'true';

    // Handle different export types
    if (exportType === 'metadata') {
      // Metadata-only export (no message content)
      let query = `
        SELECT
          ts.session_id,
          ts.session_name,
          u.username,
          ts.session_type,
          ts.created_at as session_start,
          ts.ended_at as session_end,
          EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at))/60 as duration_minutes,
          ts.crisis_flagged,
          ts.crisis_severity,
          ts.crisis_risk_score,
          COUNT(m.message_id) as message_count
        FROM therapy_sessions ts
        LEFT JOIN users u ON ts.user_id = u.userid
        LEFT JOIN messages m ON ts.session_id = m.session_id
        WHERE
          ($1::VARCHAR IS NULL OR ts.session_id = $1)
          AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
          AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
          AND ($4::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
        GROUP BY ts.session_id, ts.session_name, u.username, ts.session_type, ts.created_at, ts.ended_at, ts.crisis_flagged, ts.crisis_severity, ts.crisis_risk_score
        ORDER BY ts.created_at DESC
      `;
      result = await pool.query(query, [sessionId || null, startDate || null, endDate || null, isCrisisOnly]);

    } else if (exportType === 'anonymized') {
      // Anonymized export with research IDs
      let query = `
        SELECT
          m.message_id as id,
          m.session_id,
          ts.session_name,
          'RID_' || LPAD(ROW_NUMBER() OVER (ORDER BY u.userid)::TEXT, 3, '0') as research_id,
          m.role,
          m.message_type,
          m.${contentColumn} as message,
          m.metadata as extras,
          m.created_at
        FROM messages m
        INNER JOIN therapy_sessions ts ON m.session_id = ts.session_id
        LEFT JOIN users u ON ts.user_id = u.userid
        WHERE
          ($1::VARCHAR IS NULL OR m.session_id = $1)
          AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
          AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
          AND ($4::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
        ORDER BY m.created_at ASC
      `;
      result = await pool.query(query, [sessionId || null, startDate || null, endDate || null, isCrisisOnly]);

    } else if (exportType === 'aggregated') {
      // Aggregated statistics by time period
      const dateFormat = aggregationPeriod === 'day' ? 'YYYY-MM-DD' :
                         aggregationPeriod === 'week' ? 'IYYY-IW' :
                         'YYYY-MM';
      let query = `
        SELECT
          TO_CHAR(ts.created_at, '${dateFormat}') as period,
          COUNT(DISTINCT ts.session_id) as total_sessions,
          COUNT(DISTINCT ts.user_id) as unique_users,
          AVG(EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at))/60) as avg_duration_minutes,
          SUM(CASE WHEN ts.crisis_flagged THEN 1 ELSE 0 END) as crisis_flagged_count,
          AVG(ts.crisis_risk_score) as avg_risk_score,
          COUNT(DISTINCT CASE WHEN ts.session_type = 'realtime' THEN ts.session_id END) as realtime_sessions,
          COUNT(DISTINCT CASE WHEN ts.session_type = 'chat' THEN ts.session_id END) as chat_sessions
        FROM therapy_sessions ts
        WHERE
          ($1::TIMESTAMP IS NULL OR ts.created_at >= $1)
          AND ($2::TIMESTAMP IS NULL OR ts.created_at <= $2)
          AND ($3::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
        GROUP BY TO_CHAR(ts.created_at, '${dateFormat}')
        ORDER BY period
      `;
      result = await pool.query(query, [startDate || null, endDate || null, isCrisisOnly]);

    } else {
      // Full export (default)
      let query;
      let params;

      if (sessionId) {
        query = `
          SELECT
            m.message_id as id,
            m.session_id,
            m.role,
            m.message_type,
            m.${contentColumn} as message,
            m.metadata as extras,
            m.created_at
          FROM messages m
          WHERE m.session_id = $1
          ORDER BY m.created_at ASC
        `;
        params = [sessionId];
      } else {
        query = `
          SELECT
            m.message_id as id,
            m.session_id,
            ts.session_name,
            u.username,
            m.role,
            m.message_type,
            m.${contentColumn} as message,
            m.metadata as extras,
            m.created_at
          FROM messages m
          INNER JOIN therapy_sessions ts ON m.session_id = ts.session_id
          LEFT JOIN users u ON ts.user_id = u.userid
          WHERE
            ($1::TIMESTAMP IS NULL OR ts.created_at >= $1)
            AND ($2::TIMESTAMP IS NULL OR ts.created_at <= $2)
            AND ($3::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
          ORDER BY m.created_at ASC
        `;
        params = [startDate || null, endDate || null, isCrisisOnly];
      }

      result = await pool.query(query, params);
    }

    if (format === 'csv') {
      // Simple CSV formatting
      const headers = sessionId
        ? ['id', 'session_id', 'role', 'message_type', 'message', 'extras', 'created_at']
        : ['id', 'session_id', 'session_name', 'username', 'role', 'message_type', 'message', 'extras', 'created_at'];
      const csvRows = [headers.join(',')];

      result.rows.forEach(row => {
        const values = headers.map(header => {
          const value = row[header];
          if (value === null) return '';
          if (typeof value === 'object') return JSON.stringify(value).replace(/"/g, '""');
          return `"${String(value).replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(','));
      });

      const filename = sessionId
        ? `session-${sessionId}-export.csv`
        : `all-sessions-export-${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvRows.join('\n'));
    } else {
      // JSON format
      const filename = sessionId
        ? `session-${sessionId}-export.json`
        : `all-sessions-export-${new Date().toISOString().split('T')[0]}.json`;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(result.rows);
    }
  } catch (err) {
    console.error("Failed to export data:", err);
    res.status(500).json({ error: "Failed to export data" });
  }
});

// ===================== Room Assignment API Routes =====================

// Helper function to handle room assignment cleanup when a session ends
async function handleSessionEndRoomCleanup(sessionId) {
  try {
    // Get the session to find the user_id
    const sessionResult = await pool.query(
      'SELECT user_id FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      return; // Session not found, nothing to do
    }

    const userId = sessionResult.rows[0].user_id;

    if (!userId) {
      return; // No user associated with session
    }

    // Check if this user has a room assignment
    const assignmentResult = await pool.query(
      `SELECT assignment_id, room_number
       FROM room_assignments
       WHERE user_id = $1 AND assignment_type = 'room'`,
      [userId]
    );

    if (assignmentResult.rows.length === 0) {
      return; // User not assigned to a room, nothing to do
    }

    const assignment = assignmentResult.rows[0];
    const roomNumber = assignment.room_number;

    console.log(`[Room Assignment] Session ended for user ${userId} in room ${roomNumber}, promoting queue...`);

    // Use a transaction to handle the promotion atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete the room assignment
      await client.query(
        'DELETE FROM room_assignments WHERE assignment_id = $1',
        [assignment.assignment_id]
      );

      // Get the first person in the queue for this room
      const queueResult = await client.query(
        `SELECT * FROM room_queue
         WHERE room_number = $1
         ORDER BY queue_position
         LIMIT 1`,
        [roomNumber]
      );

      if (queueResult.rows.length > 0) {
        const firstInQueue = queueResult.rows[0];

        // Assign them to the room
        const newAssignmentResult = await client.query(
          `INSERT INTO room_assignments (assignment_type, room_number, position, user_id)
           VALUES ('room', $1, NULL, $2)
           RETURNING *`,
          [roomNumber, firstInQueue.user_id]
        );

        // Remove them from the queue
        await client.query(
          'DELETE FROM room_queue WHERE queue_id = $1',
          [firstInQueue.queue_id]
        );

        // Get user info for socket event
        const userResult = await client.query(
          'SELECT userid, username, role FROM users WHERE userid = $1',
          [firstInQueue.user_id]
        );

        const user = userResult.rows[0];
        const newAssignment = newAssignmentResult.rows[0];

        await client.query('COMMIT');

        // Emit real-time updates
        global.io.to('admin-broadcast').emit('room-assignment:removed', {
          assignmentId: assignment.assignment_id
        });

        global.io.to('admin-broadcast').emit('room-assignment:updated', {
          assignment: {
            ...newAssignment,
            username: user.username,
            role: user.role
          }
        });

        global.io.to('admin-broadcast').emit('room-queue:removed', {
          queueId: firstInQueue.queue_id
        });

        console.log(`[Room Assignment] Auto-promoted ${user.username} from queue to room ${roomNumber}`);
      } else {
        // No one in queue, just remove the assignment
        await client.query('COMMIT');

        global.io.to('admin-broadcast').emit('room-assignment:removed', {
          assignmentId: assignment.assignment_id
        });

        console.log(`[Room Assignment] Room ${roomNumber} is now empty (no queue)`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Failed to handle room cleanup:', err);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error in handleSessionEndRoomCleanup:', err);
    // Don't throw - we don't want to break session ending if room cleanup fails
  }
}

// GET /admin/api/room-assignments - Get all current room assignments and queues
app.get("/admin/api/room-assignments", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    // Get all room assignments
    const assignmentsResult = await pool.query(`
      SELECT
        ra.assignment_id,
        ra.assignment_type,
        ra.room_number,
        ra.position,
        ra.user_id,
        u.username,
        u.role,
        ra.created_at,
        ra.updated_at
      FROM room_assignments ra
      LEFT JOIN users u ON ra.user_id = u.userid
      ORDER BY ra.assignment_type, ra.room_number, ra.position
    `);

    // Get all queue positions
    const queueResult = await pool.query(`
      SELECT
        rq.queue_id,
        rq.room_number,
        rq.queue_position,
        rq.user_id,
        u.username,
        u.role,
        rq.created_at
      FROM room_queue rq
      LEFT JOIN users u ON rq.user_id = u.userid
      ORDER BY rq.room_number, rq.queue_position
    `);

    // Get active sessions to show which participants are currently in a session
    const activeSessionsResult = await pool.query(`
      SELECT
        ts.user_id,
        ts.session_id,
        ts.created_at as session_started
      FROM therapy_sessions ts
      WHERE ts.status = 'active'
    `);

    res.json({
      assignments: assignmentsResult.rows,
      queue: queueResult.rows,
      activeSessions: activeSessionsResult.rows
    });
  } catch (err) {
    console.error("Failed to fetch room assignments:", err);
    res.status(500).json({ error: "Failed to fetch room assignments" });
  }
});

// POST /admin/api/room-assignments - Set a room assignment
app.post("/admin/api/room-assignments", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { assignmentType, roomNumber, position, userId } = req.body;

    // Validate inputs
    if (!assignmentType || !userId) {
      return res.status(400).json({ error: "assignmentType and userId are required" });
    }

    if (assignmentType === 'room' && (!roomNumber || roomNumber < 1 || roomNumber > 5)) {
      return res.status(400).json({ error: "Valid room number (1-5) is required for room assignments" });
    }

    if (assignmentType === 'monitoring' && (!position || position < 1 || position > 3)) {
      return res.status(400).json({ error: "Valid position (1-3) is required for monitoring assignments" });
    }

    if (assignmentType === 'checkin' && (!position || position < 1 || position > 2)) {
      return res.status(400).json({ error: "Valid position (1-2) is required for checkin assignments" });
    }

    // Check if user exists
    const userResult = await pool.query('SELECT userid, username, role FROM users WHERE userid = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];

    // Validate role restrictions
    if (assignmentType === 'room' && user.role !== 'participant') {
      return res.status(400).json({ error: "Only participants can be assigned to rooms" });
    }

    if ((assignmentType === 'monitoring' || assignmentType === 'checkin') && user.role !== 'researcher') {
      return res.status(400).json({ error: "Only researchers can be assigned to monitoring/checkin stations" });
    }

    // Remove user from any existing assignments first
    await pool.query('DELETE FROM room_assignments WHERE user_id = $1', [userId]);

    // Remove user from any queue positions
    await pool.query('DELETE FROM room_queue WHERE user_id = $1', [userId]);

    // Insert new assignment using ON CONFLICT to handle slot already taken
    const result = await pool.query(`
      INSERT INTO room_assignments (assignment_type, room_number, position, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (assignment_type, room_number, position)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      assignmentType,
      assignmentType === 'room' ? roomNumber : null,
      assignmentType !== 'room' ? position : null,
      userId
    ]);

    const assignment = result.rows[0];

    // Emit real-time update to all admin clients
    global.io.to('admin-broadcast').emit('room-assignment:updated', {
      assignment: {
        ...assignment,
        username: user.username,
        role: user.role
      }
    });

    console.log(`[Room Assignment] ${req.session.username} assigned ${user.username} to ${assignmentType} ${roomNumber || position}`);

    res.json({
      assignment: {
        ...assignment,
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error("Failed to create room assignment:", err);
    res.status(500).json({ error: "Failed to create room assignment" });
  }
});

// DELETE /admin/api/room-assignments/:assignmentId - Remove a room assignment
app.delete("/admin/api/room-assignments/:assignmentId", requireRole('therapist', 'researcher'), async (req, res) => {
  const client = await pool.connect();

  try {
    const { assignmentId } = req.params;

    await client.query('BEGIN');

    // Delete the assignment and get its info
    const result = await client.query(
      'DELETE FROM room_assignments WHERE assignment_id = $1 RETURNING *',
      [assignmentId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Assignment not found" });
    }

    const deletedAssignment = result.rows[0];

    // If it was a room assignment, check if there's someone in the queue to promote
    if (deletedAssignment.assignment_type === 'room' && deletedAssignment.room_number) {
      const roomNumber = deletedAssignment.room_number;

      // Get the first person in the queue for this room
      const queueResult = await client.query(
        `SELECT * FROM room_queue
         WHERE room_number = $1
         ORDER BY queue_position
         LIMIT 1`,
        [roomNumber]
      );

      if (queueResult.rows.length > 0) {
        const firstInQueue = queueResult.rows[0];

        // Assign them to the room
        const newAssignmentResult = await client.query(
          `INSERT INTO room_assignments (assignment_type, room_number, position, user_id)
           VALUES ('room', $1, NULL, $2)
           RETURNING *`,
          [roomNumber, firstInQueue.user_id]
        );

        // Remove them from the queue
        await client.query(
          'DELETE FROM room_queue WHERE queue_id = $1',
          [firstInQueue.queue_id]
        );

        // Get user info for socket event
        const userResult = await client.query(
          'SELECT userid, username, role FROM users WHERE userid = $1',
          [firstInQueue.user_id]
        );

        const user = userResult.rows[0];
        const newAssignment = newAssignmentResult.rows[0];

        await client.query('COMMIT');

        // Emit real-time updates
        global.io.to('admin-broadcast').emit('room-assignment:removed', {
          assignmentId: parseInt(assignmentId)
        });

        global.io.to('admin-broadcast').emit('room-assignment:updated', {
          assignment: {
            ...newAssignment,
            username: user.username,
            role: user.role
          }
        });

        global.io.to('admin-broadcast').emit('room-queue:removed', {
          queueId: firstInQueue.queue_id
        });

        console.log(`[Room Assignment] ${req.session.username} removed assignment ${assignmentId}`);
        console.log(`[Room Assignment] Auto-promoted ${user.username} from queue to room ${roomNumber}`);

        return res.json({
          message: "Assignment removed successfully",
          promoted: {
            username: user.username,
            roomNumber: roomNumber
          }
        });
      }
    }

    await client.query('COMMIT');

    // Emit real-time update to all admin clients
    global.io.to('admin-broadcast').emit('room-assignment:removed', {
      assignmentId: parseInt(assignmentId)
    });

    console.log(`[Room Assignment] ${req.session.username} removed assignment ${assignmentId}`);

    res.json({ message: "Assignment removed successfully" });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Failed to remove room assignment:", err);
    res.status(500).json({ error: "Failed to remove room assignment" });
  } finally {
    client.release();
  }
});

// POST /admin/api/room-queue - Add user to room queue
app.post("/admin/api/room-queue", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { roomNumber, queuePosition, userId } = req.body;

    // Validate inputs
    if (!roomNumber || roomNumber < 1 || roomNumber > 5) {
      return res.status(400).json({ error: "Valid room number (1-5) is required" });
    }

    if (!queuePosition || queuePosition < 1 || queuePosition > 4) {
      return res.status(400).json({ error: "Valid queue position (1-4) is required" });
    }

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // Check if user exists and is a participant
    const userResult = await pool.query('SELECT userid, username, role FROM users WHERE userid = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];

    if (user.role !== 'participant') {
      return res.status(400).json({ error: "Only participants can be added to room queues" });
    }

    // Remove user from any existing queue positions or room assignments
    await pool.query('DELETE FROM room_queue WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM room_assignments WHERE user_id = $1', [userId]);

    // Insert into queue using ON CONFLICT
    const result = await pool.query(`
      INSERT INTO room_queue (room_number, queue_position, user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (room_number, queue_position)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        created_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [roomNumber, queuePosition, userId]);

    const queueEntry = result.rows[0];

    // Emit real-time update
    global.io.to('admin-broadcast').emit('room-queue:updated', {
      queueEntry: {
        ...queueEntry,
        username: user.username,
        role: user.role
      }
    });

    console.log(`[Room Queue] ${req.session.username} added ${user.username} to room ${roomNumber} queue position ${queuePosition}`);

    res.json({
      queueEntry: {
        ...queueEntry,
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error("Failed to add to room queue:", err);
    res.status(500).json({ error: "Failed to add to room queue" });
  }
});

// DELETE /admin/api/room-queue/:queueId - Remove from room queue
app.delete("/admin/api/room-queue/:queueId", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { queueId } = req.params;

    const result = await pool.query(
      'DELETE FROM room_queue WHERE queue_id = $1 RETURNING *',
      [queueId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Queue entry not found" });
    }

    // Emit real-time update
    global.io.to('admin-broadcast').emit('room-queue:removed', {
      queueId: parseInt(queueId)
    });

    console.log(`[Room Queue] ${req.session.username} removed queue entry ${queueId}`);

    res.json({ message: "Queue entry removed successfully" });
  } catch (err) {
    console.error("Failed to remove from room queue:", err);
    res.status(500).json({ error: "Failed to remove from room queue" });
  }
});

// ===================== System Configuration API Routes =====================

// GET /api/config/crisis - Get crisis contact info (public endpoint for clients)
app.get("/api/config/crisis", async (req, res) => {
  try {
    const config = await getSystemConfig();
    const crisisContact = config.crisis_contact || {
      hotline: 'BYU Counseling and Psychological Services',
      phone: '(801) 422-3035',
      text: 'HELLO to 741741',
      enabled: true
    };

    res.json(crisisContact);
  } catch (err) {
    console.error("Failed to fetch crisis contact:", err);
    res.status(500).json({ error: "Failed to fetch crisis contact" });
  }
});

// GET /api/config/features - Get features configuration
app.get("/api/config/features", async (req, res) => {
  try {
    const config = await getSystemConfig();
    const features = config.features || {
      voice_enabled: true,
      chat_enabled: true,
      file_upload_enabled: false,
      session_recording_enabled: false,
      output_modalities: ["audio"]
    };

    res.json(features);
  } catch (err) {
    console.error("Failed to fetch features config:", err);
    res.status(500).json({ error: "Failed to fetch features config" });
  }
});

// GET /api/config/ai-model - Get AI model for client (no auth required)
app.get("/api/config/ai-model", async (req, res) => {
  try {
    const model = await getAiModel();
    res.json({ model });
  } catch (err) {
    console.error('Failed to fetch AI model:', err);
    res.status(500).json({ error: 'Failed to fetch AI model configuration' });
  }
});

// GET /api/config/client-logging - Get client logging configuration (public endpoint)
app.get("/api/config/client-logging", async (req, res) => {
  try {
    const config = await getSystemConfig();
    const clientLogging = config.client_logging || { enabled: false };
    res.json(clientLogging);
  } catch (err) {
    console.error("Failed to fetch client logging config:", err);
    res.status(500).json({ error: "Failed to fetch client logging config" });
  }
});

// GET /api/config/voices - Get enabled voices with metadata (public endpoint for users)
app.get("/api/config/voices", async (req, res) => {
  try {
    const config = await getSystemConfig();
    const voicesConfig = config.voices || {
      voices: [
        { value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }
      ],
      default_voice: 'cedar'
    };

    // Filter to only enabled voices for users
    const enabledVoices = voicesConfig.voices
      ? voicesConfig.voices
          .filter(v => v.enabled)
          .map(v => ({ value: v.value, label: v.label, description: v.description }))
      : [];

    res.json({
      voices: enabledVoices,
      default_voice: voicesConfig.default_voice
    });
  } catch (err) {
    console.error("Failed to fetch voices config:", err);
    res.status(500).json({ error: "Failed to fetch voices config" });
  }
});

// GET /api/config/languages - Get enabled languages with metadata (public endpoint for users)
app.get("/api/config/languages", async (req, res) => {
  try {
    const config = await getSystemConfig();
    const languagesConfig = config.languages || {
      languages: [
        { value: 'en', label: 'English', description: 'English', enabled: true }
      ],
      default_language: 'en'
    };

    // Filter to only enabled languages for users
    const enabledLanguages = languagesConfig.languages
      ? languagesConfig.languages
          .filter(l => l.enabled)
          .map(l => ({ value: l.value, label: l.label, description: l.description }))
      : [];

    res.json({
      languages: enabledLanguages,
      default_language: languagesConfig.default_language
    });
  } catch (err) {
    console.error("Failed to fetch languages config:", err);
    res.status(500).json({ error: "Failed to fetch languages config" });
  }
});

// GET /api/voices/preview/:voiceName - Serve voice preview audio files
app.get("/api/voices/preview/:voiceName", async (req, res) => {
  try {
    const { voiceName } = req.params;

    // Sanitize voice name to prevent directory traversal
    const sanitizedVoiceName = path.basename(voiceName);

    // Construct the path to the voice file (MP3 for browser compatibility)
    const voiceFilePath = path.join(__dirname, '../../OAI_VOICES', `${sanitizedVoiceName}.mp3`);

    // Check if file exists
    if (!fs.existsSync(voiceFilePath)) {
      return res.status(404).json({ error: 'Voice preview not found' });
    }

    // Set appropriate headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

    // Stream the file
    const stream = fs.createReadStream(voiceFilePath);
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('Error streaming voice preview:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream voice preview' });
      }
    });
  } catch (err) {
    console.error("Failed to serve voice preview:", err);
    res.status(500).json({ error: "Failed to serve voice preview" });
  }
});

// GET /admin/api/config - Get all system configuration
app.get("/admin/api/config", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_config ORDER BY config_key');

    // Transform into a more usable object format
    const config = {};
    result.rows.forEach(row => {
      config[row.config_key] = {
        value: row.config_value,
        description: row.description,
        updated_at: row.updated_at,
        updated_by: row.updated_by
      };
    });

    res.json(config);
  } catch (err) {
    console.error("Failed to fetch system configuration:", err);
    res.status(500).json({ error: "Failed to fetch system configuration" });
  }
});

// GET /admin/api/config/system-prompt-preview - Get fully interpolated system prompt for preview
// NOTE: This route must be defined BEFORE /admin/api/config/:key to avoid being matched as a key
app.get("/admin/api/config/system-prompt-preview", requireRole('researcher'), async (req, res) => {
  const { sessionType = 'realtime', language = 'en' } = req.query;

  // Validate sessionType
  if (!['realtime', 'chat'].includes(sessionType)) {
    return res.status(400).json({ error: 'sessionType must be either "realtime" or "chat"' });
  }

  try {
    const interpolatedPrompt = await getSystemPrompt(language, sessionType);

    res.json({
      success: true,
      sessionType,
      language,
      prompt: interpolatedPrompt,
      characterCount: interpolatedPrompt.length
    });
  } catch (err) {
    console.error("Failed to generate system prompt preview:", err);
    res.status(500).json({ error: "Failed to generate system prompt preview" });
  }
});

// GET /admin/api/config/:key - Get specific configuration
app.get("/admin/api/config/:key", requireRole('therapist', 'researcher'), async (req, res) => {
  const { key } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM system_config WHERE config_key = $1',
      [key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Configuration key not found' });
    }

    res.json({
      key: result.rows[0].config_key,
      value: result.rows[0].config_value,
      description: result.rows[0].description,
      updated_at: result.rows[0].updated_at,
      updated_by: result.rows[0].updated_by
    });
  } catch (err) {
    console.error("Failed to fetch configuration:", err);
    res.status(500).json({ error: "Failed to fetch configuration" });
  }
});

// PUT /admin/api/config/:key - Update specific configuration
app.put("/admin/api/config/:key", requireRole('researcher'), async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (!value) {
    return res.status(400).json({ error: 'Configuration value is required' });
  }

  try {
    // Validate voices config
    if (key === 'voices') {
      if (!value.voices || !Array.isArray(value.voices)) {
        return res.status(400).json({ error: 'voices must be an array' });
      }
      const enabledVoices = value.voices.filter(v => v.enabled);
      if (enabledVoices.length === 0) {
        return res.status(400).json({ error: 'At least one voice must be enabled' });
      }
      const defaultVoice = value.voices.find(v => v.value === value.default_voice && v.enabled);
      if (!defaultVoice) {
        return res.status(400).json({
          error: 'default_voice must be one of the enabled voices'
        });
      }
      // Validate each voice has required fields
      for (const voice of value.voices) {
        if (!voice.value || !voice.label) {
          return res.status(400).json({ error: 'Each voice must have value and label' });
        }
      }
    }

    // Validate languages config
    if (key === 'languages') {
      if (!value.languages || !Array.isArray(value.languages)) {
        return res.status(400).json({ error: 'languages must be an array' });
      }
      const enabledLanguages = value.languages.filter(l => l.enabled);
      if (enabledLanguages.length === 0) {
        return res.status(400).json({ error: 'At least one language must be enabled' });
      }
      const defaultLanguage = value.languages.find(l => l.value === value.default_language && l.enabled);
      if (!defaultLanguage) {
        return res.status(400).json({
          error: 'default_language must be one of the enabled languages'
        });
      }
      // Validate each language has required fields
      for (const language of value.languages) {
        if (!language.value || !language.label) {
          return res.status(400).json({ error: 'Each language must have value and label' });
        }
      }
    }

    // Validate system_prompts config
    if (key === 'system_prompts') {
      // Validate both realtime and chat prompts exist
      if (!value.realtime || !value.chat) {
        return res.status(400).json({ error: 'system_prompts must have both realtime and chat prompts' });
      }
      // Validate each prompt has required fields and minimum length
      for (const promptType of ['realtime', 'chat']) {
        if (!value[promptType].prompt) {
          return res.status(400).json({ error: `${promptType} prompt is required` });
        }
        if (value[promptType].prompt.length < 100) {
          return res.status(400).json({ error: `${promptType} prompt must be at least 100 characters` });
        }
      }
      // Update last_modified timestamps
      const now = new Date().toISOString();
      value.realtime.last_modified = now;
      value.chat.last_modified = now;
    }

    const result = await pool.query(
      `UPDATE system_config
       SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
       WHERE config_key = $3
       RETURNING *`,
      [JSON.stringify(value), req.session.username, key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Configuration key not found' });
    }

    // Invalidate cache to force refresh
    systemConfigCache = null;
    configCacheTime = null;

    console.log(`Config updated: ${key} by ${req.session.username}`);

    res.json({
      success: true,
      key: result.rows[0].config_key,
      value: result.rows[0].config_value,
      updated_at: result.rows[0].updated_at,
      updated_by: result.rows[0].updated_by
    });
  } catch (err) {
    console.error("Failed to update configuration:", err);
    res.status(500).json({ error: "Failed to update configuration" });
  }
});

// ============================================
// Content Retention / Data Wipe Endpoints
// ============================================

// GET /admin/api/content-retention - Get retention settings and stats
app.get("/admin/api/content-retention", requireRole('researcher'), async (req, res) => {
  try {
    const stats = await getWipeStats();
    const schedulerStatus = getSchedulerStatus();

    res.json({
      ...stats,
      scheduler: schedulerStatus
    });
  } catch (err) {
    console.error("Failed to fetch content retention stats:", err);
    res.status(500).json({ error: "Failed to fetch content retention stats" });
  }
});

// PUT /admin/api/content-retention - Update retention settings
app.put("/admin/api/content-retention", requireRole('researcher'), async (req, res) => {
  const { settings } = req.body;

  if (!settings) {
    return res.status(400).json({ error: 'Settings are required' });
  }

  // Validate settings
  if (typeof settings.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  if (typeof settings.retention_hours !== 'number' || settings.retention_hours < 1 || settings.retention_hours > 8760) {
    return res.status(400).json({ error: 'retention_hours must be between 1 and 8760 (1 year)' });
  }

  // Validate wipe_time format (HH:MM)
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(settings.wipe_time)) {
    return res.status(400).json({ error: 'wipe_time must be in HH:MM format' });
  }

  if (typeof settings.require_redaction_complete !== 'boolean') {
    return res.status(400).json({ error: 'require_redaction_complete must be a boolean' });
  }

  try {
    const updatedSettings = await updateRetentionSettings(settings, req.session.username);

    console.log(`Content retention settings updated by ${req.session.username}`);

    res.json({
      success: true,
      settings: updatedSettings
    });
  } catch (err) {
    console.error("Failed to update content retention settings:", err);
    res.status(500).json({ error: "Failed to update content retention settings" });
  }
});

// POST /admin/api/content-retention/wipe - Trigger manual content wipe
app.post("/admin/api/content-retention/wipe", requireRole('researcher'), async (req, res) => {
  try {
    console.log(`Manual content wipe triggered by ${req.session.username}`);

    const result = await executeContentWipe('manual', req.session.username);

    if (result.success) {
      res.json({
        success: true,
        wipeId: result.wipeId,
        messagesWiped: result.messagesWiped,
        messagesSkipped: result.messagesSkipped
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (err) {
    console.error("Failed to execute content wipe:", err);
    res.status(500).json({ error: "Failed to execute content wipe" });
  }
});

// GET /admin/api/content-retention/log - Get wipe history log
app.get("/admin/api/content-retention/log", requireRole('researcher'), async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  try {
    const result = await pool.query(
      `SELECT * FROM content_wipe_log
       ORDER BY started_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) as count FROM content_wipe_log');

    res.json({
      wipes: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset
    });
  } catch (err) {
    console.error("Failed to fetch content wipe log:", err);
    res.status(500).json({ error: "Failed to fetch content wipe log" });
  }
});

// GET /admin/api/user-sessions - Get all active user sessions
app.get("/admin/api/user-sessions", requireRole('researcher'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sid,
        sess,
        expire
      FROM user_sessions
      ORDER BY expire DESC
    `);

    // Parse the sess JSON and extract relevant fields
    const sessions = result.rows.map(row => {
      let sessData = {};
      try {
        sessData = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
      } catch (err) {
        console.error('Failed to parse session data:', err);
      }

      return {
        sid: row.sid,
        expire: row.expire,
        userId: sessData.userId,
        username: sessData.username,
        userRole: sessData.userRole,
        cookie: sessData.cookie
      };
    });

    res.json(sessions);
  } catch (err) {
    console.error("Failed to fetch user sessions:", err);
    res.status(500).json({ error: "Failed to fetch user sessions" });
  }
});

// DELETE /admin/api/user-sessions/:sid - Delete a specific user session (logout user)
app.delete("/admin/api/user-sessions/:sid", requireRole('researcher'), async (req, res) => {
  const { sid } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM user_sessions WHERE sid = $1 RETURNING sid',
      [sid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`[Admin] Session ${sid} deleted by ${req.session.username}`);
    res.json({
      message: 'Session deleted successfully',
      sid: result.rows[0].sid
    });
  } catch (err) {
    console.error("Failed to delete user session:", err);
    res.status(500).json({ error: "Failed to delete user session" });
  }
});

// GET /admin/api/rate-limits/users - Get all rate-limited users
app.get('/admin/api/rate-limits/users', requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const config = await getSystemConfig();
    const limits = config.session_limits || { enabled: false };

    if (!limits.enabled) {
      return res.json({ rateLimitedUsers: [], config: limits });
    }

    // Get today's start in SLC time
    const todayStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
    todayStart.setHours(0, 0, 0, 0);

    const result = await pool.query(`
      SELECT
        u.userid,
        u.username,
        u.role,
        COUNT(ts.session_id) AS sessions_today,
        MAX(ts.created_at) AS last_session_at
      FROM users u
      LEFT JOIN therapy_sessions ts ON u.userid = ts.user_id
        AND ts.created_at >= $1
      WHERE u.role = 'participant'
      GROUP BY u.userid, u.username, u.role
      HAVING COUNT(ts.session_id) >= $2
      ORDER BY last_session_at DESC
    `, [todayStart, limits.max_sessions_per_day]);

    const rateLimitedUsers = result.rows.map(row => ({
      userid: row.userid,
      username: row.username,
      role: row.role,
      sessions_used_today: parseInt(row.sessions_today),
      session_limit: limits.max_sessions_per_day,
      limit_resets_at: getNextMidnightSLC().toISOString(),
      hours_until_reset: getHoursUntilReset(),
      last_session_at: row.last_session_at
    }));

    res.json({ rateLimitedUsers, config: limits });
  } catch (err) {
    console.error('Error fetching rate-limited users:', err);
    res.status(500).json({ error: 'Failed to fetch rate-limited users' });
  }
});

// ===================== Crisis Management API Routes =====================

// POST /admin/api/sessions/:sessionId/crisis/flag - Manually flag session as crisis
app.post("/admin/api/sessions/:sessionId/crisis/flag", requireRole('therapist', 'researcher'), async (req, res) => {
  const { sessionId } = req.params;
  const { severity, notes } = req.body;

  // Validate severity
  if (!['low', 'medium', 'high'].includes(severity)) {
    return res.status(400).json({ error: 'Invalid severity. Must be low, medium, or high.' });
  }

  try {
    const { flagSessionCrisis, logInterventionAction } = await import('./services/crisisDetection.service.js');

    // Check if session exists
    const sessionCheck = await pool.query(
      'SELECT session_id FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Calculate risk score based on severity
    const riskScoreMap = { low: 25, medium: 50, high: 85 };
    const riskScore = riskScoreMap[severity];

    // Flag the session
    await flagSessionCrisis(
      sessionId,
      severity,
      riskScore,
      req.session.username,
      'manual',
      null,
      [],
      notes || 'Manually flagged by admin'
    );

    // Log intervention
    await logInterventionAction(sessionId, 'manual_flag', {
      riskScore,
      severity,
      flaggedBy: req.session.username,
      notes
    });

    // Emit Socket.io event
    global.io.to('admin-broadcast').emit('session:crisis-flagged', {
      sessionId,
      severity,
      riskScore,
      flaggedBy: req.session.username,
      flaggedAt: new Date(),
      message: `Session manually flagged as ${severity} risk by ${req.session.username}`
    });

    console.log(`Session ${sessionId} manually flagged as ${severity} by ${req.session.username}`);

    res.json({
      success: true,
      message: 'Session flagged as crisis',
      sessionId,
      severity,
      riskScore,
      flaggedBy: req.session.username,
      flaggedAt: new Date()
    });
  } catch (err) {
    console.error("Failed to flag session as crisis:", err);
    res.status(500).json({ error: "Failed to flag session" });
  }
});

// DELETE /admin/api/sessions/:sessionId/crisis/flag - Unflag session
app.delete("/admin/api/sessions/:sessionId/crisis/flag", requireRole('therapist', 'researcher'), async (req, res) => {
  const { sessionId } = req.params;
  const { notes } = req.body;

  try {
    const { unflagSessionCrisis } = await import('./services/crisisDetection.service.js');

    // Check if session exists
    const sessionCheck = await pool.query(
      'SELECT session_id, crisis_flagged FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!sessionCheck.rows[0].crisis_flagged) {
      return res.status(400).json({ error: 'Session is not flagged as crisis' });
    }

    // Unflag the session
    await unflagSessionCrisis(
      sessionId,
      req.session.username,
      notes || 'Manually unflagged by admin'
    );

    // Emit Socket.io event
    global.io.to('admin-broadcast').emit('session:crisis-unflagged', {
      sessionId,
      unflaggedBy: req.session.username,
      unflaggedAt: new Date(),
      message: `Crisis flag removed by ${req.session.username}`
    });

    console.log(`Session ${sessionId} unflagged by ${req.session.username}`);

    res.json({
      success: true,
      message: 'Crisis flag removed',
      sessionId,
      unflaggedBy: req.session.username,
      unflaggedAt: new Date()
    });
  } catch (err) {
    console.error("Failed to unflag session:", err);
    res.status(500).json({ error: "Failed to unflag session" });
  }
});

// GET /admin/api/crisis/all - Get all crisis management data (comprehensive view)
app.get("/admin/api/crisis/all", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    console.log('[Crisis API] Fetching all crisis management data...');
    // Fetch all crisis-related data in parallel
    const [clinicalReviews, crisisEvents, humanHandoffs, interventionActions, riskScoreHistory] = await Promise.all([
      // Clinical Reviews
      pool.query(`
        SELECT
          cr.*,
          ts.session_name
        FROM clinical_reviews cr
        LEFT JOIN therapy_sessions ts ON cr.session_id = ts.session_id
        ORDER BY cr.requested_at DESC
        LIMIT 500
      `),

      // Crisis Events
      pool.query(`
        SELECT
          ce.*,
          ts.session_name
        FROM crisis_events ce
        LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
        ORDER BY ce.created_at DESC
        LIMIT 500
      `),

      // Human Handoffs
      pool.query(`
        SELECT
          hh.*,
          ts.session_name
        FROM human_handoffs hh
        LEFT JOIN therapy_sessions ts ON hh.session_id = ts.session_id
        ORDER BY hh.initiated_at DESC
        LIMIT 500
      `),

      // Intervention Actions
      pool.query(`
        SELECT
          ia.*,
          ts.session_name
        FROM intervention_actions ia
        LEFT JOIN therapy_sessions ts ON ia.session_id = ts.session_id
        ORDER BY ia.performed_at DESC
        LIMIT 500
      `),

      // Risk Score History
      pool.query(`
        SELECT
          rsh.*,
          ts.session_name
        FROM risk_score_history rsh
        LEFT JOIN therapy_sessions ts ON rsh.session_id = ts.session_id
        ORDER BY rsh.calculated_at DESC
        LIMIT 1000
      `)
    ]);

    console.log('[Crisis API] Successfully fetched all data');
    res.json({
      clinicalReviews: clinicalReviews.rows,
      crisisEvents: crisisEvents.rows,
      humanHandoffs: humanHandoffs.rows,
      interventionActions: interventionActions.rows,
      riskScoreHistory: riskScoreHistory.rows
    });
  } catch (err) {
    console.error("[Crisis API] Failed to fetch comprehensive crisis data:", err);
    console.error("[Crisis API] Error details:", {
      message: err.message,
      code: err.code,
      detail: err.detail
    });
    res.status(500).json({
      error: "Failed to fetch crisis management data",
      details: err.message
    });
  }
});

// GET /admin/api/crisis/events - Get crisis events (all or by sessionId)
app.get("/admin/api/crisis/events", requireRole('therapist', 'researcher'), async (req, res) => {
  const { sessionId } = req.query;

  try {
    let result;
    if (sessionId) {
      const { getSessionCrisisEvents } = await import('./services/crisisDetection.service.js');
      const events = await getSessionCrisisEvents(sessionId);
      result = { events };
    } else {
      // Get all crisis events
      const queryResult = await pool.query(`
        SELECT
          ce.*,
          ts.session_name,
          u.username
        FROM crisis_events ce
        LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
        LEFT JOIN users u ON ts.user_id = u.userid
        ORDER BY ce.created_at DESC
        LIMIT 100
      `);
      result = { events: queryResult.rows };
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch crisis events:", err);
    res.status(500).json({ error: "Failed to fetch crisis events" });
  }
});

// GET /admin/api/crisis/active - Get all active crisis sessions
app.get("/admin/api/crisis/active", requireRole('therapist', 'researcher'), async (req, res) => {
  try {
    const { getActiveCrisisSessions } = await import('./services/crisisDetection.service.js');
    const sessions = await getActiveCrisisSessions();

    res.json({ sessions });
  } catch (err) {
    console.error("Failed to fetch active crisis sessions:", err);
    res.status(500).json({ error: "Failed to fetch active crisis sessions" });
  }
});

// =============================================================================
// REDACTION VERIFICATION API ROUTES
// =============================================================================

// GET /redact/api/messages - Get random messages (only content_redacted)
app.get("/redact/api/messages", requireRole('researcher'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT message_id, content_redacted, role, message_type, created_at
      FROM messages
      WHERE content_redacted IS NOT NULL AND role IN ('user', 'assistant')
      ORDER BY RANDOM()
      LIMIT 20
    `);
    res.json({ messages: result.rows });
  } catch (err) {
    console.error("Failed to fetch redacted messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// PUT /redact/api/messages/:id - Update redacted content
app.put("/redact/api/messages/:id", requireRole('researcher'), async (req, res) => {
  const { id } = req.params;
  const { content_redacted } = req.body;

  if (content_redacted === undefined) {
    return res.status(400).json({ error: "content_redacted field is required" });
  }

  try {
    const result = await pool.query(
      'UPDATE messages SET content_redacted = $1 WHERE message_id = $2 RETURNING message_id',
      [content_redacted, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to update redacted content:", err);
    res.status(500).json({ error: "Failed to update message" });
  }
});

async function startProdServer() {
  console.log("Starting in production mode...");

  // Serve static files from the client build directory.
  app.use(express.static(path.resolve(__dirname, '../../dist/client')));

  // Serve admin static assets (CSS, JS) - admin assets are prefixed with "admin-" so no conflicts
  app.use('/assets', express.static(path.resolve(__dirname, '../../dist/admin-client/assets')));

  // Dynamically import all SSR modules
  const { render } = await import('../../dist/server/entry-server.js');
  const { render: renderAdmin } = await import('../../dist/admin-server/admin-entry-server.js');
  const { render: renderRedact } = await import('../../dist/redact-server/redact-entry-server.js');

  // Serve redact static assets
  app.use('/redact/assets', express.static(path.resolve(__dirname, '../../dist/redact-client/assets')));

  // Admin panel route
  app.get('/admin', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/admin-client/admin.html'), 'utf-8');
      const appHtml = await renderAdmin(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (e) {
      console.error(e.stack);
      res.status(500).end(e.stack);
    }
  });

  // Redact verification page route
  app.get('/redact', requireRole('researcher'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/redact-client/redact.html'), 'utf-8');
      const appHtml = await renderRedact(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (e) {
      console.error(e.stack);
      res.status(500).end(e.stack);
    }
  });

  // Handle all other requests with main app SSR.
  app.use('*', async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, '../../dist/client/index.html'), 'utf-8');
      const appHtml = await render(req.originalUrl);
      const html = template.replace(`<!--ssr-outlet-->`, appHtml.html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (e) {
      console.error(e.stack);
      res.status(500).end(e.stack);
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
    } catch (e) {
      vite.ssrFixStacktrace(e);
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
    } catch (e) {
      vite.ssrFixStacktrace(e);
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
    } catch (e) {
      vite.ssrFixStacktrace(e);
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