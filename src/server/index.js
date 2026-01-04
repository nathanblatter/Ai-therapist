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
import redactPHI from "./services/redaction.service.js";
import { requireAuth, requireRole, verifyCredentials, createUser, getAllUsers, getUserById, updateUser, deleteUser } from "./middleware/auth.js";
import { createSession, getSession, insertMessagesBatch, upsertSessionConfig } from "./models/dbQueries.js";
import { generateSessionNameAsync } from "./services/sessionName.service.js";
import { restrictParticipantsToUs } from "./middleware/ipFilter.js";

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


const languageInstructions = {
  'en': '',
  'es-ES': '\n\n**IMPORTANT: Please respond in Spanish from Spain (Español de España). Use European Spanish vocabulary, pronunciation, and expressions (vosotros, conducir, ordenador, etc.).**',
  'es-419': '\n\n**IMPORTANT: Please respond in Latin American Spanish (Español Latinoamericano). Use Latin American Spanish vocabulary and expressions (ustedes, manejar, computadora, etc.).**',
  'fr-FR': '\n\n**IMPORTANT: Please respond in French from France (Français de France). Use standard French vocabulary and expressions.**',
  'fr-CA': '\n\n**IMPORTANT: Please respond in Québécois French (Français Québécois). Use Canadian French vocabulary, pronunciation, and expressions.**',
  'pt-BR': '\n\n**IMPORTANT: Please respond in Brazilian Portuguese (Português Brasileiro). Use Brazilian Portuguese vocabulary, pronunciation, and expressions.**',
  'pt-PT': '\n\n**IMPORTANT: Please respond in European Portuguese (Português Europeu). Use European Portuguese vocabulary, pronunciation, and expressions.**',
  'de': '\n\n**IMPORTANT: Please respond in German (Deutsch).**',
  'it': '\n\n**IMPORTANT: Please respond in Italian (Italiano).**',
  'zh': '\n\n**IMPORTANT: Please respond in Chinese (中文).**',
  'ja': '\n\n**IMPORTANT: Please respond in Japanese (日本語).**',
  'ko': '\n\n**IMPORTANT: Please respond in Korean (한국어).**',
  'ar': '\n\n**IMPORTANT: Please respond in Arabic (العربية).**',
  'hi': '\n\n**IMPORTANT: Please respond in Hindi (हिन्दी).**',
  'ru': '\n\n**IMPORTANT: Please respond in Russian (Русский).**'
};

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
    console.log(`✓ Researcher ${userId} bypassing session limits`);
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

async function getSystemPrompt(language = 'en') {
  const config = await getSystemConfig();
  const crisisContact = config.crisis_contact || {
    hotline: 'BYU Counseling and Psychological Services',
    phone: '(801) 422-3035',
    text: 'HELLO to 741741'
  };

  const crisisText = crisisContact.enabled
    ? `${crisisContact.hotline} ${crisisContact.phone}${crisisContact.text ? ', text ' + crisisContact.text : ''}, or 911`
    : '911 or your local emergency services';

  const basePrompt = `## Purpose & Scope
You are an AI **therapeutic assistant** for adults, providing **general emotional support and therapeutic conversation** only. Use empathy and evidence-based self-help (e.g., **CBT, DBT, mindfulness, journaling**) to help users cope with stress, anxiety, and common emotions. Make it clear: you **support and guide, not replace a human therapist**. Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**. Encourage seeking a **licensed therapist for serious issues**. Stay within **support, coping, active listening, and psycho-education**—no clinical claims.

## Boundaries & Limitations
**Never diagnose, give medication, or legal advice.** Avoid medical or legal topics; instead, offer **non-medication coping, self-care, lifestyle tips, relaxation, and gentle suggestions**. Do not suggest specific drugs/supplements or treatment plans. If asked for diagnosis or medical/legal advice, **politely decline** and clarify your non-professional status. Never misrepresent your credentials. Do not set up treatment plans or contracts or act as a human/professional; **focus on user's goals and autonomy**, using open-ended questions and suggestions.

## Crisis Protocol
**If user expresses risk (suicidality, harm, acute crisis):**
- **Immediately stop normal conversation**
- Urge them to seek emergency help (e.g., ${crisisText}).
- State: you are **AI and cannot handle crises**
- Give resources and ask if they'll seek help.
- Do not provide advice or continue therapeutic conversation until user is safe.
- If user reports hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**

## Tone & Interaction Guidelines
Maintain a **calm, nonjudgmental, warm, and inclusive tone**. Validate user experiences and avoid any critical, dismissive, or biased responses. Respect all backgrounds and use **inclusive, trauma-informed language**—let users control how much they share. Avoid pushing for details; gently prompt for preferences. **Empower users**: offer choices, invitations, not commands. Use active listening without oversharing about yourself. Keep responses simple, clear, compassionate—avoid jargon or explain it simply if needed. Always prioritize user autonomy and safety.

## Privacy (HIPAA) Principles
**Treat all communications as confidential**. Do not request or repeat unnecessary personal info. If users provide identifiers, do NOT store unless secure/HIPAA-compliant (if must, de-identify and encrypt). Gently remind users not to overshare sensitive details. At the session start, state: this chat is confidential, you are AI (not a healthcare provider), and users should not provide PHI unless comfortable. **Never share data with outside parties** except required by law or explicit, user-consented emergencies. No user info for ads or non-support purposes.

## Session Framing & Disclaimers
At each session's start, present a brief disclaimer about your **AI identity, purpose, limits, and crisis response** (e.g.: "Hello, I'm an AI mental health support assistant—not a therapist/doctor. I can't diagnose, but I'll listen and offer coping ideas. If you're in crisis, contact ${crisisText}. What would you like to talk about?"). Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics). If persistent, reinforce boundaries and suggest consulting professionals. Suggest healthy breaks and discourage dependency if user chats excessively.

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

  return basePrompt + (languageInstructions[language] || '');
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
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false', // Use secure cookies in production (disable with COOKIE_SECURE=false for local testing)
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
      secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
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
      console.log(`✓ Admin message logged to database`);
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
            {
                type: "function",
                name: "generate_horoscope",
                description: "Give today's horoscope for an astrological sign.",
                parameters: {
                    type: "object",
                    properties: {
                        sign: {
                            type: "string",
                            description: "The sign for the horoscope.",
                            enum: [
                                "Aries",
                                "Taurus",
                                "Gemini",
                                "Cancer",
                                "Leo",
                                "Virgo",
                                "Libra",
                                "Scorpio",
                                "Sagittarius",
                                "Capricorn",
                                "Aquarius",
                                "Pisces"
                            ]
                        }
                    },
                    required: ["sign"]
                }
            }
        ],
        tool_choice: "auto",
      model: "gpt-realtime-mini",
      instructions: await getSystemPrompt('en'),
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
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await verifyCredentials(username, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Set session
    req.session.userId = user.userid;
    req.session.username = user.username;
    req.session.userRole = user.role;

    // Explicitly save session to ensure it persists
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
      } else {
        console.log('✓ User logged in and session saved:', {
          userId: user.userid,
          username: user.username,
          role: user.role
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
        console.log(`✗ Session limit exceeded for user ${userId}:`, limitCheck.reason);
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
          console.log(`✓ Returning existing active session for user ${userId}:`, {
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
      // Get user settings from request body (if POST) or use defaults
      const userVoice = req.body?.voice || 'cedar';
      const userLanguage = req.body?.language || 'en';
      const temperature = 0.8; // Fixed temperature

      // Create dynamic session config with user settings
      const dynamicSessionConfig = JSON.stringify({
        session: {
            type: "realtime",
            tools: [
                  {
                      type: "function",
                      name: "generate_horoscope",
                      description: "Give today's horoscope for an astrological sign.",
                      parameters: {
                          type: "object",
                          properties: {
                              sign: {
                                  type: "string",
                                  description: "The sign for the horoscope.",
                                  enum: [
                                      "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                                      "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"
                                  ]
                              }
                          },
                          required: ["sign"]
                      }
                  }
              ],
              tool_choice: "auto",
            model: "gpt-realtime-mini",
            instructions: await getSystemPrompt(userLanguage),
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
        console.log(`✓ Therapy session created with user_id: ${userId}`);

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

          console.log(`✓ Session ${sessionId} will auto-terminate in ${limitCheck.limits.max_duration_minutes} minutes`);
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
        console.log(`✓ Session configuration created for session: ${sessionId.substring(0, 12)}... (voice: ${userVoice}, language: ${userLanguage})`);
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
//     console.error("❌ Failed to insert log into DB:", err);
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
      console.log(`✓ Session ${sessionId} already ended, returning existing data (idempotent)`);
      return res.status(200).json({
        ...session,
        alreadyEnded: true,
        message: "Session was already ended"
      });
    }

    // Session is active - proceed with ending it (ended by user)
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
    const messages = [];
    const sessionIds = new Set();

    // Process records and collect unique session IDs
    for (const record of records) {
      const { timestamp, sessionId, role, type, message, extras } = record;
      if (!timestamp || !sessionId || !role || !type) continue;

      sessionIds.add(sessionId);

      const redactedMessage = await redactPHI(message);

      messages.push({
        session_id: sessionId,
        role: role,
        message_type: type,
        content: message,
        content_redacted: redactedMessage,
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
        console.log(`✓ Created session ${sessionId.substring(0, 12)}... with user_id: ${userId}`);

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
          console.log(`✓ Session configuration created for session: ${sessionId.substring(0, 12)}...`);
        } catch (configError) {
          console.error(`Failed to create session configuration for ${sessionId}:`, configError);
          // Continue anyway - configuration is not critical for message logging
        }
      }
    }

    // Insert all messages
    const insertedMessages = await insertMessagesBatch(messages);

    // ========== SOCKET.IO EVENT EMISSION ==========
    // Group messages by session for efficient emission
    const sessionGroups = {};
    insertedMessages.forEach(msg => {
      if (!sessionGroups[msg.session_id]) sessionGroups[msg.session_id] = [];
      sessionGroups[msg.session_id].push({
        message_id: msg.message_id,
        role: msg.role,
        message_type: msg.message_type,
        content: msg.content_redacted, // Always redacted for real-time
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
        COUNT(m.message_id) as message_count,
        MAX(m.created_at) as last_activity,
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ts.created_at)) as duration_seconds
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      LEFT JOIN messages m ON ts.session_id = m.session_id
      WHERE ts.status = 'active'
      GROUP BY ts.session_id, u.username
      ORDER BY ts.created_at DESC
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
      console.log(`✓ Admin: Session ${sessionId} already ended, returning existing data (idempotent)`);
      return res.status(200).json({
        ...session,
        alreadyEnded: true,
        message: "Session was already ended"
      });
    }

    // Session is active - proceed with ending it (ended by admin)
    const updatedSession = await updateSessionStatus(sessionId, 'ended', req.session.username);

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

    console.log(`✓ Admin ${req.session.username} remotely ended session ${sessionId}`);

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
  const { search, startDate, endDate, minMessages, maxMessages, page = 1, limit = 50 } = req.query;

  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(`
      WITH session_stats AS (
        SELECT
          ts.session_id,
          ts.session_name,
          ts.user_id,
          u.username,
          ts.status,
          ts.created_at AS start_time,
          ts.ended_at AS end_time,
          ts.ended_by,
          EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) AS duration_seconds,
          COUNT(m.message_id) AS total_messages,
          COUNT(m.message_id) FILTER (WHERE m.role = 'user') AS user_messages,
          COUNT(m.message_id) FILTER (WHERE m.role = 'assistant') AS assistant_messages,
          COUNT(m.message_id) FILTER (WHERE m.message_type = 'voice') AS voice_messages,
          COUNT(m.message_id) FILTER (WHERE m.message_type = 'chat') AS chat_messages
        FROM therapy_sessions ts
        LEFT JOIN users u ON ts.user_id = u.userid
        LEFT JOIN messages m ON ts.session_id = m.session_id
        WHERE
          ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
          AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
          AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
        GROUP BY ts.session_id, u.username, ts.ended_by
      )
      SELECT * FROM session_stats
      WHERE
        ($4::INT IS NULL OR total_messages >= $4)
        AND ($5::INT IS NULL OR total_messages <= $5)
      ORDER BY start_time DESC
      LIMIT $6 OFFSET $7
    `, [
      search || null,
      startDate || null,
      endDate || null,
      minMessages ? parseInt(minMessages) : null,
      maxMessages ? parseInt(maxMessages) : null,
      parseInt(limit),
      offset
    ]);

    // Get total count for pagination
    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT ts.session_id) as total
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      WHERE
        ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
        AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
        AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
    `, [search || null, startDate || null, endDate || null]);

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
  const { startDate, endDate } = req.query;

  try {
    const result = await pool.query(`
      WITH date_filtered_sessions AS (
        SELECT * FROM therapy_sessions
        WHERE
          ($1::TIMESTAMP IS NULL OR created_at >= $1)
          AND ($2::TIMESTAMP IS NULL OR created_at <= $2)
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
        (SELECT json_agg(voice_stats.*) FROM voice_stats) AS voice_distribution
    `, [startDate || null, endDate || null]);

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
      voice_distribution: data.voice_distribution || []
    });
  } catch (err) {
    console.error("Failed to fetch analytics:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// GET /admin/api/export - Export data as JSON or CSV
app.get("/admin/api/export", requireRole('therapist', 'researcher'), async (req, res) => {
  const { format = 'json', sessionId, startDate, endDate } = req.query;

  try {
    let query, params;

    // Use content_redacted for researchers, content for therapists
    const contentColumn = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';

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
        ORDER BY m.created_at ASC
      `;
      params = [startDate || null, endDate || null];
    }

    const result = await pool.query(query, params);

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

    console.log(`✓ Config updated: ${key} by ${req.session.username}`);

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

async function startProdServer() {
  console.log("Starting in production mode...");

  // Serve static files from the client build directory.
  app.use(express.static(path.resolve(__dirname, '../../dist/client')));

  // Serve admin static assets (CSS, JS) - admin assets are prefixed with "admin-" so no conflicts
  app.use('/assets', express.static(path.resolve(__dirname, '../../dist/admin-client/assets')));

  // Dynamically import both SSR modules
  const { render } = await import('../../dist/server/entry-server.js');
  const { render: renderAdmin } = await import('../../dist/admin-server/admin-entry-server.js');

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
      const template = await vite.transformIndexHtml(
        req.originalUrl,
        fs.readFileSync(path.resolve(__dirname, "../client/admin/admin.html"), "utf-8")
      );
      const { render } = await vite.ssrLoadModule("src/client/admin/admin-entry-server.jsx");
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

httpServer.listen(port, () => {
  console.log(`✅ Express server running on http://localhost:${port}`);
  console.log(`✅ Socket.io server ready for real-time connections`);
});