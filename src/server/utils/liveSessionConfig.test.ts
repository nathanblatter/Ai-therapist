import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(console.warn).not.toHaveBeenCalled();
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
    expect(voices.map(v => v.value).sort()).toEqual(['bossa', 'tempo']);
    expect(voices.every(v => v.language === 'Portuguese')).toBe(true);
  });

  it('returns only English voices for English and for an unknown language code', () => {
    for (const code of ['en-US', 'de-DE', null, undefined]) {
      const voices = liveVoicesForLanguage(code);
      expect(voices.every(v => v.language === 'English')).toBe(true);
      expect(voices.map(v => v.value)).not.toContain('bossa');
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
    expect(delegation.responses.tools).toEqual([{
      type: 'function',
      name: 'find_worksheet',
      description: 'Find a worksheet',
      parameters: TOOL_DEFS[0].parameters,
      strict: false,
    }]);
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
    expect(build({ languageName: 'Brazilian Portuguese' }).instructions as string)
      .toMatch(/Speak Brazilian Portuguese unless/);
    expect(build({ languageName: null }).instructions as string).not.toMatch(/unless the participant asks you to switch/);
  });
});

describe('toLiveDelegationTools', () => {
  it('never forwards registry-only metadata that would 400 session creation', () => {
    const defs = [{
      name: 'end_session',
      description: 'End it',
      parameters: { type: 'object', properties: {} },
      channel: 'realtime',
      handler: () => undefined,
    } as unknown as ToolDefinition];

    const [tool] = toLiveDelegationTools(defs);
    expect(Object.keys(tool).sort()).toEqual(['description', 'name', 'parameters', 'strict', 'type']);
  });
});
