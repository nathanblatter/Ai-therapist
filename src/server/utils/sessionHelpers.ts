import { pool } from '../config/db.js';
import { fetchSystemConfigRows } from '../db/index.js';
import { getStartOfTodaySLC } from './timezoneHelpers.js';
import { createLogger } from './logger.js';
import type {
  CrisisContact,
  SessionLimits,
  VoicesConfig,
  LanguageOption,
  LanguagesConfig,
} from '../../shared/systemConfig.js';

const log = createLogger('sessionHelpers');

interface SystemPromptEntry {
  prompt: string;
  last_modified?: string;
}

/** One step of a modality's session-phase script (ai-therapist-51):
 *  `at` is the fraction (0-1) of the session's max duration when the nudge
 *  fires; `guidance` is the steer injected invisibly at that point. */
export interface ModalityPhase {
  at: number;
  label: string;
  guidance: string;
}

export interface ModalityPreset {
  label: string;
  addition: string;
  /** Ordered phase script walking the model through this approach's protocol
   *  (e.g. CBT: agenda -> review homework -> work -> assign practice). Falls
   *  back to the generic 60%/85% consolidate/wind-down script when absent —
   *  see sidebandManager.service.ts schedulePhaseNudges. */
  phases?: ModalityPhase[];
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
    phases: [
      { at: 0.15, label: 'open', guidance: 'Settle into open, unhurried listening — invite them to share whatever is on their mind, without steering toward a specific topic yet.' },
      { at: 0.45, label: 'explore', guidance: 'Deepen your understanding: ask gentle follow-up questions and reflect back what you are hearing, rather than problem-solving.' },
      { at: 0.7, label: 'validate', guidance: 'Focus on validating their experience and normalizing their feelings; offer a coping idea only if they seem stuck or ask for one.' },
      { at: 0.85, label: 'close', guidance: 'Begin winding down: summarize what was shared, highlight anything that seemed to help, and invite final thoughts before closing warmly.' },
    ],
  },
  cbt: {
    label: 'CBT-informed',
    addition: `\n\n## Therapeutic approach: CBT-informed\nUse cognitive-behavioral techniques where natural: help the participant notice the link between situations, thoughts, feelings, and behaviours; gently examine unhelpful thought patterns with curious questions (never lecture); suggest small, concrete behavioural experiments or coping actions. One technique at a time.`,
    phases: [
      { at: 0.15, label: 'agenda', guidance: 'Collaboratively set or confirm today\'s agenda: ask what would be most useful to focus on in this conversation.' },
      { at: 0.3, label: 'review_homework', guidance: 'If a practice or homework item was suggested in a previous session, briefly check in on how it went before moving on.' },
      { at: 0.65, label: 'work', guidance: 'This is the core working phase: use cognitive-behavioral techniques (thought records, examining evidence, small behavioural experiments) on the agenda item, one technique at a time.' },
      { at: 0.85, label: 'assign_practice', guidance: 'Begin winding down: summarize what was worked on and, if it fits naturally, suggest one small, concrete practice item to try before the next conversation, then close warmly.' },
    ],
  },
  act: {
    label: 'ACT-informed',
    addition: `\n\n## Therapeutic approach: ACT-informed\nDraw on acceptance and commitment ideas: help the participant make room for difficult feelings rather than fight them, notice thoughts as thoughts (defusion), connect with what they value, and take one small values-aligned step. Use plain language, not ACT jargon.`,
    phases: [
      { at: 0.15, label: 'engage', guidance: 'Connect with what brought them here today and how they are experiencing it right now, in plain language.' },
      { at: 0.4, label: 'defusion_acceptance', guidance: 'Gently help them notice difficult thoughts and feelings as things to make room for rather than fight — defusion and acceptance, without jargon.' },
      { at: 0.65, label: 'values', guidance: 'Explore what matters to them underneath the struggle — their values — and how the current situation connects to those.' },
      { at: 0.85, label: 'committed_action', guidance: 'Begin winding down: help them identify one small, values-aligned step, then summarize and close warmly.' },
    ],
  },
  mi: {
    label: 'Motivational interviewing',
    addition: `\n\n## Therapeutic approach: motivational interviewing\nUse the MI spirit: open questions, affirmations, reflections, summaries. Roll with resistance instead of arguing; draw out the participant's own reasons for change (change talk); support autonomy — they are the expert on their life.`,
    phases: [
      { at: 0.15, label: 'engage', guidance: 'Focus on engaging: build rapport with open questions and reflective listening before steering toward any particular change.' },
      { at: 0.4, label: 'focus', guidance: 'Help clarify a focus — what change, if any, they are considering — using their language, not yours.' },
      { at: 0.65, label: 'evoke', guidance: 'Evoke their own reasons for change: draw out change talk with open questions, affirmations, and reflections; roll with any resistance instead of arguing.' },
      { at: 0.85, label: 'plan', guidance: 'If they are ready, begin exploring what a small next step could look like, supporting their autonomy; then summarize and close warmly.' },
    ],
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

// Hard caps for magic-link demo accounts (resume viewers). Enforced regardless
// of the global session_limits config so a recruiter can always try the product
// but can't run up unbounded OpenAI cost. Short sessions, few per day.
export const DEMO_SESSION_LIMITS = {
  max_sessions_per_day: 5,
  max_duration_minutes: 5,
  cooldown_minutes: 0,
} as const;

export async function checkSessionLimits(userId: unknown, userRole: string | null = null): Promise<SessionLimitResult> {
  if (!userId) {
    // Anonymous users don't have limits enforced
    return { allowed: true };
  }

  // Demo (magic-link) accounts: always capped, independent of global config.
  if (userRole === 'demo') {
    const todayStart = getStartOfTodaySLC();

    const demoToday = await pool.query<{ session_count: string }>(
      `SELECT COUNT(*) as session_count
       FROM therapy_sessions
       WHERE user_id = $1 AND created_at >= $2`,
      [userId, todayStart]
    );
    const demoCount = parseInt(demoToday.rows[0].session_count);

    if (demoCount >= DEMO_SESSION_LIMITS.max_sessions_per_day) {
      return {
        allowed: false,
        reason: 'daily_limit',
        message: `This demo is limited to ${DEMO_SESSION_LIMITS.max_sessions_per_day} sessions per day. Please try again tomorrow.`,
        limit: DEMO_SESSION_LIMITS.max_sessions_per_day,
        current: demoCount,
      };
    }

    return {
      allowed: true,
      limits: {
        max_duration_minutes: DEMO_SESSION_LIMITS.max_duration_minutes,
        max_sessions_per_day: DEMO_SESSION_LIMITS.max_sessions_per_day,
        sessions_today: demoCount,
      },
    };
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
  const todayStart = getStartOfTodaySLC();

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
You are an AI **therapeutic assistant** for adults, providing **general emotional support and therapeutic conversation** only. Use empathy and evidence-based self-help (e.g., **CBT, DBT, mindfulness, journaling**) to help users cope with stress, anxiety, and common emotions. Make it clear: you **support and guide, not replace a human therapist**. **Once, at the start of the session**, make clear you are **not licensed** and that your help is **not a substitute for professional therapy/medical care** — then do NOT repeat this disclaimer in later replies unless the participant asks about your limits or requests diagnosis/medical advice. Encourage seeking a **licensed therapist for serious issues**. Stay within **support, coping, active listening, and psycho-education**—no clinical claims.

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
At each session's start, present a brief disclaimer about your **AI identity, purpose, limits, and crisis response** (e.g.: "Hello, I'm an AI mental health support assistant—not a therapist/doctor. I can't diagnose, but I'll listen and offer coping ideas. If you're in crisis, contact {{crisis_text}}. What would you like to talk about?"). Give this disclaimer only ONCE, at the start — do NOT repeat it in subsequent replies. Re-state your limits only if the conversation goes off-scope (e.g., they request diagnosis or ongoing medical advice). If persistent, reinforce boundaries and suggest consulting professionals. Suggest healthy breaks and discourage dependency if user chats excessively.

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

// ============================================
// PROACTIVE EXERCISE OFFERING (ai-therapist-74)
// ============================================
// Steering, not a new tool: when the participant is visibly stuck on a
// specific thought/emotion, nudge the model to OFFER a fitting exercise
// (find_worksheet / suggest_modality_technique / start_*), always with
// consent, offered once, never repeated. Whether a session gets this
// steering is a config-controlled research condition (A/B), resolved once
// per session and recorded on session_configurations.proactive_offering so
// outcomes can be compared against the reactive-only baseline.
const PROACTIVE_OFFERING_ADDITION = `\n\n## Proactively offering exercises (research condition: proactive)
When the participant seems stuck on a specific thought, feeling, or pattern — going in circles, naming distress without movement, or explicitly saying they don't know what to do — proactively OFFER one concrete, fitting exercise or technique (e.g. via find_worksheet, suggest_modality_technique, start_thought_record, start_breathing_exercise, start_grounding_exercise, start_body_scan, start_values_sort, or start_fear_ladder), even if they haven't asked for one. Always frame it as an invitation and ask consent before starting ("would it help to try something?") — never assume yes. Offer ONCE per stuck moment; if they decline or don't engage, drop it and keep listening — do not re-offer the same or a different exercise for the same moment, and do not nag across the session.`;

const REACTIVE_ONLY_ADDITION = `\n\n## Offering exercises (research condition: reactive)
Offer exercises or techniques (find_worksheet, suggest_modality_technique, start_thought_record, breathing/grounding/body-scan, values sort, fear ladder) only when the participant asks for one or clearly signals they want something concrete to try. Do not proactively suggest one unprompted.`;

interface ProactiveOfferingConfig {
  /** 'always' forces proactive steering on every session, 'never' forces it
   *  off, 'ab_test' randomly assigns 50/50 per session (default). */
  mode?: 'always' | 'never' | 'ab_test';
}

/** Resolve this session's proactive-offering research condition. Call once per
 *  session (at token-mint time) and persist the result — don't re-roll it. */
export async function resolveProactiveOffering(): Promise<boolean> {
  const config = await getSystemConfig();
  const features = (config.features ?? {}) as { proactive_offering?: ProactiveOfferingConfig };
  const mode = features.proactive_offering?.mode ?? 'ab_test';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return Math.random() < 0.5;
}

export async function getSystemPrompt(language = 'en', sessionType = 'realtime', proactiveOffering?: boolean): Promise<string> {
  const config = await getSystemConfig();
  const crisisContact = (config.crisis_contact as CrisisContact | undefined) || {
    hotline: '988 Suicide & Crisis Lifeline',
    phone: '988',
    text: 'Text HOME to 741741'
  };

  // Build the crisis text for interpolation
  const crisisText = crisisContact.enabled
    ? `${crisisContact.hotline} ${crisisContact.phone}${crisisContact.text ? ', text ' + crisisContact.text : ''}, or 911`
    : '988 (Suicide and Crisis Lifeline), or 911 for immediate danger';

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
    ? languagesConfig.languages.find((l: LanguageOption) => l.value === language)
    : null;
  const languageAddition = languageObj?.systemPromptAddition || '';

  // Active therapeutic-modality appendix (research condition; see getActiveModality).
  const modality = await getActiveModality();
  const modalityAddition = modality?.preset.addition ?? '';

  // Proactive-vs-reactive exercise-offering appendix (ai-therapist-74). If the
  // caller didn't resolve+pass a per-session value, resolve it here so preview
  // / fallback call sites still get a coherent prompt (not persisted as a
  // research condition in that case — only token.routes.ts's per-session call
  // does that).
  const proactive = proactiveOffering ?? await resolveProactiveOffering();
  const proactiveAddition = proactive ? PROACTIVE_OFFERING_ADDITION : REACTIVE_ONLY_ADDITION;

  return basePrompt + modalityAddition + proactiveAddition + languageAddition;
}

export const sessionConfigDefault = {
  session: {
    type: "realtime",
    tools: [] as unknown[],
    tool_choice: "auto",
    model: "gpt-realtime-2.1-mini",
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
        },
        turn_detection: { type: "semantic_vad", eagerness: "low" },
      },
      output: {
        voice: "cedar",
      },
    },
  },
};
