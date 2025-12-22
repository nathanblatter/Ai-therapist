import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import {getOpenAIKey} from "./loadSecrets.js"; // Import the function to get the OpenAI API key
import {pool } from "./db.js";
import redactPHI from "./redact.js";
import { requireAuth, requireRole, verifyCredentials, createUser, getAllUsers, getUserById, updateUser, deleteUser } from "./auth.js";

// ES module-compatible __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



const app = express();
const port = process.env.PORT ;


const apiKey = await getOpenAIKey();


const systemPrompt = `## Purpose & Scope
You are an AI **therapeutic assistant** for adults, providing **general emotional support and therapeutic conversation** only. Use empathy and evidence-based self-help (e.g., **CBT, DBT, mindfulness, journaling**) to help users cope with stress, anxiety, and common emotions. Make it clear: you **support and guide, not replace a human therapist**. Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**. Encourage seeking a **licensed therapist for serious issues**. Stay within **support, coping, active listening, and psycho-education**—no clinical claims.

## Boundaries & Limitations
**Never diagnose, give medication, or legal advice.** Avoid medical or legal topics; instead, offer **non-medication coping, self-care, lifestyle tips, relaxation, and gentle suggestions**. Do not suggest specific drugs/supplements or treatment plans. If asked for diagnosis or medical/legal advice, **politely decline** and clarify your non-professional status. Never misrepresent your credentials. Do not set up treatment plans or contracts or act as a human/professional; **focus on user’s goals and autonomy**, using open-ended questions and suggestions.

## Crisis Protocol
**If user expresses risk (suicidality, harm, acute crisis):**
- **Immediately stop normal conversation**
- Urge them to seek emergency help (e.g., BYU CAPS Crisis Line (801) 422-3035, text HELLO to 741741, or 911).
- State: you are **AI and cannot handle crises**
- Give resources and ask if they’ll seek help.
- Do not provide advice or continue therapeutic conversation until user is safe.
- If user reports hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**

## Tone & Interaction Guidelines
Maintain a **calm, nonjudgmental, warm, and inclusive tone**. Validate user experiences and avoid any critical, dismissive, or biased responses. Respect all backgrounds and use **inclusive, trauma-informed language**—let users control how much they share. Avoid pushing for details; gently prompt for preferences. **Empower users**: offer choices, invitations, not commands. Use active listening without oversharing about yourself. Keep responses simple, clear, compassionate—avoid jargon or explain it simply if needed. Always prioritize user autonomy and safety.

## Privacy (HIPAA) Principles
**Treat all communications as confidential**. Do not request or repeat unnecessary personal info. If users provide identifiers, do NOT store unless secure/HIPAA-compliant (if must, de-identify and encrypt). Gently remind users not to overshare sensitive details. At the session start, state: this chat is confidential, you are AI (not a healthcare provider), and users should not provide PHI unless comfortable. **Never share data with outside parties** except required by law or explicit, user-consented emergencies. No user info for ads or non-support purposes.

## Session Framing & Disclaimers
At each session’s start, present a brief disclaimer about your **AI identity, purpose, limits, and crisis response** (e.g.: “Hello, I’m an AI mental health support assistant—not a therapist/doctor. I can’t diagnose, but I’ll listen and offer coping ideas. If you’re in crisis, contact (801) 422-3035 or 911. What would you like to talk about?”). Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics). If persistent, reinforce boundaries and suggest consulting professionals. Suggest healthy breaks and discourage dependency if user chats excessively.

At session close, remind users: you’re a support tool and for ongoing or serious issues, professional help is best. Reiterate crisis resources as needed. Include legal/safety disclaimers (“This AI is not a licensed healthcare provider.”). Encourage users to agree/acknowledge the service boundaries before chatting as required by your platform.

## Content Moderation & Guardrails
- **No diagnosis, no medical or legal advice**
- **Never facilitate harm or illegal activity**
- If user requests inappropriate/graphic help, **refuse and redirect** (especially for non-therapy sexual, violent, or criminal content)
- **Safely escalate to professional help** when issues seem severe/persistent
- **Maintain boundaries**: Refuse inappropriate requests or dependency; reinforce you’re AI, not a human/relationship/secret-keeper
- **Technical guardrails**: Abide by system flags or moderation protocols—always prioritize user safety, not engagement
- If a request risks harm or crosses ethical/safety lines, **refuse firmly but empathetically**; safety overrides user satisfaction

**Summary:**
You provide supportive, ethical guidance, never diagnose/prescribe, keep all conversations safe/private, transparently communicate limits, and always refer to professional help in crisis. Be calm, caring, and user-centered—empower, don’t direct. Prioritize user safety, confidentiality, and professional boundaries at all times.`;

app.use(express.json()); // Needed to parse JSON bodies

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'ai-therapist-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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
      instructions: systemPrompt,
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
app.post("/api/auth/register", requireRole('therapist', 'researcher'), async (req, res) => {
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
app.get("/token", async (req, res) => {
  try {
      const response = await fetch(
          "https://api.openai.com/v1/realtime/client_secrets",
          {
              method: "POST",
              headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
              },
              body: sessionConfig,
          }
      );

      const data = await response.json();
      res.json(data);
      console.log(data)
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

// ===================== Logs batch route with redaction =====================
app.post("/logs/batch", async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).send("No records provided");
  }

  try {
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const record of records) {
      const { timestamp, sessionId, role, type, message, extras } = record;
      if (!timestamp || !sessionId || !role || !type) continue;
      const redactedMessage = await redactPHI(message);

      

      values.push(sessionId, role, type, redactedMessage, extras || null, new Date(timestamp));
      placeholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`
      );
      paramIndex += 6;
    }

    if (values.length === 0) {
      return res.status(400).send("No valid records to insert");
    }

    await pool.query(
      `INSERT INTO conversation_logs (session_id, role, message_type, message, extras, created_at)
       VALUES ${placeholders.join(", ")}`,
      values
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("Failed to insert batch logs into DB:", err);
    res.sendStatus(500);
  }
});

// ===================== Admin API Routes =====================

// GET /admin/api/sessions - List all sessions with filters
app.get("/admin/api/sessions", requireRole('therapist', 'researcher'), async (req, res) => {
  const { search, startDate, endDate, minMessages, maxMessages, page = 1, limit = 50 } = req.query;

  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(`
      WITH session_stats AS (
        SELECT
          session_id,
          MIN(created_at) AS start_time,
          MAX(created_at) AS end_time,
          EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) AS duration_seconds,
          COUNT(*) AS total_messages,
          COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_messages,
          COUNT(*) FILTER (WHERE message_type = 'voice') AS voice_messages,
          COUNT(*) FILTER (WHERE message_type = 'chat') AS chat_messages
        FROM conversation_logs
        WHERE
          ($1::TEXT IS NULL OR session_id ILIKE '%' || $1 || '%')
          AND ($2::TIMESTAMP IS NULL OR created_at >= $2)
          AND ($3::TIMESTAMP IS NULL OR created_at <= $3)
        GROUP BY session_id
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
      SELECT COUNT(DISTINCT session_id) as total
      FROM conversation_logs
      WHERE
        ($1::TEXT IS NULL OR session_id ILIKE '%' || $1 || '%')
        AND ($2::TIMESTAMP IS NULL OR created_at >= $2)
        AND ($3::TIMESTAMP IS NULL OR created_at <= $3)
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
    const result = await pool.query(`
      SELECT
        id,
        session_id,
        role,
        message_type,
        message,
        extras,
        created_at
      FROM conversation_logs
      WHERE session_id = $1
      ORDER BY created_at ASC
    `, [sessionId]);

    res.json({
      session_id: sessionId,
      messages: result.rows
    });
  } catch (err) {
    console.error("Failed to fetch session details:", err);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

// GET /admin/api/analytics - Dashboard metrics
app.get("/admin/api/analytics", requireRole('therapist', 'researcher'), async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const result = await pool.query(`
      WITH date_filtered_logs AS (
        SELECT * FROM conversation_logs
        WHERE
          ($1::TIMESTAMP IS NULL OR created_at >= $1)
          AND ($2::TIMESTAMP IS NULL OR created_at <= $2)
      ),
      session_metrics AS (
        SELECT
          COUNT(DISTINCT session_id) AS total_sessions,
          COUNT(*) AS total_messages,
          AVG(msg_count) AS avg_messages_per_session,
          AVG(duration) AS avg_duration_seconds
        FROM (
          SELECT
            session_id,
            COUNT(*) AS msg_count,
            EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) AS duration
          FROM date_filtered_logs
          GROUP BY session_id
        ) AS sessions
      ),
      message_breakdown AS (
        SELECT
          COUNT(*) FILTER (WHERE message_type = 'voice') AS voice_messages,
          COUNT(*) FILTER (WHERE message_type = 'chat') AS chat_messages,
          COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_messages
        FROM date_filtered_logs
      ),
      daily_sessions AS (
        SELECT
          DATE(created_at) AS date,
          COUNT(DISTINCT session_id) AS session_count
        FROM date_filtered_logs
        WHERE message_type = 'session_start'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      )
      SELECT
        (SELECT row_to_json(session_metrics.*) FROM session_metrics) AS metrics,
        (SELECT row_to_json(message_breakdown.*) FROM message_breakdown) AS breakdown,
        (SELECT json_agg(daily_sessions.*) FROM daily_sessions) AS daily_trend
    `, [startDate || null, endDate || null]);

    const data = result.rows[0];
    res.json({
      metrics: data.metrics || {},
      breakdown: data.breakdown || {},
      daily_trend: data.daily_trend || []
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

    if (sessionId) {
      query = `SELECT * FROM conversation_logs WHERE session_id = $1 ORDER BY created_at ASC`;
      params = [sessionId];
    } else {
      query = `
        SELECT * FROM conversation_logs
        WHERE
          ($1::TIMESTAMP IS NULL OR created_at >= $1)
          AND ($2::TIMESTAMP IS NULL OR created_at <= $2)
        ORDER BY created_at ASC
      `;
      params = [startDate || null, endDate || null];
    }

    const result = await pool.query(query, params);

    if (format === 'csv') {
      // Simple CSV formatting
      const headers = ['id', 'session_id', 'role', 'message_type', 'message', 'extras', 'created_at'];
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

async function startProdServer() {
  console.log("Starting in production mode...");

  // Serve static files from the client build directory.
  app.use(express.static(path.resolve(__dirname, 'client/dist/client')));

  // Dynamically import both SSR modules
  const { render } = await import('./client/dist/server/entry-server.js');
  const { render: renderAdmin } = await import('./client/dist/server/admin-entry-server.js');

  // Admin panel route
  app.get('/admin', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const template = fs.readFileSync(path.resolve(__dirname, 'client/dist/client/admin.html'), 'utf-8');
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
      const template = fs.readFileSync(path.resolve(__dirname, 'client/dist/client/index.html'), 'utf-8');
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

  app.get("/login", (req, res) => {
    res.send("<h1>Login Page</h1>");
  });

  // Admin panel route in dev
  app.get("/admin", requireRole('therapist', 'researcher'), async (req, res, next) => {
    try {
      const template = await vite.transformIndexHtml(
        req.originalUrl,
        fs.readFileSync(path.resolve(__dirname, "./client/admin/admin.html"), "utf-8")
      );
      const { render } = await vite.ssrLoadModule("./admin/admin-entry-server.jsx");
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
        fs.readFileSync(path.resolve(__dirname, "./client/index.html"), "utf-8")
      );
      // Make sure the path here is relative to the project root for ssrLoadModule
      const { render } = await vite.ssrLoadModule("./entry-server.jsx");
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

app.listen(port, () => {
  console.log(`✅ Express server running on http://localhost:${port}`);
});