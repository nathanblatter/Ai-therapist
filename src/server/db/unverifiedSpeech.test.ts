// ai-therapist-412: the mark on a participant voice message nobody spoke, and
// the guards around who may write it and what of it the redacted views show.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }));
vi.mock('../services/redaction.service.js', () => ({ default: vi.fn() }));

import {
  UNVERIFIED_SPEECH_KEY,
  notUnverifiedSpeechSql,
  safeMicAudio,
  stripServerOnlySpeechKeys,
} from './unverifiedSpeech.js';
import { markMessageUnverifiedSpeech } from './messages.queries.js';
import { getRecentSessionMessages } from './crisis.queries.js';
import { getTranscriptsExport } from './datasetExport.queries.js';
import { projectSafeMetadata } from './metadataProjection.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('the unverified-speech predicate', () => {
  it('treats a missing key, a null metadata and any value but true as verified', () => {
    expect(notUnverifiedSpeechSql()).toBe("COALESCE(metadata->>'unverified_speech', '') <> 'true'");
    expect(notUnverifiedSpeechSql('m')).toBe("COALESCE(m.metadata->>'unverified_speech', '') <> 'true'");
  });
});

describe('markMessageUnverifiedSpeech', () => {
  it('merges the flag, the reason and the evidence into the row, and touches nothing else', async () => {
    await markMessageUnverifiedSpeech(42, { received_ms: 5000, muted_ms: 5000, unmuted_ms: 0, unmuted_rms_dbfs: null });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb");
    expect(sql).toContain("WHERE message_id = $1 AND role = 'user'");
    expect(sql).not.toMatch(/content/);
    expect(params[0]).toBe(42);
    expect(JSON.parse(params[1] as string)).toEqual({
      [UNVERIFIED_SPEECH_KEY]: true,
      unverified_speech_reason: 'mic_muted',
      mic_audio: { received_ms: 5000, muted_ms: 5000, unmuted_ms: 0, unmuted_rms_dbfs: null, state: 'muted' },
    });
  });

  it('throws when no row was marked, so the caller scores the turn as real', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(markMessageUnverifiedSpeech(42, {})).rejects.toThrow('Message not found');
  });
});

describe('readers of the mark', () => {
  it('the crisis context window leaves an unverified turn out', async () => {
    await getRecentSessionMessages('sess-1', 10);
    expect(String(queryMock.mock.calls[0][0])).toContain(`AND ${notUnverifiedSpeechSql()}`);
  });

  it('transcripts.csv keeps the row and carries the mark as a column', async () => {
    await getTranscriptsExport('2026-12-31T23:59:59Z');
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`(NOT ${notUnverifiedSpeechSql('m')}) AS unverified_speech`);
    expect(sql).toContain("WHERE m.role IN ('user', 'assistant')\n");
  });
});

describe('client-supplied metadata cannot carry the server-only speech keys', () => {
  it('strips the mark, the reason and the evidence, and keeps everything else', () => {
    const extras = {
      item_id: 'item_1',
      unverified_speech: true,
      unverified_speech_reason: 'mic_muted',
      mic_audio: { note: 'free text' },
    };
    expect(stripServerOnlySpeechKeys(extras)).toEqual({ item_id: 'item_1' });
    // The input is not modified.
    expect(extras.unverified_speech).toBe(true);
  });

  it('passes null and non-objects through', () => {
    expect(stripServerOnlySpeechKeys(null)).toBeNull();
    expect(stripServerOnlySpeechKeys('x')).toBe('x');
  });
});

describe('what the redacted views show of the speech keys', () => {
  it('the flag, the fixed reason and the numeric evidence pass', () => {
    expect(
      projectSafeMetadata({
        channel: 'live',
        unverified_speech: true,
        unverified_speech_reason: 'mic_muted',
        mic_audio: { received_ms: 5000, muted_ms: 5000, unmuted_ms: 0, unmuted_rms_dbfs: null, state: 'muted' },
      }),
    ).toEqual({
      channel: 'live',
      unverified_speech: true,
      unverified_speech_reason: 'mic_muted',
      mic_audio: { received_ms: 5000, muted_ms: 5000, unmuted_ms: 0, unmuted_rms_dbfs: null, state: 'muted' },
    });
  });

  it('text under those keys never passes', () => {
    expect(
      projectSafeMetadata({
        unverified_speech: 'my name is Jane',
        unverified_speech_reason: 'my name is Jane',
        mic_audio: { received_ms: 'my name is Jane', state: 'my name is Jane', note: 'my name is Jane' },
      }),
    ).toBeNull();
    expect(safeMicAudio('my name is Jane')).toBeNull();
    expect(safeMicAudio({ unmuted_ms: 12, extra: { nested: 'text' } })).toEqual({ unmuted_ms: 12 });
  });
});
