import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('./logger.js', () => ({ createLogger: () => logMock }));

import {
  isLiveModel,
  resolveLiveVoice,
  liveVoicesForLanguage,
  buildLiveSessionConfig,
  toLiveDelegationTools,
  getLiveVoice,
  LIVE_DEFAULT_VOICE,
  LIVE_DEFAULT_BACKEND_MODEL,
  LIVE_VOICES,
  LIVE_UNDER_18_HOLD_LINE,
  buildLiveRecoveryInstructions,
} from './liveSessionConfig.js';
import type { ToolDefinition } from '../services/toolRegistry.service.js';

const CLINICAL_PROMPT = 'CLINICAL_PROMPT_SENTINEL: you are a supportive therapist.';

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'find_worksheet',
    description: 'Find a worksheet',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: [] },
  } as unknown as ToolDefinition,
];

function build(overrides: Partial<Parameters<typeof buildLiveSessionConfig>[0]> = {}) {
  return buildLiveSessionConfig({
    model: 'gpt-live-1',
    voice: 'marin',
    languageName: null,
    systemPrompt: CLINICAL_PROMPT,
    toolDefs: TOOL_DEFS,
    backendModel: LIVE_DEFAULT_BACKEND_MODEL,
    ...overrides,
  });
}

beforeEach(() => {
  logMock.warn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isLiveModel', () => {
  it('is true for the GPT-Live voice model', () => {
    expect(isLiveModel('gpt-live-1')).toBe(true);
  });

  it('is FALSE for gpt-live-transcribe (a transcription model, not full duplex)', () => {
    expect(isLiveModel('gpt-live-transcribe')).toBe(false);
    expect(isLiveModel('gpt-live-transcribe-latest')).toBe(false);
  });

  it('is FALSE for Realtime model ids (that is the rollback path)', () => {
    expect(isLiveModel('gpt-realtime')).toBe(false);
    expect(isLiveModel('gpt-realtime-2025-08-28')).toBe(false);
  });

  it('is false for null / undefined / empty', () => {
    expect(isLiveModel(null)).toBe(false);
    expect(isLiveModel(undefined)).toBe(false);
    expect(isLiveModel('')).toBe(false);
  });
});

describe('resolveLiveVoice', () => {
  it('preserves a known native voice', () => {
    expect(resolveLiveVoice('meridian')).toBe('meridian');
  });

  it('preserves a known legacy (carried-over Realtime) voice', () => {
    expect(resolveLiveVoice('cedar')).toBe('cedar');
  });

  it('falls back to marin for an unknown voice rather than 400-ing session creation', () => {
    expect(resolveLiveVoice('nonexistent-voice')).toBe(LIVE_DEFAULT_VOICE);
    expect(LIVE_DEFAULT_VOICE).toBe('marin');
  });

  it('falls back for null / undefined without warning', () => {
    expect(resolveLiveVoice(null)).toBe('marin');
    expect(resolveLiveVoice(undefined)).toBe('marin');
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

describe('getLiveVoice', () => {
  it('returns metadata for a known voice and null otherwise', () => {
    expect(getLiveVoice('bossa')).toMatchObject({ language: 'Portuguese', liveNative: true });
    expect(getLiveVoice('marin')).toMatchObject({ language: 'English', liveNative: false });
    expect(getLiveVoice('not-a-voice')).toBeNull();
    expect(getLiveVoice(null)).toBeNull();
  });
});

describe('liveVoicesForLanguage', () => {
  it("returns only the Portuguese voices for 'pt-BR'", () => {
    const voices = liveVoicesForLanguage('pt-BR');
    expect(voices.map((v) => v.value).sort()).toEqual(['bossa', 'tempo']);
    expect(voices.every((v) => v.language === 'Portuguese')).toBe(true);
  });

  it('returns only English voices for English and for an unknown language code', () => {
    for (const code of ['en-US', 'de-DE', null, undefined]) {
      const voices = liveVoicesForLanguage(code);
      expect(voices.every((v) => v.language === 'English')).toBe(true);
      expect(voices.map((v) => v.value)).not.toContain('bossa');
    }
  });

  it('never returns an empty picker', () => {
    expect(liveVoicesForLanguage('pt').length).toBeGreaterThan(0);
    expect(LIVE_VOICES.length).toBeGreaterThan(0);
  });
});

describe('buildLiveSessionConfig', () => {
  it('puts the clinical prompt in delegation.responses.instructions, NOT top-level instructions', () => {
    const session = build();

    const delegation = session.delegation as { responses: { instructions: string; model: string } };
    expect(delegation.responses.instructions).toContain(CLINICAL_PROMPT);
    expect(delegation.responses.model).toBe(LIVE_DEFAULT_BACKEND_MODEL);

    // The live model's own instructions cover speaking behaviour only.
    expect(session.instructions as string).not.toContain(CLINICAL_PROMPT);
    expect(session.instructions as string).toMatch(/Delegation policy/);
  });

  it('omits audio.format (WebRTC negotiates its own) and configures only the voice', () => {
    const session = build({ voice: 'vesper' });
    const audio = session.audio as Record<string, unknown>;

    expect(audio).toEqual({ output: { voice: 'vesper' } });
    expect(audio).not.toHaveProperty('format');
    expect(audio.output).not.toHaveProperty('format');
    expect(audio).not.toHaveProperty('input');
  });

  it('coerces an unknown voice through resolveLiveVoice', () => {
    const session = build({ voice: 'not-a-voice' });
    expect((session.audio as { output: { voice: string } }).output.voice).toBe('marin');
  });

  it('never stores participant audio on the OpenAI side', () => {
    expect(build().store).toBe(false);
  });

  it('configures sequential delegated tool calls with tool_choice auto', () => {
    const delegation = build().delegation as {
      type: string;
      responses: { tool_choice: string; parallel_tool_calls: boolean; tools: Array<Record<string, unknown>> };
    };
    expect(delegation.type).toBe('responses');
    expect(delegation.responses.tool_choice).toBe('auto');
    expect(delegation.responses.parallel_tool_calls).toBe(false);
    expect(delegation.responses.tools).toEqual([
      {
        type: 'function',
        name: 'find_worksheet',
        description: 'Find a worksheet',
        parameters: TOOL_DEFS[0].parameters,
        strict: false,
      },
    ]);
  });

  it('omits session.input when there is no history', () => {
    expect(build()).not.toHaveProperty('input');
    expect(build({ history: [] })).not.toHaveProperty('input');
  });

  it('seeds history oldest-first with the right content types', () => {
    const session = build({
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    });
    expect(session.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ]);
  });

  it('trims the OLDEST history turns when the char budget is exceeded', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `${i}:${'x'.repeat(1000)}`,
    }));
    const input = build({ history }).input as Array<{ content: Array<{ text: string }> }>;

    expect(input.length).toBeLessThan(history.length);
    // The most recent turn survives; the oldest is what got dropped.
    expect(input[input.length - 1].content[0].text.startsWith('39:')).toBe(true);
    expect(input[0].content[0].text.startsWith('0:')).toBe(false);
  });

  it('adds a language line to the live instructions when a language is set', () => {
    expect(build({ languageName: 'Brazilian Portuguese' }).instructions as string).toMatch(
      /Speak Brazilian Portuguese unless/,
    );
    expect(build({ languageName: null }).instructions as string).not.toMatch(
      /unless the participant asks you to switch/,
    );
  });
});

describe('buildLiveSessionConfig psychoeducation cue (ai-therapist-202)', () => {
  const withRag: ToolDefinition[] = [
    ...TOOL_DEFS,
    {
      name: 'retrieve_psychoeducation',
      description: 'Retrieve passages',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    } as unknown as ToolDefinition,
  ];

  it('voice-layer instructions are unchanged when the cue is off', () => {
    const off = build({ toolDefs: withRag }).instructions as string;
    expect(off).toBe(build({ toolDefs: withRag, psychoeducationCue: false }).instructions);
    expect(off).not.toMatch(/Psychoeducation/);
    expect(off).not.toMatch(/what a condition is/);
  });

  it('cue arm adds one capability line and one delegate line', () => {
    const on = build({ toolDefs: withRag, psychoeducationCue: true }).instructions as string;
    expect(on).toContain(
      '- Psychoeducation: look up vetted explanations of a condition, a feeling, or how a technique or therapy works.',
    );
    expect(on).toContain(
      '- The participant asks what a condition is, why they might feel a certain way, or how a technique or therapy works.\n- A correction changes work already in progress.',
    );
  });

  it('cue arm adds nothing when the tool is not enabled', () => {
    expect(build({ psychoeducationCue: true }).instructions).toBe(build().instructions);
  });
});

describe('buildLiveSessionConfig lead conversation (features.lead_conversation_enabled)', () => {
  const backendOf = (s: Record<string, unknown>) =>
    ((s.delegation as Record<string, unknown>).responses as Record<string, unknown>).instructions;

  it('flag off: voice layer and backend identical to omitting the option', () => {
    const off = build({ leadConversation: false });
    expect(off.instructions).toBe(build().instructions);
    expect(backendOf(off)).toBe(backendOf(build()));
    expect(off.instructions as string).not.toMatch(/Guide the conversation/);
    expect(off.instructions as string).not.toMatch(/stalled reply/);
  });

  it('flag on: adds one speaking line and one delegate line, nothing else', () => {
    const on = build({ leadConversation: true }).instructions as string;
    const off = build().instructions as string;
    expect(on).toContain(
      'acknowledge it plainly before anything else.\nGuide the conversation: after greetings, help the participant name what they want to focus on today, and keep it moving with one specific follow-up at a time rather than only acknowledging. If they are upset or raise anything about their safety, follow them instead.\n',
    );
    expect(on).toContain(
      '- The participant gives a short or stalled reply ("I don\'t know", "not much") and the conversation needs a next step.\n- A correction changes work already in progress.',
    );
    const removed = on
      .replace(/Guide the conversation:[^\n]*\n/, '')
      .replace(/- The participant gives a short or stalled reply[^\n]*\n/, '');
    expect(removed).toBe(off);
    // The suicide/self-harm instruction is untouched, and the under-18 hold
    // line (ai-therapist-296) is the last paragraph after it.
    expect(on).toContain('minimize it, and do not change the subject.');
    expect(on.endsWith(LIVE_UNDER_18_HOLD_LINE)).toBe(true);
  });

  it('recovery ignores the flag', () => {
    const recovery = { crisisLine: '988' };
    expect(build({ recovery, leadConversation: true }).instructions).toBe(build({ recovery }).instructions);
  });
});

describe('toLiveDelegationTools', () => {
  it('never forwards registry-only metadata that would 400 session creation', () => {
    const defs = [
      {
        name: 'end_session',
        description: 'End it',
        parameters: { type: 'object', properties: {} },
        channel: 'realtime',
        handler: () => undefined,
      } as unknown as ToolDefinition,
    ];

    const [tool] = toLiveDelegationTools(defs);
    expect(Object.keys(tool).sort()).toEqual(['description', 'name', 'parameters', 'strict', 'type']);
  });
});

describe('voice-layer under-18 hold line (ai-therapist-296)', () => {
  it('is part of every ordinary voice session, whatever the flags', () => {
    for (const session of [build(), build({ leadConversation: true }), build({ psychoeducationCue: true })]) {
      expect(session.instructions as string).toContain(LIVE_UNDER_18_HOLD_LINE);
    }
  });

  it('forbids affirming the disclosure or carrying on, and adds no handling of its own', () => {
    expect(LIVE_UNDER_18_HOLD_LINE).toMatch(/under 18/);
    expect(LIVE_UNDER_18_HOLD_LINE).toMatch(/do not tell them that is okay/);
    expect(LIVE_UNDER_18_HOLD_LINE).toMatch(/do not carry on with the conversation/);
    expect(LIVE_UNDER_18_HOLD_LINE).toMatch(/you will be told what to say next/);
    // The goodbye, the reason and the crisis lines stay server-authored
    // (minorSafeguard.service.ts): the voice model is given none of them.
    expect(LIVE_UNDER_18_HOLD_LINE).not.toMatch(/988|741741|goodbye|adults? only|end the session/i);
  });

  it('is not in the recovery prompt, which has one job', () => {
    expect(build({ recovery: { crisisLine: '988' } }).instructions as string).not.toContain(LIVE_UNDER_18_HOLD_LINE);
  });
});

describe('recovery session startup input (ai-therapist-293)', () => {
  const SPEAK_FIRST = 'Speak first, immediately. Say this: "I\'m back. You can call or text 988 at any time."';

  it('carries the speak-first instruction as one developer message (the documented greeting recipe)', () => {
    const session = build({ recovery: { crisisLine: '988', speakFirst: SPEAK_FIRST } });
    expect(session.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: SPEAK_FIRST }] },
    ]);
  });

  it('still carries NO conversation history, even when a caller passes some', () => {
    const session = build({
      recovery: { crisisLine: '988', speakFirst: SPEAK_FIRST },
      history: [
        { role: 'user', content: 'the disclosure that was cut' },
        { role: 'assistant', content: 'the reply that was cut' },
      ],
    });
    const input = session.input as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('developer');
    expect(JSON.stringify(input)).not.toContain('the disclosure that was cut');
  });

  it('has no startup input at all without a speak-first instruction', () => {
    expect(build({ recovery: { crisisLine: '988' } })).not.toHaveProperty('input');
    expect(build({ recovery: { crisisLine: '988', speakFirst: '   ' } })).not.toHaveProperty('input');
  });
});

describe('buildLiveRecoveryInstructions (ai-therapist-293)', () => {
  const prompt = buildLiveRecoveryInstructions({ languageName: null, crisisLine: '988 or text HOME to 741741' });

  it('does not tell the model the connection dropped (Q-SYS2: the study answers "no" to deception)', () => {
    expect(prompt).not.toMatch(/connection dropped/i);
    expect(prompt).toMatch(/the call was\s+cut off by an automated system on the voice service/);
    // True for the vendor ceiling too, where the participant was told beforehand.
    expect(prompt).not.toMatch(/without warning/);
    expect(prompt).toMatch(/Never call it a dropped connection or a technical problem/);
    expect(prompt).toMatch(/an automated system on the voice service ended the call/);
  });

  it('has the first reply say the crisis line aloud', () => {
    expect(prompt).toMatch(
      /In that same first reply, say the crisis line out loud: they can call or text 988 or text HOME to 741741 at any time/,
    );
  });

  it('changes nothing else: the rest of the prompt is as it was', () => {
    for (const kept of [
      'Your only job right now is to stay with them and help them reach real human help.',
      '- Short replies. One or two sentences, then stop and listen.',
      '- Do not ask them to repeat what they already told you. You remember that it was serious.',
      '- Encourage them to call or text 988 or text HOME to 741741 right now, and offer to stay with them while they do it.',
      '- Do not discuss methods, means, plans, or specifics of self-harm in any way.',
      '- Do not go silent. If you are unsure what to say, say that you are still here.',
      'Delegation policy: do not delegate. Answer directly and immediately.',
    ]) {
      expect(prompt).toContain(kept);
    }
  });
});
