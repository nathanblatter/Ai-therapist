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
  LIVE_CONFIDENTIALITY_DELEGATE_LINE,
  buildLiveRecoveryInstructions,
  LIVE_CLIENT_EVENTS,
  resolveBackendReasoningEffort,
  delegationStallMs,
  hasStudyContact,
  LIVE_MAX_REASONING_EFFORT,
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

// ai-therapist-214. The shape asserted here is the documented one, verbatim:
// session.client.data_channel.allowed_client_events ("all" or array of client
// event type strings). An undocumented key 400s the whole voice handshake, so
// these tests pin the exact keys as well as the values.
describe('buildLiveSessionConfig data-channel permissions', () => {
  type ClientBlock = { data_channel: { allowed_client_events: string[] } };

  it('locks the browser data channel to an explicit allowlist with only the documented keys', () => {
    const session = build();
    const client = session.client as ClientBlock;

    expect(Object.keys(client)).toEqual(['data_channel']);
    expect(Object.keys(client.data_channel)).toEqual(['allowed_client_events']);
    expect(client.data_channel.allowed_client_events).toEqual(['session.close']);
  });

  it('never lets the browser steer, queue backend items, mute input or touch decisions', () => {
    for (const session of [build(), build({ recovery: { crisisLine: '988' } })]) {
      const allowed = (session.client as ClientBlock).data_channel.allowed_client_events;
      expect(allowed).not.toContain('session.instructions.append');
      expect(allowed).not.toContain('session.thinking.append');
      expect(allowed).not.toContain('session.commentary.append');
      expect(allowed).not.toContain('session.update');
      expect(allowed).not.toContain('response.item.create');
      expect(allowed).not.toContain('response.create');
      expect(allowed).not.toContain('session.input_audio.mute');
      expect(allowed).not.toContain('decision.item.create');
      expect(allowed).not.toContain('all');
    }
  });

  it('always leaves the browser able to hang up', () => {
    expect(LIVE_CLIENT_EVENTS).toContain('session.close');
  });

  it('locks a recovery session the same way', () => {
    const session = build({ recovery: { crisisLine: '988' } });
    expect((session.delegation as { type: string }).type).toBe('client');
    expect((session.client as ClientBlock).data_channel.allowed_client_events).toEqual(['session.close']);
  });

  it('does not restrict server events (omission keeps allow-all, which the captions depend on)', () => {
    expect((build().client as ClientBlock).data_channel).not.toHaveProperty('allowed_server_events');
  });

  it('omits the block entirely when the session has no sideband to steer from', () => {
    expect(build({ allowClientSteering: true })).not.toHaveProperty('client');
    expect(build({ allowClientSteering: true, recovery: { crisisLine: '988' } })).not.toHaveProperty('client');
  });

  it('hands each session its own array, so one request cannot widen the next', () => {
    const first = (build().client as ClientBlock).data_channel.allowed_client_events;
    first.push('session.instructions.append');
    expect((build().client as ClientBlock).data_channel.allowed_client_events).not.toContain(
      'session.instructions.append',
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

describe('backend reasoning effort (system_config.live_backend_reasoning_effort)', () => {
  type Delegation = { responses: Record<string, unknown> };

  it('sends no reasoning block when unset, so merge-time sessions are unchanged', () => {
    const responses = (build().delegation as Delegation).responses;
    expect(responses).not.toHaveProperty('reasoning');
  });

  it('forwards a configured effort to the delegated backend', () => {
    const responses = (build({ backendModel: 'gpt-6.1-terra', backendReasoningEffort: 'low' }).delegation as Delegation)
      .responses;
    expect(responses.reasoning).toEqual({ effort: 'low' });
    expect(responses.model).toBe('gpt-6.1-terra');
  });

  it('never adds reasoning to a recovery session (client delegation)', () => {
    const config = build({ backendReasoningEffort: 'low', recovery: { crisisLine: '988' } });
    expect(config.delegation).toEqual({ type: 'client' });
  });

  it('resolves only recognised efforts, case-insensitively', () => {
    expect(resolveBackendReasoningEffort(undefined, 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort('', 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort('fast', 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort({ effort: 'low' }, 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort(' Low ', 'gpt-6.1-terra')).toBe('low');
  });

  it("keeps 'none' where the model supports it and raises it to 'low' where it does not", () => {
    expect(resolveBackendReasoningEffort('none', 'gpt-6.1-terra')).toBe('none');
    expect(resolveBackendReasoningEffort('none', 'gpt-5.6-terra')).toBe('none');
    // GPT-6 guide, Limitations: Astra and 6.1 Sol reject `none`.
    expect(resolveBackendReasoningEffort('none', 'gpt-6.1-sol')).toBe('low');
    expect(resolveBackendReasoningEffort('none', 'gpt-6-astra')).toBe('low');
  });

  it('sends nothing to a backend the registry marks as non-reasoning, and says so', () => {
    // A reasoning block on gpt-4.1 is rejected by GPT-Live asynchronously
    // (responses_validation_failed), i.e. every delegation of the session
    // fails while session start looks healthy.
    logMock.warn.mockClear();
    expect(resolveBackendReasoningEffort('low', 'gpt-4.1')).toBeNull();
    expect(resolveBackendReasoningEffort('low', 'gpt-4o-mini')).toBeNull();
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('logs an unrecognised or mistyped effort instead of dropping it silently', () => {
    logMock.warn.mockClear();
    expect(resolveBackendReasoningEffort('lo', 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort(1, 'gpt-6.1-terra')).toBeNull();
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    logMock.warn.mockClear();
    expect(resolveBackendReasoningEffort(undefined, 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort(null, 'gpt-6.1-terra')).toBeNull();
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('clamps xhigh and max to high for voice, with a warning, and leaves high and below alone (ai-therapist-364)', () => {
    // 60 s of allowed backend silence at xhigh/max is the stall the
    // delegation watchdog exists to end.
    logMock.warn.mockClear();
    expect(LIVE_MAX_REASONING_EFFORT).toBe('high');
    expect(resolveBackendReasoningEffort('xhigh', 'gpt-6.1-terra')).toBe('high');
    expect(resolveBackendReasoningEffort(' MAX ', 'gpt-6.1-terra')).toBe('high');
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    expect(String(logMock.warn.mock.calls[0][1])).toMatch(/'xhigh' is above what a voice session allows; using 'high'/);
    logMock.warn.mockClear();
    for (const effort of ['none', 'low', 'medium', 'high'] as const) {
      expect(resolveBackendReasoningEffort(effort, 'gpt-6.1-terra')).toBe(effort);
    }
    expect(logMock.warn).not.toHaveBeenCalled();
    // So no voice session's quiet period is ever the 60 s one.
    expect(delegationStallMs(resolveBackendReasoningEffort('max', 'gpt-6.1-terra'))).toBe(30_000);
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

describe('delegation fallback context (ai-therapist-348)', () => {
  it('lengthens the quiet period with the reasoning effort; unset runs the model default', () => {
    expect(delegationStallMs('none')).toBe(12_000);
    expect(delegationStallMs('low')).toBe(12_000);
    expect(delegationStallMs('medium')).toBe(20_000);
    expect(delegationStallMs(null)).toBe(20_000);
    expect(delegationStallMs('high')).toBe(30_000);
    expect(delegationStallMs('xhigh')).toBe(60_000);
    expect(delegationStallMs('max')).toBe(60_000);
  });

  it('only a real study session has a research team and a consent form to point to', () => {
    expect(hasStudyContact({ mode: 'research' }, false)).toBe(true);
    expect(hasStudyContact(undefined, false)).toBe(true); // the row is absent on older databases
    expect(hasStudyContact({ mode: 'research' }, true)).toBe(false); // demo, sandbox, harness
    expect(hasStudyContact({ mode: 'clinical' }, false)).toBe(false); // therapist pilot
  });

  it('the recovery prompt puts safety first and points a factual question to the research team', () => {
    const study = buildLiveRecoveryInstructions({ languageName: null, crisisLine: '988' }).replace(/\s+/g, ' ');
    expect(study).toContain('never say you cannot answer: respond to them directly and warmly');
    expect(study).toContain("the research team can: the team's contact details are on their consent form");
    expect(build({ recovery: { crisisLine: '988' } }).instructions).toContain('research');
  });

  it('the recovery prompt names nobody outside a study session', () => {
    const neutral = buildLiveRecoveryInstructions({ languageName: null, crisisLine: '988', studyContact: false });
    expect(neutral).not.toMatch(/research team|consent form|the study/);
    expect(neutral.replace(/\s+/g, ' ')).toContain('Do not name a person, a team or a contact detail');
    expect(neutral.replace(/\s+/g, ' ')).toContain('never say you cannot answer');
    const viaConfig = build({ recovery: { crisisLine: '988', studyContact: false } }).instructions as string;
    expect(viaConfig).not.toMatch(/research team|consent form/);
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

describe('voice-layer confidentiality line (ai-therapist-314)', () => {
  it('hands confidentiality questions to the backend, in every ordinary session', () => {
    for (const session of [build(), build({ leadConversation: true }), build({ psychoeducationCue: true })]) {
      const instructions = session.instructions as string;
      expect(instructions).toContain(LIVE_CONFIDENTIALITY_DELEGATE_LINE);
      // It sits in the "Delegate to the backend when:" list, not the "do not" list.
      const delegate = instructions.indexOf('Delegate to the backend when:');
      const doNot = instructions.indexOf('Do not delegate to the backend when:');
      const line = instructions.indexOf(LIVE_CONFIDENTIALITY_DELEGATE_LINE);
      expect(line).toBeGreaterThan(delegate);
      expect(line).toBeLessThan(doNot);
    }
  });

  it('forbids the voice model from answering or promising, and states no study fact itself', () => {
    expect(LIVE_CONFIDENTIALITY_DELEGATE_LINE).toMatch(/who can see, hear or read what they say/);
    expect(LIVE_CONFIDENTIALITY_DELEGATE_LINE).toMatch(/promise to keep something between the two of you/);
    expect(LIVE_CONFIDENTIALITY_DELEGATE_LINE).toMatch(/Never answer that yourself or promise anything/);
    expect(LIVE_CONFIDENTIALITY_DELEGATE_LINE).not.toMatch(/confidential\b|study team can|researchers can/i);
  });
});
