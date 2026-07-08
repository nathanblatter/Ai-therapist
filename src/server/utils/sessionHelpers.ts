import { pool } from '../config/db.js';
import { fetchSystemConfigRows } from '../db/index.js';
import { createLogger } from './logger.js';

const log = createLogger('sessionHelpers');

interface CrisisContact {
  hotline: string;
  phone: string;
  text?: string;
  enabled?: boolean;
}

interface SessionLimits {
  enabled: boolean;
  max_duration_minutes?: number;
  max_sessions_per_day?: number;
  cooldown_minutes?: number;
}

interface VoiceConfig {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
}

interface VoicesConfig {
  voices?: VoiceConfig[];
  default_voice?: string;
}

interface LanguageConfig {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
  systemPromptAddition?: string;
}

interface LanguagesConfig {
  languages?: LanguageConfig[];
  default_language?: string;
}

interface SystemPromptEntry {
  prompt: string;
  last_modified?: string;
}

export interface ModalityPreset {
  label: string;
  addition: string;
}

interface SystemPromptsConfig {
  realtime?: SystemPromptEntry;
  chat?: SystemPromptEntry;
  /** Therapeutic-approach appendices, keyed by modality id (cbt/act/mi/...). */
  modality_presets?: Record<string, ModalityPreset>;
  /** Which preset is applied to new sessions; null/absent/'none' = base prompt only. */
  active_modality?: string | null;
}

// Editable via the SystemPrompts admin tab (stored in system_config); these are
// the fallbacks when the config has no modality_presets yet.
export const DEFAULT_MODALITY_PRESETS: Record<string, ModalityPreset> = {
  supportive: {
    label: 'Supportive listening',
    addition: `\n\n## Therapeutic approach: supportive listening\nPrioritize reflective listening and validation. Mirror the participant's language, summarize what you hear, and normalize their feelings. Offer coping ideas only when asked or when the participant seems stuck — the relationship is the intervention.`,
  },
  cbt: {
    label: 'CBT-informed',
    addition: `\n\n## Therapeutic approach: CBT-informed\nUse cognitive-behavioral techniques where natural: help the participant notice the link between situations, thoughts, feelings, and behaviours; gently examine unhelpful thought patterns with curious questions (never lecture); suggest small, concrete behavioural experiments or coping actions. One technique at a time.`,
  },
  act: {
    label: 'ACT-informed',
    addition: `\n\n## Therapeutic approach: ACT-informed\nDraw on acceptance and commitment ideas: help the participant make room for difficult feelings rather than fight them, notice thoughts as thoughts (defusion), connect with what they value, and take one small values-aligned step. Use plain language, not ACT jargon.`,
  },
  mi: {
    label: 'Motivational interviewing',
    addition: `\n\n## Therapeutic approach: motivational interviewing\nUse the MI spirit: open questions, affirmations, reflections, summaries. Roll with resistance instead of arguing; draw out the participant's own reasons for change (change talk); support autonomy — they are the expert on their life.`,
  },
};

/** Resolve the active modality preset from config (null = base prompt only). */
export async function getActiveModality(): Promise<{ key: string; preset: ModalityPreset } | null> {
  const config = await getSystemConfig();
  const prompts = config.system_prompts as SystemPromptsConfig | undefined;
  const key = prompts?.active_modality;
  if (!key || key === 'none') return null;
  const presets = { ...DEFAULT_MODALITY_PRESETS, ...(prompts?.modality_presets ?? {}) };
  const preset = presets[key];
  return preset ? { key, preset } : null;
}

interface SystemConfig {
  crisis_contact?: CrisisContact;
  session_limits?: SessionLimits;
  voices?: VoicesConfig;
  languages?: LanguagesConfig;
  system_prompts?: SystemPromptsConfig;
  features?: Record<string, unknown>;
  client_logging?: Record<string, unknown>;
  [key: string]: unknown;
}

// Cache for system config to avoid database hits on every request
let systemConfigCache: SystemConfig | null = null;
let configCacheTime: number | null = null;
const CONFIG_CACHE_TTL = 600000; // 10 minutes

export async function getSystemConfig(): Promise<SystemConfig> {
  const now = Date.now();

  // Return cached config if still valid
  if (systemConfigCache && configCacheTime && (now - configCacheTime < CONFIG_CACHE_TTL)) {
    return systemConfigCache;
  }

  try {
    const rows = await fetchSystemConfigRows();
    const config: SystemConfig = {};
    rows.forEach(row => {
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
        hotline: '988 Suicide & Crisis Lifeline',
        phone: '988',
        text: 'Text HOME to 741741',
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

export function invalidateConfigCache(): void {
  systemConfigCache = null;
  configCacheTime = null;
}

interface SessionLimitAllowed {
  allowed: true;
  bypass?: string;
  limits?: {
    max_duration_minutes?: number;
    max_sessions_per_day?: number;
    sessions_today?: number;
  };
}

interface SessionLimitDeniedDailyLimit {
  allowed: false;
  reason: 'daily_limit';
  message: string;
  limit: number;
  current: number;
}

interface SessionLimitDeniedCooldown {
  allowed: false;
  reason: 'cooldown';
  message: string;
  cooldown_minutes: number;
  minutes_remaining: number;
}

export type SessionLimitResult = SessionLimitAllowed | SessionLimitDeniedDailyLimit | SessionLimitDeniedCooldown;

export async function checkSessionLimits(userId: unknown, userRole: string | null = null): Promise<SessionLimitResult> {
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
  const limits = (config.session_limits as SessionLimits | undefined) || { enabled: false };

  if (!limits.enabled) {
    return { allowed: true };
  }

  // Check daily session count (using Salt Lake City timezone)
  const todayStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  todayStart.setHours(0, 0, 0, 0);

  const todaySessionsResult = await pool.query<{ session_count: string }>(
    `SELECT COUNT(*) as session_count
     FROM therapy_sessions
     WHERE user_id = $1 AND created_at >= $2`,
    [userId, todayStart]
  );

  const todaySessionCount = parseInt(todaySessionsResult.rows[0].session_count);

  if (limits.max_sessions_per_day !== undefined && todaySessionCount >= limits.max_sessions_per_day) {
    return {
      allowed: false,
      reason: 'daily_limit',
      message: `You have reached your daily limit of ${limits.max_sessions_per_day} sessions. Please try again tomorrow.`,
      limit: limits.max_sessions_per_day,
      current: todaySessionCount
    };
  }

  // Check cooldown period
  if (limits.cooldown_minutes && limits.cooldown_minutes > 0) {
    const recentSessionResult = await pool.query<{ ended_at: Date }>(
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

export async function getSystemPrompt(language = 'en', sessionType = 'realtime'): Promise<string> {
  const config = await getSystemConfig();
  const crisisContact = (config.crisis_contact as CrisisContact | undefined) || {
    hotline: '988 Suicide & Crisis Lifeline',
    phone: '988',
    text: 'Text HOME to 741741'
  };

  // Build the crisis text for interpolation
  const crisisText = crisisContact.enabled
    ? `${crisisContact.hotline} ${crisisContact.phone}${crisisContact.text ? ', text ' + crisisContact.text : ''}, or 911`
    : '911 or your local emergency services';

  // Get the prompt from database config, or use default fallback
  let basePrompt = DEFAULT_SYSTEM_PROMPT;
  const systemPrompts = config.system_prompts as SystemPromptsConfig | undefined;
  if (systemPrompts) {
    const entry = sessionType === 'chat' ? systemPrompts.chat : systemPrompts.realtime;
    if (entry?.prompt) {
      basePrompt = entry.prompt;
    }
  }

  // Interpolate {{crisis_text}} placeholder
  basePrompt = basePrompt.replace(/\{\{crisis_text\}\}/g, crisisText);

  // Get language-specific addition from database config
  const languagesConfig = (config.languages as LanguagesConfig | undefined) || { languages: [], default_language: 'en' };
  const languageObj = languagesConfig.languages
    ? languagesConfig.languages.find((l: LanguageConfig) => l.value === language)
    : null;
  const languageAddition = languageObj?.systemPromptAddition || '';

  // Active therapeutic-modality appendix (research condition; see getActiveModality).
  const modality = await getActiveModality();
  const modalityAddition = modality?.preset.addition ?? '';

  return basePrompt + modalityAddition + languageAddition;
}

export const sessionConfigDefault = {
  session: {
    type: "realtime",
    tools: [] as unknown[],
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
