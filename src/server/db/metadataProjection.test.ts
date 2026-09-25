// ai-therapist-217: messages.metadata carries verbatim participant free text,
// so every read path that serves `content_redacted` must project metadata
// through the telemetry allowlist. These cover the projector itself; the
// query-level wiring is covered in export.queries.test.ts and
// adminSessions.metadata.test.ts.
import { describe, it, expect } from 'vitest';
import {
  SAFE_MESSAGE_METADATA_KEYS,
  projectSafeMetadata,
  projectRowsMetadata,
} from './metadataProjection.js';

// A realistic worst case: one blob holding every PHI-bearing key any writer
// produces, next to the telemetry keys researchers legitimately need.
const PHI_KEYS = [
  'arguments',
  'args',
  'response',
  'error',
  'reason',
  'text',
  'summary',
  'transcript',
  'admin_user',
  'admin_username',
  'edited_by',
  'fields',
  'free_text',
];

const MIXED_METADATA = {
  tool_name: 'log_thought_record',
  call_id: 'call_abc123',
  delegation_id: 'deleg_1',
  channel: 'live',
  status: 'completed',
  item_id: 'item_9',
  start_ms: 1200,
  end_ms: 4800,
  category: 'breakthrough',
  edited: true,
  edited_at: '2026-09-24T00:00:00.000Z',
  arguments: { situation: 'Fight with my mother Jane at 42 Oak St', mood: 'ashamed' },
  args: { note: 'I relapsed on Tuesday' },
  response: { echo: 'Fight with my mother Jane' },
  error: 'invalid situation: "Fight with my mother Jane"',
  reason: 'Participant disclosed self-harm history',
  text: 'Ask about the incident with her brother',
  summary: 'Participant described a panic attack at work',
  transcript: 'I have been thinking about ending it',
  admin_user: 'admin1',
  admin_username: 'admin1',
  edited_by: 'researcher2',
  fields: ['instructions'],
  free_text: 'anything a client posts to /logs/batch',
};

describe('projectSafeMetadata', () => {
  it('drops every PHI-bearing key', () => {
    const projected = projectSafeMetadata(MIXED_METADATA) ?? {};
    for (const key of PHI_KEYS) {
      expect(projected, `PHI key "${key}" survived the projection`).not.toHaveProperty(key);
    }
    // Belt and braces: no participant string should appear anywhere in the
    // serialized output, even nested.
    const serialized = JSON.stringify(projected);
    for (const phrase of ['Jane', 'Oak St', 'relapsed', 'self-harm', 'panic attack', 'ending it']) {
      expect(serialized).not.toContain(phrase);
    }
  });

  it('keeps the telemetry keys researchers need', () => {
    expect(projectSafeMetadata(MIXED_METADATA)).toEqual({
      tool_name: 'log_thought_record',
      call_id: 'call_abc123',
      delegation_id: 'deleg_1',
      channel: 'live',
      status: 'completed',
      item_id: 'item_9',
      start_ms: 1200,
      end_ms: 4800,
      category: 'breakthrough',
      edited: true,
      edited_at: '2026-09-24T00:00:00.000Z',
    });
  });

  it('is an allowlist: an unknown key from a future writer is denied', () => {
    expect(projectSafeMetadata({ status: 'failed', some_new_field: 'verbatim text' }))
      .toEqual({ status: 'failed' });
  });

  it('returns null for absent, non-object, or fully-stripped metadata', () => {
    expect(projectSafeMetadata(null)).toBeNull();
    expect(projectSafeMetadata(undefined)).toBeNull();
    expect(projectSafeMetadata('a string')).toBeNull();
    expect(projectSafeMetadata(['a', 'b'])).toBeNull();
    expect(projectSafeMetadata({ arguments: { a: 1 } })).toBeNull();
  });

  it('allowlists no key that is a known free-text carrier', () => {
    for (const key of PHI_KEYS) {
      expect(SAFE_MESSAGE_METADATA_KEYS).not.toContain(key);
    }
  });
});

describe('projectRowsMetadata', () => {
  it('projects the extras field of every row and leaves other columns alone', () => {
    const rows = [
      { id: 1, message: 'redacted [NAME]', extras: MIXED_METADATA },
      { id: 2, message: 'hi', extras: null },
    ];
    expect(projectRowsMetadata(rows)).toEqual([
      { id: 1, message: 'redacted [NAME]', extras: projectSafeMetadata(MIXED_METADATA) },
      { id: 2, message: 'hi', extras: null },
    ]);
  });

  it('leaves rows without the field untouched', () => {
    const rows = [{ id: 1, period: '2026-09' }];
    expect(projectRowsMetadata(rows)).toEqual(rows);
  });
});
