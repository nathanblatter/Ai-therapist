// ai-therapist-217: the researcher transcript view serves `content_redacted`,
// but selected `metadata as extras` beside it — so verbatim participant free
// text (tool arguments, thought-record fields) reached researchers anyway.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getAdminSessionMessages } from './adminSessions.queries.js';

const METADATA = {
  tool_name: 'log_thought_record',
  call_id: 'call_1',
  channel: 'live',
  status: 'executing',
  start_ms: 10,
  end_ms: 20,
  arguments: { situation: 'my sister Marie called me worthless' },
  reason: 'participant disclosed self-harm',
};

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({
    rows: [{ message_id: 1, message: 'redacted', extras: { ...METADATA } }],
  });
});

describe('getAdminSessionMessages metadata exposure', () => {
  it('projects metadata to the telemetry allowlist on the redacted path', async () => {
    const [row] = await getAdminSessionMessages('s1', 'content_redacted');
    expect(row['extras']).toEqual({
      tool_name: 'log_thought_record',
      call_id: 'call_1',
      channel: 'live',
      status: 'executing',
      start_ms: 10,
      end_ms: 20,
    });
    expect(JSON.stringify(row['extras'])).not.toContain('Marie');
    expect(JSON.stringify(row['extras'])).not.toContain('self-harm');
  });

  it('leaves metadata intact for full-content (therapist) readers', async () => {
    const [row] = await getAdminSessionMessages('s1', 'content');
    expect(row['extras']).toEqual(METADATA);
  });
});
