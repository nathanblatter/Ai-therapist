import { pool } from '../config/db.js';
import { createLogger } from './logger.js';

const log = createLogger('sessionHelpers');

// Cache for system config to avoid database hits on every request
let systemConfigCache = null;
let configCacheTime = null;
const CONFIG_CACHE_TTL = 600000; // 10 minutes

export async function getSystemConfig() {
  const now = Date.now();

  // Return cached config if still valid
  if (systemConfigCache && configCacheTime && (now - configCacheTime < CONFIG_CACHE_TTL)) {
    return systemConfigCache;
  }

  try {
    const result = await pool.query('SELECT config_key, config_value FROM system_config');
    const config = {};
    result.rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });

    systemConfigCache = config;
    configCacheTime = now;
    return config;
  } catch (err) {
    log.error({ err }, 'Failed to fetch system config');
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

export function invalidateConfigCache() {
  systemConfigCache = null;
  configCacheTime = null;
}

export async function checkSessionLimits(userId, userRole = null) {
  if (!userId) {
    // Anonymous users don't have limits enforced
    return { allowed: true };
  }

  // Researcher accounts are exempt from limits
  if (userRole === 'researcher') {
    log.info(`Researcher ${userId} bypassing session limits`);
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

      log.debug({
        lastEndedAt: lastEndedAt.toISOString(),
        now: now.toISOString(),
        timeSinceEndMs,
        timeSinceEndMinutes: timeSinceEndMs / 60000,
        cooldownMinutes: limits.cooldown_minutes,
        cooldownMs,
        isInCooldown: timeSinceEndMs < cooldownMs
      }, 'Cooldown check');

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

// Default system prompt used as fallback if database config is unavailable
export const DEFAULT_SYSTEM_PROMPT = `## Purpose & Scope
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

export async function getSystemPrompt(language = 'en', sessionType = 'realtime') {
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

export const sessionConfigDefault = {
  session: {
    type: "realtime",
    tools: [],
    tool_choice: "auto",
    model: "gpt-realtime-mini",
    audio: {
      input: {
        transcription: {
          model: "whisper-1",
        }
      },
      output: {
        voice: "cedar",
      },
    },
  },
};
