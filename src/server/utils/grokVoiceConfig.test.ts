import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  isGrokVoiceModel,
  resolveGrokVoice,
  getGrokVoice,
  buildGrokSessionConfig,
  buildGrokOpeningPrompt,
  grokRealtimeUrl,
  GROK_VOICES,
  GROK_DEFAULT_VOICE,
} from './grokVoiceConfig.js';
import type { ToolDefinition } from '../services/toolRegistry.service.js';

const CLINICAL_PROMPT = 'CLINICAL_PROMPT_SENTINEL: you are a supportive therapist.';

const TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'find_worksheet',
    description: 'Find a worksheet',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: [] },
    channel: 'both',
  } as unknown as ToolDefinition,
];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('isGrokVoiceModel — the admin switch', () => {
  it('matches the alias and dated releases', () => {
    expect(isGrokVoiceModel('grok-voice-latest')).toBe(true);
    expect(isGrokVoiceModel('grok-voice-think-fast-2.0')).toBe(true);
  });

  it('rejects GPT-Live, Realtime, and the xAI transcription family', () => {
    expect(isGrokVoiceModel('gpt-live-1')).toBe(false);
    expect(isGrokVoiceModel('gpt-realtime-2.1')).toBe(false);
    expect(isGrokVoiceModel('grok-voice-transcribe-2.0')).toBe(false);
    expect(isGrokVoiceModel(null)).toBe(false);
    expect(isGrokVoiceModel('')).toBe(false);
  });
});

describe('voice registry', () => {
  it('lists eve first as the default and has no duplicate ids', () => {
    expect(GROK_VOICES[0].value).toBe(GROK_DEFAULT_VOICE);
    expect(new Set(GROK_VOICES.map(v => v.value)).size).toBe(GROK_VOICES.length);
  });

  it('resolves case-insensitively and falls back for GPT-Live voices', () => {
    expect(resolveGrokVoice('Ara')).toBe('ara');
    expect(getGrokVoice('EVE')?.value).toBe('eve');
    // A participant enrolled on GPT-Live keeps a saved 'marin'; forwarding it
    // would fail the session.update, so it falls back with a warning.
    expect(resolveGrokVoice('marin')).toBe(GROK_DEFAULT_VOICE);
    expect(console.warn).toHaveBeenCalled();
    expect(resolveGrokVoice(undefined)).toBe(GROK_DEFAULT_VOICE);
  });
});

describe('buildGrokSessionConfig', () => {
  const config = buildGrokSessionConfig({
    model: 'grok-voice-latest',
    voice: 'ara',
    language: 'es-MX',
    languageName: 'Spanish',
    systemPrompt: CLINICAL_PROMPT,
    toolDefs: TOOL_DEFS,
  });

  it('puts the full clinical prompt behind a short voice header', () => {
    const instructions = config.instructions as string;
    expect(instructions).toContain(CLINICAL_PROMPT);
    expect(instructions).toContain('Speak Spanish');
    expect(instructions.indexOf('## Voice conversation')).toBeLessThan(instructions.indexOf(CLINICAL_PROMPT));
  });

  it('uses server VAD and 24 kHz PCM on both legs', () => {
    expect(config.turn_detection).toEqual({ type: 'server_vad' });
    const audio = config.audio as { input: { format: unknown; transcription: unknown }; output: { format: unknown } };
    expect(audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(audio.input.transcription).toEqual({ language_hint: 'es-MX' });
  });

  it('projects tools to the flat Realtime shape with no registry metadata', () => {
    const tools = config.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      name: 'find_worksheet',
      description: 'Find a worksheet',
      parameters: TOOL_DEFS[0].parameters,
    });
    expect('channel' in tools[0]).toBe(false);
    expect(config.tool_choice).toBe('auto');
  });

  it('coerces an unknown voice to the default', () => {
    expect(config.voice).toBe('ara');
    expect(buildGrokSessionConfig({
      model: 'grok-voice-latest', voice: 'cedar', language: null, languageName: null,
      systemPrompt: CLINICAL_PROMPT, toolDefs: [],
    }).voice).toBe(GROK_DEFAULT_VOICE);
  });
});

describe('buildGrokOpeningPrompt', () => {
  it('names the configured crisis line and the mic note', () => {
    const text = buildGrokOpeningPrompt('en', { hotline: '988 Lifeline', phone: '988', text: 'HOME to 741741', enabled: true });
    expect(text).toMatch(/^Say this phrase exactly: '/);
    expect(text).toContain('call the 988 Lifeline crisis line at 988 or text HOME to 741741');
    expect(text).toContain('microphone is off by default');
    expect(text).toContain('before the participant speaks');
  });

  it('falls back to 988/911 when crisis contact is disabled and names the language', () => {
    const text = buildGrokOpeningPrompt('pt-BR', { enabled: false });
    expect(text).toContain('Brazilian Portuguese');
    expect(text).toContain('call or text 988');
  });
});

describe('grokRealtimeUrl', () => {
  it('encodes the model as a query parameter', () => {
    expect(grokRealtimeUrl('grok-voice-latest')).toBe('wss://api.x.ai/v1/realtime?model=grok-voice-latest');
  });
});
