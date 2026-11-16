// IRB attachment "AI Model System Prompts (Verbatim)"
// (docs/irb-phase2-instruments/prompts.html).
//
// Every prompt block in the attachment is produced by calling the same
// constants and builder functions the running server uses, with
// <angle-bracket placeholders> standing in for per-participant runtime values.
// Nothing prompt-shaped is retyped here, so the attachment cannot drift from
// the code silently: promptsAttachment.test.ts fails whenever the committed
// HTML differs from what this module renders. Regenerate with
// `npm run irb:prompts`.
//
// What this cannot see: prod and stage can override the base prompts, the
// modality presets and the language additions through system_config
// (system_prompts / languages). The attachment documents the CODE DEFAULTS.
//
// Only the explanatory prose below is hand-written. Bump PREPARED when the
// prompt text changes and the attachment is re-submitted.

import { readFileSync } from 'node:fs';

import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_MODALITY_PRESETS,
  PROACTIVE_OFFERING_ADDITION,
  REACTIVE_ONLY_ADDITION,
  buildCrisisText,
  sessionConfigDefault,
} from '../utils/sessionHelpers.js';
import {
  assembleMemoryBlock,
  buildCheckinBlock,
  buildScreenerCadenceBlock,
  buildToolGuidanceBlock,
} from '../utils/promptContext.js';
import { buildPhaseTexts } from '../utils/phaseGuidance.js';
import {
  LIVE_DEFAULT_BACKEND_MODEL,
  buildLiveBackendInstructions,
  buildLiveInstructions,
  buildLiveRecoveryInstructions,
} from '../utils/liveSessionConfig.js';
import {
  GROK_CURRENT_MODEL,
  buildGrokCrisisPhrase,
  buildGrokOpeningPrompt,
  buildGrokVoiceHeader,
  type CrisisContactLike,
} from '../utils/grokVoiceConfig.js';
import {
  GROK_DEFAULT_REFUSAL_GUARD,
  GROK_REFUSAL_STEER,
  buildGrokRefusalRecoveryLine,
} from '../utils/grokRefusalGuard.js';
import {
  CHAT_OPENING_FRAMING_GUIDANCE,
  buildChatOpeningLine,
  buildVoiceContinuationGuidance,
} from '../utils/openingLine.js';
import {
  CRISIS_CEILING_LIVE,
  CRISIS_CEILING_WRAP_UP,
  CRISIS_DISREGARD_WRAP_UP,
  CRISIS_NOTICE_MINUTES,
  TIME_LIMIT_STEER,
  TIME_NOTICE_MINUTES,
  WRAP_UP_NUDGE,
  crisisTimeNotice,
  timeNotice,
} from '../utils/sessionAutoTerminate.js';
import { SCALE_MIN_INTERVAL_DAYS } from '../utils/scales.js';
import { DEFAULT_VENDOR_CEILING_MINUTES } from '../../shared/systemConfig.js';
import {
  CHAT_SAFETY_PROTOCOL_GUIDANCE,
  CRISIS_WIND_DOWN_GUIDANCE,
  DEFAULT_RISK_CHECK_MIN_SCORE,
  RISK_CHECK_REQUIRED_GUIDANCE,
  SAFETY_PROTOCOL_GUIDANCE,
  STEER_COOLDOWN_MS,
  STEER_MIN_SCORE,
  WIND_DOWN_GRACE_MS,
  buildChatSteeringGuidance,
  steeringGuidance,
} from '../services/crisisIntervention.service.js';
import {
  DEFAULT_RISK_MODEL,
  RISK_ASSESSMENT_PROMPT,
  SWEEP_EVERY,
  buildRiskAssessmentUserMessage,
} from '../services/crisisDetection.service.js';
import {
  CONFIRM_MODEL,
  MINOR_CONFIRM_PROMPT,
  MINOR_ELIGIBILITY_MESSAGE,
  REALTIME_MINOR_GUIDANCE,
  buildMinorConfirmUserMessage,
} from '../services/minorSafeguard.service.js';
import { REDACTION_BATCH_INSTRUCTIONS, REDACTION_MODEL, REDACTION_PROMPT } from '../services/redaction.service.js';
import {
  SESSION_NAME_MODEL,
  SESSION_NAME_SYSTEM_PROMPT,
  buildSessionNameUserMessage,
} from '../services/sessionName.service.js';
import { CHAT_MODEL } from '../services/chatTherapy.service.js';
import { EMBEDDING_MODEL } from '../services/embeddings.service.js';
import { MODERATION_MODEL } from '../services/moderation.service.js';

/** Date shown on the attachment. Bump when the prompts change and it is re-submitted. */
export const PREPARED = 'November 16, 2026 (supersedes the September 4, 2026 version)';

/** Repo-relative path of the committed attachment. */
export const ATTACHMENT_PATH = 'docs/irb-phase2-instruments/prompts.html';

/** Absolute URL of the committed attachment. */
export const ATTACHMENT_URL = new URL('../../../docs/irb-phase2-instruments/prompts.html', import.meta.url);

/** Browser source that authors the GPT-Live opening line (checked, not imported). */
const CLIENT_APP_URL = new URL('../../client/main/components/App.tsx', import.meta.url);

/**
 * The crisis contact migration 090 writes to system_config.crisis_contact,
 * used to show what the {{crisis_text}} and crisis-phrase templates produce.
 */
const MIGRATION_090_CRISIS_CONTACT = {
  enabled: true,
  hotline: '988 Suicide & Crisis Lifeline',
  phone: '988',
  text: 'HOME to 741741',
};

const PLACEHOLDER_CRISIS_CONTACT: CrisisContactLike = {
  enabled: true,
  hotline: '<hotline name>',
  phone: '<phone>',
  text: '<text line>',
};

type Item =
  | { kind: 'title' | 'h1' | 'h2' | 'h3' | 'p' | 'note' | 'pre'; text: string }
  | { kind: 'meta'; lines: Array<[string, string]> }
  | { kind: 'table'; rows: string[][] };

/** A runtime value shown as an <angle-bracket placeholder> where the code expects a non-string. */
function ph<T>(label: unknown): T {
  return label as unknown as T;
}

/** A Date whose ISO rendering is the placeholder `<date>`. */
const PH_DATE = { toISOString: () => '<date>' } as unknown as Date;

/** Replace exactly one occurrence, or throw: a silent miss would mean the code changed shape. */
function replaceOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first === -1 || text.indexOf(from, first + from.length) !== -1) {
    throw new Error(`irb prompts attachment: expected exactly one ${JSON.stringify(from)}`);
  }
  return text.replace(from, to);
}

/** Drop the leading blank lines appenders carry (they are separators, not content). */
function block(text: string): string {
  return text.replace(/^\n+/, '');
}

/** Tool names that gate a line of buildToolGuidanceBlock, read from its own source. */
function toolGuidanceToolNames(): string[] {
  const names = [...buildToolGuidanceBlock.toString().matchAll(/has\(\s*["'`]([a-z_]+)["'`]\s*\)/g)].map((m) => m[1]);
  const unique = [...new Set(names)];
  if (unique.length < 10) throw new Error(`irb prompts attachment: found only ${unique.length} tool-guidance tools`);
  return unique;
}

/**
 * Under GPT-Live the opening instruction and the recovery speak-first nudge are
 * sent by the participant's browser (App.tsx), not by the server. The opening
 * shares its wording with the server-built Grok opening, so the client source
 * is checked for every fixed fragment of it; the nudge is read from the client
 * source. Either way a client-side edit fails the check instead of drifting.
 */
function readClientApp(): string {
  return readFileSync(CLIENT_APP_URL, 'utf8');
}

function verifyClientOpening(opening: string): void {
  const prefix = "Say this phrase exactly: '";
  const parts = opening.slice(prefix.length).split(buildGrokCrisisPhrase(PLACEHOLDER_CRISIS_CONTACT));
  if (!opening.startsWith(prefix) || parts.length !== 2) {
    throw new Error('irb prompts attachment: opening line shape changed');
  }
  const [before, after] = parts;
  const quote = after.lastIndexOf("'");
  const [voiceNote, thanks] = after.slice(1, quote).split(' Thanks again');
  const fragments = [
    "Say this phrase exactly: '${basePrompt}'",
    before,
    voiceNote,
    ' Thanks again' + thanks,
    '`${initialPrompt}' + after.slice(quote + 1) + '`',
  ];
  const client = readClientApp();
  for (const fragment of fragments) {
    if (!fragment || thanks === undefined || !client.includes(fragment)) {
      throw new Error(`irb prompts attachment: App.tsx no longer contains ${JSON.stringify(fragment)}`);
    }
  }
}

function clientRecoveryNudge(): string {
  const match = readClientApp().match(/sendInvisiblePrompt\(\s*'(The voice connection just dropped[^'\\]*)'/);
  if (!match) throw new Error('irb prompts attachment: recovery speak-first nudge not found in App.tsx');
  return match[1];
}

function buildItems(): Item[] {
  const items: Item[] = [];
  const add = (kind: 'title' | 'h1' | 'h2' | 'h3' | 'p' | 'note' | 'pre', text: string) => items.push({ kind, text });

  add('title', 'AI Support Agent — Model System Prompts (Verbatim)');
  items.push({
    kind: 'meta',
    lines: [
      ['Study', 'Human + AI Therapy: Better For Everyone (Phase 2: Longitudinal Use)'],
      ['Prepared', PREPARED],
      [
        'Sources',
        'Generated from the application codebase by src/server/irb/promptsAttachment.ts — ' +
          'src/server/utils/sessionHelpers.ts, src/server/utils/promptContext.ts, src/server/utils/phaseGuidance.ts, ' +
          'src/server/utils/liveSessionConfig.ts, src/server/utils/grokVoiceConfig.ts, ' +
          'src/server/utils/grokRefusalGuard.ts, src/server/utils/openingLine.ts, ' +
          'src/server/utils/sessionAutoTerminate.ts, src/server/services/crisisIntervention.service.ts, ' +
          'src/server/services/crisisDetection.service.ts, src/server/services/minorSafeguard.service.ts, ' +
          'src/server/services/redaction.service.ts, src/server/services/sessionName.service.ts.',
      ],
    ],
  });

  add(
    'p',
    'This document reproduces, verbatim, the instruction text the platform sends to its AI models during a ' +
      'participant session, and the auxiliary safety and data-processing prompts that run on participant ' +
      'conversations. Part A covers the per-session instruction set assembled when a participant session starts. ' +
      'Part B covers system-side guidance the platform can inject into a live session (never visible to the ' +
      'participant). Part C covers auxiliary prompts used by backend safety and data-processing pipelines. Part D ' +
      'lists the models in use. Part E lists what this document does not reproduce. For dynamic blocks that are ' +
      'filled with per-participant data at runtime, the fixed template text is reproduced verbatim and runtime ' +
      'values are marked with <angle-bracket placeholders>.',
  );
  add(
    'p',
    'Provenance: every prompt block below is generated directly from the application source code, so it is the ' +
      'default built into the code. Administrators can override the base prompts (separately for voice and ' +
      'typed-chat sessions), the therapeutic-approach appendices, and the language additions through an audited ' +
      'admin interface that stores them in the system configuration database; stored overrides are not visible to ' +
      'the generator. The research team keeps the deployed configuration in sync with the IRB-approved text below.',
  );

  // -------------------------------------------------------------------------
  add('h1', 'Part A. Per-session instruction set');

  add('h2', 'A.1 How the instruction set is assembled');
  add(
    'p',
    'When a session starts, the platform assembles one clinical prompt as the concatenation, in order, of: ' +
      '(1) the base system prompt (A.2); ' +
      '(2) one therapeutic-approach appendix, only if a modality research condition is active (A.3); ' +
      '(3) exactly one exercise-offering appendix — proactive or reactive — assigned per session as a research ' +
      'condition (A.4); ' +
      '(4) a language addition, only if one is configured for the session language (A.5); ' +
      '(5) for voice sessions only, a tool-usage guidance block (A.6); ' +
      '(6) for logged-in returning participants who opted in to session memory, a returning-participant context ' +
      'block (A.7); and ' +
      '(7) a pre-session check-in block, only if the participant filled in the optional check-in form (A.8).',
  );
  add(
    'p',
    'Typed-chat sessions send this clinical prompt (without item 5) as the system message to the chat model. Voice ' +
      'sessions run on one of two voice backends, selected by the study configuration: ' +
      'GPT-Live, where a voice model speaks with the participant using short conversation-layer instructions (A.9) ' +
      'and hands substantive therapeutic work to a separate reasoning model that receives the clinical prompt ' +
      'inside a voice wrapper (A.10); or Grok Voice, a single speech-to-speech model that receives a short voice ' +
      'header (A.11) followed by the clinical prompt. Both voice backends receive the same clinical prompt, so they ' +
      'are clinically identical study conditions. Sessions open with the fixed opening line in A.12. A.13 covers ' +
      "recovery after the voice vendor's content filter ends a session.",
  );

  add('h2', 'A.2 Base system prompt (verbatim)');
  add(
    'p',
    'The {{crisis_text}} placeholder is interpolated at runtime from the configured crisis contacts as ' +
      `"${buildCrisisText({ enabled: true, hotline: '<hotline name>', phone: '<phone>', text: '<text line>' })}". ` +
      'With the crisis contacts seeded by the study configuration (database migration 090) it reads ' +
      `"${buildCrisisText(MIGRATION_090_CRISIS_CONTACT)}". If the crisis-contact configuration is disabled or ` +
      `missing it falls back to "${buildCrisisText({ hotline: '', phone: '', enabled: false })}".`,
  );
  add('pre', DEFAULT_SYSTEM_PROMPT);

  add('h2', 'A.3 Therapeutic-approach appendices (applied only when a modality research condition is active)');
  add(
    'p',
    'At most one of the following four appendices is added, per the active modality condition (the default is ' +
      'none). Each appendix also defines session-pacing guidance lines that the platform delivers to the voice ' +
      "model at fractional points through the session's maximum duration; these steer conversation structure only " +
      'and introduce no new capabilities. Lines at or after 80% of the session carry the number of minutes ' +
      'remaining (<N>). Both the appendix and its pacing lines are reproduced verbatim below.',
  );
  const pacing = (phases: Array<{ at: number; text: string }>, labels?: string[]) =>
    phases.map((p, i) => `[at ${Math.round(p.at * 100)}%${labels?.[i] ? ` — ${labels[i]}` : ''}] ${p.text}`).join('\n');
  for (const preset of Object.values(DEFAULT_MODALITY_PRESETS)) {
    add('h3', preset.label);
    add('pre', block(preset.addition));
    add('note', 'Session-pacing guidance (delivered at the listed fraction of session time):');
    const phases = preset.phases ?? [];
    add(
      'pre',
      pacing(
        buildPhaseTexts(phases, () => '<N>'),
        phases.map((p) => p.label),
      ),
    );
  }
  add('h3', 'No modality condition active (default pacing)');
  add('p', 'When no modality condition is active, voice sessions receive these two pacing lines instead:');
  add('pre', pacing(buildPhaseTexts(undefined, () => '<N>')));

  add('h2', 'A.4 Exercise-offering appendices (per-session research condition, exactly one of two)');
  add('h3', 'Proactive condition');
  add('pre', block(PROACTIVE_OFFERING_ADDITION));
  add('h3', 'Reactive condition');
  add('pre', block(REACTIVE_ONLY_ADDITION));

  add('h2', 'A.5 Language addition');
  add(
    'p',
    'For each configured session language, the stored language configuration can append a short instruction (for ' +
      'example, to conduct the conversation in that language). The code ships no language additions; any addition ' +
      'comes from the stored configuration. The voice backends additionally name the session language in their own instructions ' +
      '(A.9, A.11, A.13).',
  );

  add('h2', 'A.6 Tool-usage guidance block (voice sessions only)');
  add(
    'p',
    'Voice sessions expose function tools (on-screen exercises, mood logging, session memory, safety-plan ' +
      'retrieval, and similar). This block teaches the model when to actually call them. The header is included ' +
      'whenever at least one listed tool is enabled; each bulleted line is included only when the corresponding ' +
      'tool is enabled for the session. Typed-chat sessions do not receive this block.',
  );
  const toolNames = toolGuidanceToolNames();
  const toolBlock = block(buildToolGuidanceBlock(toolNames));
  add('pre', toolBlock);
  const gating = toolBlock
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => toolNames.filter((name) => buildToolGuidanceBlock([name]).includes(line)).join(' or '));
  add('note', 'Gating tools, in order of the lines above: ' + gating.join('; ') + '.');

  add('h2', 'A.7 Returning-participant context block (opt-in session memory)');
  add(
    'p',
    'Included only for logged-in participants who have enabled session memory and have prior context. The fixed ' +
      'template text below is verbatim; runtime values are marked with <placeholders>. Each labeled sub-section ' +
      '(recent conversations, remembered facts, case profile, since-last-session signals, screener cadence, ' +
      'between-session practice, care-team guidance, prior risk history) appears only when the corresponding data ' +
      'exists, except the screener cadence, which is always included. In the since-last-session signals, the word ' +
      'after the previous score is "up", "down" or "unchanged". The prior-risk-history sub-section is included only ' +
      'when a therapist has explicitly enabled sharing it for that participant.',
  );
  const memory = assembleMemoryBlock({
    endedCount: 0,
    summaries: [
      {
        summary: {
          headline: '<headline>',
          topics: ['<topics>'],
          mood_trajectory: '<mood trajectory>',
          techniques_helped: ['<techniques>'],
          follow_up: '<follow-up>',
        },
        ended_at: PH_DATE,
        created_at: PH_DATE,
      },
    ],
    facts: ['<fact the participant asked the agent to remember>'],
    caseProfile: {
      presenting_concerns: ['<list>'],
      recurring_themes: ['<list>'],
      stressors: ['<list>'],
      support_system: ['<list>'],
      coping_repertoire: [{ technique: '<technique>', helpfulness: ph('<helpfulness>') }],
      values: ['<list>'],
      screener_trend: '<text>',
    },
    scaleHistory: [
      { scale: '<scale>', score: ph('<score>'), created_at: PH_DATE, session_id: '' },
      { scale: '<scale>', score: ph('<previous score>'), created_at: PH_DATE, session_id: '' },
    ],
    moodTrajectory: [
      { date: PH_DATE, source: 'checkin', mood: ph('<mood>') },
      { date: PH_DATE, source: 'log_mood', mood: ph('<mood>') },
    ],
    safetyPlan: { plan: { warning_signs: ['<list>'] }, created_at: PH_DATE },
    thoughtRecord: { record: { balanced_thought: '<text>' }, created_at: PH_DATE },
    clinicianNote: { notes: "<note left by the participant's therapist>" },
    riskFlags: [
      { session_id: '', severity: '<severity>', flagged_at: PH_DATE, unflagged_at: PH_DATE, unflagged_by: null },
      { session_id: '', severity: '<severity>', flagged_at: PH_DATE, unflagged_at: null, unflagged_by: null },
    ],
    openAssignments: [ph({ title: '<title>', assigned_at: PH_DATE })],
    completedSinceLast: [ph({ title: '<title>', assigned_at: PH_DATE })],
  });
  add('pre', block(replaceOnce(memory, 'conversation #1 —', 'conversation #<N> —')));
  add(
    'note',
    'The screener-cadence lines above show the "never administered" form. For a screener administered before, ' +
      'the line instead reads as one of the following (day counts are examples):',
  );
  const now = new Date('2026-01-15T18:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const cadence = buildScreenerCadenceBlock(
    [
      { scale: 'phq2', score: 0, created_at: daysAgo(3), session_id: '' },
      { scale: 'gad2', score: 0, created_at: daysAgo(SCALE_MIN_INTERVAL_DAYS + 2), session_id: '' },
    ],
    now,
  );
  add(
    'pre',
    cadence
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .join('\n'),
  );

  add('h2', 'A.8 Pre-session check-in block');
  add(
    'p',
    "Included only when the participant fills in the optional pre-session check-in (mood 1-10, what's on their " +
      'mind, what they want from today). Lines appear only for the fields the participant provided.',
  );
  add('pre', block(buildCheckinBlock({ mood: ph('<mood>'), topic: '<topic>', goal: '<goal>' })));

  add('h2', 'A.9 GPT-Live voice model: conversation-layer instructions');
  add(
    'p',
    'Under the GPT-Live backend, the voice model that speaks with the participant receives only these ' +
      'instructions; it holds no clinical content of its own. The language line names the session language. Under ' +
      '"Backend tools", the first line is always present and each further line appears only when the matching tool ' +
      '(find_worksheet, a scale-administration tool, display_session_recap, end_session) is enabled.',
  );
  add(
    'pre',
    buildLiveInstructions({
      languageName: '<language name>',
      toolNames: ['find_worksheet', 'administer_scale', 'display_session_recap', 'end_session'],
    }),
  );

  add('h2', 'A.10 GPT-Live reasoning backend: clinical prompt wrapper');
  add(
    'p',
    'The reasoning model that the voice model delegates to receives the clinical prompt assembled in A.1, wrapped ' +
      'as follows, together with the function tools enabled for the session.',
  );
  add('pre', buildLiveBackendInstructions('<clinical prompt assembled as described in A.1>'));

  add('h2', 'A.11 Grok Voice: voice header');
  add(
    'p',
    'Under the Grok Voice backend, the single voice model receives this header, then a blank line, then the ' +
      'clinical prompt assembled in A.1. The language line names the session language.',
  );
  add('pre', buildGrokVoiceHeader('<language name>').replace(/\n$/, ''));

  add('h2', 'A.12 Opening line');
  add(
    'p',
    'Every session opens with a fixed AI-disclosure greeting. The crisis phrase is filled from the configured ' +
      `crisis contacts; with the contacts seeded by migration 090 it reads "${buildGrokCrisisPhrase(
        MIGRATION_090_CRISIS_CONTACT,
      )}", and when the configuration is disabled it reads "${buildGrokCrisisPhrase({ enabled: false })}". For ` +
      'sessions in a language other than English, the voice instruction reads "Say this phrase exactly in ' +
      '<language name>:" instead.',
  );
  const voiceOpening = buildGrokOpeningPrompt('en', PLACEHOLDER_CRISIS_CONTACT);
  verifyClientOpening(voiceOpening);
  add('h3', 'Voice sessions — instruction to the voice model');
  add(
    'p',
    "Identical on both voice backends: under GPT-Live the participant's browser sends it, under Grok Voice the " +
      'server injects it.',
  );
  add('pre', voiceOpening);
  add('h3', 'Typed-chat sessions — fixed first message shown to the participant');
  add('p', 'Authored by the server and stored as the first assistant message; the model does not generate it.');
  add('pre', buildChatOpeningLine(PLACEHOLDER_CRISIS_CONTACT));
  add('note', 'Immediately after it, the following guidance is attached for the chat model, verbatim:');
  add('pre', CHAT_OPENING_FRAMING_GUIDANCE);

  add('h2', "A.13 Recovery after the vendor's content filter ends a voice session");
  add(
    'p',
    "The voice vendor's content filter can terminate a GPT-Live session outright, most often mid-way through a " +
      'response to a disclosure of suicidal thoughts. The participant is then reconnected straight away, first by ' +
      'voice and, if voice recovery fails, in typed chat.',
  );
  add('h3', 'Voice recovery — instructions to the voice model');
  add(
    'p',
    'These instructions replace A.9 for the replacement session; no reasoning backend, tools, or prior ' +
      'conversation are attached. <crisis line> is the configured crisis phone number followed by "or text" and the ' +
      'configured text line (988 when none is configured).',
  );
  add('pre', buildLiveRecoveryInstructions({ languageName: '<language name>', crisisLine: '<crisis line>' }));
  add('note', "As the session starts, the participant's browser sends this instruction so the model speaks first:");
  add('pre', clientRecoveryNudge());
  add('h3', 'Typed-chat continuation — guidance attached for the chat model');
  add(
    'p',
    'The chat session receives the normal clinical prompt (A.1) without the opening line, plus this guidance. ' +
      'The transcript is the last turns of the voice conversation (up to 20, at most 6,000 characters), one per ' +
      'line, prefixed "Participant:" or "You:".',
  );
  add('pre', buildVoiceContinuationGuidance('<transcript of the voice conversation>'));

  // -------------------------------------------------------------------------
  add('h1', 'Part B. System-side guidance injected during a live session');
  add(
    'p',
    'During a session, the platform can inject additional system-role guidance to the model. These messages are ' +
      'never shown to the participant; the clinical ones begin with an instruction telling the model never to ' +
      'mention or acknowledge them. In typed chat, guidance is attached to the next model call. The trigger ' +
      'conditions are stated with each text.',
  );

  add('h2', 'B.1 Risk-adaptive de-escalation steering');
  add(
    'p',
    `Trigger: the crisis-detection pipeline (Part C.1) scores a participant message at ${STEER_MIN_SCORE}/100 or ` +
      `higher. Injected at most once per ${STEER_COOLDOWN_MS / 60000} minutes per session, shared across the voice ` +
      'and chat channels (a high-severity score skips this wait). The voice texts are also injected when a member of ' +
      'the research team manually flags a voice session. <risk score> is the numeric score.',
  );
  add('h3', 'Voice sessions — severity below high');
  add('pre', steeringGuidance(ph('<risk score>'), 'medium'));
  add('h3', 'Voice sessions — high severity');
  add('pre', steeringGuidance(ph('<risk score>'), 'high'));
  add('h3', 'Typed-chat sessions');
  add('pre', buildChatSteeringGuidance(ph('<risk score>'), 'medium'));

  add('h2', 'B.2 Structured risk-assessment requirement');
  add(
    'p',
    `Trigger: a participant message scores ${DEFAULT_RISK_CHECK_MIN_SCORE}/100 or higher (the default threshold) ` +
      'and no structured risk-assessment step has been logged in the session yet. Repeated at most once per five ' +
      'minutes until the assessment begins. Used for both voice and typed-chat sessions.',
  );
  add('pre', RISK_CHECK_REQUIRED_GUIDANCE);

  add('h2', 'B.3 High-severity safety protocol');
  add(
    'p',
    'Trigger: the crisis-detection pipeline, or a manual flag by a member of the research team, marks a session ' +
      "at high severity. The research team's monitoring dashboard is alerted and the on-call researcher is paged at " +
      'the same time. The voice version leans on on-screen tools (a resource card and a guided safety-plan ' +
      'builder); the chat version delivers resources directly in the reply.',
  );
  add('h3', 'Voice sessions');
  add('pre', SAFETY_PROTOCOL_GUIDANCE);
  add('h3', 'Typed-chat sessions');
  add('pre', CHAT_SAFETY_PROTOCOL_GUIDANCE);

  add('h2', 'B.4 Crisis wind-down (human-initiated graceful end)');
  add(
    'p',
    'Trigger: a member of the research team monitoring a crisis session decides it should end gracefully. The ' +
      'guidance below is injected to the voice model, which surfaces crisis resources and closes the session ' +
      `warmly; if the session has not ended within a ${WIND_DOWN_GRACE_MS / 1000}-second grace window the server ` +
      'ends it directly.',
  );
  add('pre', CRISIS_WIND_DOWN_GUIDANCE);

  add('h2', 'B.5 Minor-eligibility ending');
  add(
    'p',
    `Trigger: a two-stage safeguard (pattern screen plus the ${CONFIRM_MODEL} confirmation in Part C.2) confirms ` +
      'the participant has disclosed being under 18. The session is then ended. In voice sessions the model is ' +
      'instructed to deliver the goodbye itself; in typed chat the platform sends the participant a fixed, ' +
      'server-authored goodbye message instead.',
  );
  add('h3', 'Voice sessions — guidance injected to the model');
  add('pre', REALTIME_MINOR_GUIDANCE);
  add('h3', 'Typed-chat sessions — fixed message shown to the participant');
  add('pre', MINOR_ELIGIBILITY_MESSAGE);

  add('h2', 'B.6 Session time and wrap-up (voice sessions)');
  add(
    'p',
    'When a maximum session duration is configured, the voice model is told the time at fixed points and asked to ' +
      'close gracefully at the limit; if the session has not ended shortly after, the server ends it directly. ' +
      `Time notices are sent ${TIME_NOTICE_MINUTES.join(' and ')} minutes before the limit (when the session is ` +
      'long enough), the wrap-up nudge one minute before, and the time-limit instruction at the limit.',
  );
  add('h3', 'Time notices');
  add('pre', TIME_NOTICE_MINUTES.map((m) => timeNotice(ph('<minutes used>'), m)).join('\n'));
  add('h3', 'Wrap-up nudge (one minute before the limit)');
  add('pre', WRAP_UP_NUDGE);
  add('h3', 'Time limit reached');
  add('pre', TIME_LIMIT_STEER);
  add(
    'p',
    "Crisis sessions: when a session is flagged at high severity, the platform's own duration limit is lifted to " +
      `the voice vendor's maximum connection time (${DEFAULT_VENDOR_CEILING_MINUTES} minutes by default) so a ` +
      'participant in crisis is not cut off early. If a wrap-up instruction had already been sent, the first text ' +
      `below cancels it. Time notices are then sent ${CRISIS_NOTICE_MINUTES.join(', ')} minutes before that ` +
      'maximum. One minute before it, GPT-Live sessions receive the connection-reset notice (the participant is ' +
      'reconnected automatically); Grok Voice sessions, which have no vendor maximum, receive the closing ' +
      'instruction instead.',
  );
  add('h3', 'Crisis: cancel an earlier wrap-up');
  add('pre', CRISIS_DISREGARD_WRAP_UP);
  add('h3', 'Crisis: time notices');
  add('pre', CRISIS_NOTICE_MINUTES.map((m) => crisisTimeNotice(m)).join('\n'));
  add('h3', 'Crisis: connection reset (GPT-Live)');
  add('pre', CRISIS_CEILING_LIVE);
  add('h3', 'Crisis: closing at the maximum (Grok Voice)');
  add('pre', CRISIS_CEILING_WRAP_UP);

  add('h2', 'B.7 Repeated-refusal recovery (Grok Voice)');
  add(
    'p',
    `Trigger: the Grok Voice model gives ${GROK_DEFAULT_REFUSAL_GUARD.steerAfter} near-identical refusal replies ` +
      'in a row (default setting). The guidance below is injected to the model. If the refusals continue to ' +
      `${GROK_DEFAULT_REFUSAL_GUARD.recoverAfter} in a row, the server shows the participant the fixed message ` +
      'that follows, filled with the crisis phrase described in A.12.',
  );
  add('h3', 'Guidance injected to the model');
  add('pre', GROK_REFUSAL_STEER);
  add('h3', 'Fixed message shown to the participant');
  add('pre', buildGrokRefusalRecoveryLine(buildGrokCrisisPhrase(PLACEHOLDER_CRISIS_CONTACT)));

  // -------------------------------------------------------------------------
  add('h1', 'Part C. Auxiliary backend prompts');

  add('h2', `C.1 Crisis risk-assessment prompt (${DEFAULT_RISK_MODEL})`);
  add(
    'p',
    'Runs when a keyword screen flags possible crisis language in a participant message, and additionally as a ' +
      `periodic sweep after every ${SWEEP_EVERY} participant messages without an assessment (so unusual phrasing is ` +
      'not missed). System prompt, verbatim:',
  );
  add('pre', RISK_ASSESSMENT_PROMPT);
  add('note', 'The accompanying user message is, verbatim:');
  add('pre', buildRiskAssessmentUserMessage('<recent transcript>', '<flagged participant message>'));

  add('h2', `C.2 Minor-eligibility confirmation prompt (${CONFIRM_MODEL})`);
  add(
    'p',
    'Runs when a pattern screen flags a possible disclosure that the participant is under 18 (see B.5). System ' +
      'prompt, verbatim:',
  );
  add('pre', MINOR_CONFIRM_PROMPT);
  add('note', 'The accompanying user message is, verbatim:');
  add('pre', buildMinorConfirmUserMessage('<recent transcript>', '<flagged participant message>'));

  add('h2', `C.3 Redaction prompt (${REDACTION_MODEL})`);
  add(
    'p',
    'Every stored conversation is passed through this redaction prompt in two passes (the second pass re-checks ' +
      'the output of the first) before researchers can view it. Verbatim (the prompt begins and ends with a line ' +
      'break):',
  );
  add('pre', REDACTION_PROMPT);
  if (!REDACTION_BATCH_INSTRUCTIONS.startsWith(REDACTION_PROMPT)) {
    throw new Error('irb prompts attachment: batch redaction prompt no longer extends the base prompt');
  }
  add('note', 'For whole-session batches, the following is appended to the prompt above, verbatim:');
  add('pre', block(REDACTION_BATCH_INSTRUCTIONS.slice(REDACTION_PROMPT.length)));

  add('h2', `C.4 Session-name prompt (${SESSION_NAME_MODEL})`);
  add(
    'p',
    'Generates a short descriptive title for each session from the redacted transcript only. System prompt, ' +
      'verbatim (the indentation of the continuation lines is part of the text the model receives):',
  );
  add('pre', SESSION_NAME_SYSTEM_PROMPT);
  add('note', 'The accompanying user message is, verbatim (the transcript is truncated to 3,000 characters):');
  add('pre', buildSessionNameUserMessage('<redacted transcript>'));

  // -------------------------------------------------------------------------
  add('h1', 'Part D. Models in use');
  add(
    'p',
    'Code defaults. The voice backend, the GPT-Live reasoning model and the crisis risk-assessment model are ' +
      'selected in the study configuration.',
  );
  const auxModels = [...new Set([DEFAULT_RISK_MODEL, CONFIRM_MODEL, SESSION_NAME_MODEL])].join(', ');
  items.push({
    kind: 'table',
    rows: [
      ['Function', 'Model'],
      ['Voice conversation, GPT-Live backend (speaks and transcribes)', sessionConfigDefault.session.model],
      ['Voice conversation, GPT-Live backend (reasoning; receives the clinical prompt)', LIVE_DEFAULT_BACKEND_MODEL],
      ['Voice conversation, Grok Voice backend (speaks and transcribes)', GROK_CURRENT_MODEL],
      ['Typed chat conversation', CHAT_MODEL],
      ['Transcript redaction (dual-pass)', REDACTION_MODEL],
      [
        'Auxiliary safety and analysis (crisis risk assessment, minor-eligibility confirmation, session naming)',
        auxModels,
      ],
      ['Content moderation screen (participant messages; an additional crisis signal)', MODERATION_MODEL],
      ['Text embeddings (memory retrieval)', EMBEDDING_MODEL],
    ],
  });

  // -------------------------------------------------------------------------
  add('h1', 'Part E. Not reproduced in this document');
  add(
    'p',
    'The following model inputs are outside the scope of this attachment: the descriptions of the function tools ' +
      'offered to the conversation models (tool registry); short factual event notices passed into a live ' +
      'session (for example, a completed questionnaire score, a completed worksheet, or a note that the participant ' +
      'ended the session), and free-text guidance typed by a member of the research team; post-session analysis ' +
      'prompts that summarize a completed session for session memory and clinician notes; research evaluation ' +
      'prompts that score transcripts for quality; and the researcher-facing admin assistant, which never ' +
      'interacts with participants.',
  );

  return items;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const STYLE =
  '<style>body{font-family:Georgia,serif;max-width:52em;margin:2em auto;padding:0 1em;color:#222;}' +
  'pre{background:#f6f6f4;border:1px solid #ddd;padding:0.8em;white-space:pre-wrap;' +
  'font-size:0.82em;line-height:1.45;}' +
  '.note{font-style:italic;font-size:0.9em;color:#444;}' +
  'table{border-collapse:collapse;}td,th{border:1px solid #999;padding:0.35em 0.7em;text-align:left;}' +
  '</style></head><body>';

/** Render the attachment. Deterministic: same code in, same bytes out. */
export function renderPromptsAttachment(): string {
  const parts = ['<html><head><meta charset="utf-8"><title>AI Model System Prompts</title>', STYLE];
  for (const item of buildItems()) {
    switch (item.kind) {
      case 'title':
        parts.push(`<h1>${esc(item.text)}</h1>`);
        break;
      case 'meta':
        parts.push('<p>' + item.lines.map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join('<br>\n') + '</p>');
        break;
      case 'h1':
        parts.push(`<h2>${esc(item.text)}</h2>`);
        break;
      case 'h2':
        parts.push(`<h3>${esc(item.text)}</h3>`);
        break;
      case 'h3':
        parts.push(`<h4>${esc(item.text)}</h4>`);
        break;
      case 'p':
        parts.push(`<p>${esc(item.text)}</p>`);
        break;
      case 'note':
        parts.push(`<p class="note">${esc(item.text)}</p>`);
        break;
      case 'pre':
        parts.push(`<pre>${esc(item.text)}</pre>`);
        break;
      case 'table':
        parts.push(
          '<table>' +
            item.rows
              .map((row, i) => {
                const tag = i === 0 ? 'th' : 'td';
                return '<tr>' + row.map((v) => `<${tag}>${esc(v)}</${tag}>`).join('') + '</tr>';
              })
              .join('\n') +
            '</table>',
        );
        break;
    }
  }
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}
