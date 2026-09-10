// The transcription payload is model-aware: legacy models 400 on the new
// context fields, and the API rejects keywords containing <, >, CR, or LF —
// a bad admin override must never be able to break session minting.
import { describe, it, expect } from 'vitest';
import {
  buildTranscriptionConfig,
  sanitizeKeywords,
  DEFAULT_TRANSCRIPTION_KEYWORDS,
  DEFAULT_TRANSCRIPTION_PROMPT,
} from './transcriptionConfig.js';

describe('sanitizeKeywords', () => {
  it('strips the characters the Realtime API rejects', () => {
    expect(sanitizeKeywords(['<988>', 'Crisis\r\nText Line', ' CAPS '])).toEqual(['988', 'CrisisText Line', 'CAPS']);
  });

  it('dedupes, drops non-strings, and caps count and length', () => {
    const long = 'x'.repeat(200);
    const result = sanitizeKeywords(['a', 'a', 42, null, long, ...Array.from({ length: 60 }, (_, i) => `kw${i}`)]);
    expect(result[0]).toBe('a');
    expect(result.filter(k => k === 'a')).toHaveLength(1);
    expect(result.find(k => k.startsWith('xxx'))!.length).toBe(60);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('returns empty for non-arrays', () => {
    expect(sanitizeKeywords('CAPS')).toEqual([]);
    expect(sanitizeKeywords(undefined)).toEqual([]);
  });
});

describe('buildTranscriptionConfig', () => {
  it('sends model-only for legacy models (extra fields 400 the mint)', () => {
    expect(buildTranscriptionConfig('gpt-4o-mini-transcribe')).toEqual({ model: 'gpt-4o-mini-transcribe' });
    expect(buildTranscriptionConfig('whisper-1')).toEqual({ model: 'whisper-1' });
    expect(buildTranscriptionConfig('gpt-4o-mini-transcribe-2025-12-15')).toEqual({ model: 'gpt-4o-mini-transcribe-2025-12-15' });
  });

  it('adds default crisis-vocabulary context for gpt-transcribe models', () => {
    const config = buildTranscriptionConfig('gpt-transcribe');
    expect(config.model).toBe('gpt-transcribe');
    expect(config.prompt).toBe(DEFAULT_TRANSCRIPTION_PROMPT);
    expect(config.keywords).toEqual(DEFAULT_TRANSCRIPTION_KEYWORDS);
    expect(config.languages).toEqual(['en']);
  });

  it('covers dated snapshots and gpt-live-transcribe', () => {
    expect(buildTranscriptionConfig('gpt-live-transcribe').keywords).toBeDefined();
    expect(buildTranscriptionConfig('gpt-transcribe-2026-07-28').keywords).toBeDefined();
  });

  it('applies admin overrides with sanitization', () => {
    const config = buildTranscriptionConfig('gpt-transcribe', {
      prompt: '  custom context  ',
      keywords: ['<med>', 'Lexapro'],
      languages: ['en', 'es'],
    });
    expect(config.prompt).toBe('custom context');
    expect(config.keywords).toEqual(['med', 'Lexapro']);
    expect(config.languages).toEqual(['en', 'es']);
  });

  it('falls back to defaults on malformed overrides', () => {
    const config = buildTranscriptionConfig('gpt-transcribe', {
      prompt: 42, keywords: 'not-an-array', languages: [1, 2],
    });
    expect(config.prompt).toBe(DEFAULT_TRANSCRIPTION_PROMPT);
    expect(config.keywords).toEqual(DEFAULT_TRANSCRIPTION_KEYWORDS);
    expect(config.languages).toEqual(['en']);
  });
});
