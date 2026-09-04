import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const { embedTextBatchMock } = vi.hoisted(() => ({ embedTextBatchMock: vi.fn() }));
vi.mock('./embeddings.service.js', () => ({
  embedTextBatch: embedTextBatchMock,
}));

import { sweepMessageEmbeddings } from './messageEmbedding.service.js';

const settingsRow = (enabled: boolean) => ({ rows: [{ config_value: { enabled } }] });

beforeEach(() => {
  queryMock.mockReset();
  embedTextBatchMock.mockReset();
});

describe('sweepMessageEmbeddings', () => {
  it('no-ops when disabled via system_config', async () => {
    queryMock.mockResolvedValueOnce(settingsRow(false));
    const result = await sweepMessageEmbeddings();
    expect(result).toEqual({ embedded: 0 });
    expect(embedTextBatchMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('defaults to enabled when no config row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // settings
    queryMock.mockResolvedValueOnce({ rows: [] }); // pending
    const result = await sweepMessageEmbeddings();
    expect(result).toEqual({ embedded: 0 });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('selects only redacted, un-embedded, non-sandbox user/assistant messages', async () => {
    queryMock.mockResolvedValueOnce(settingsRow(true));
    queryMock.mockResolvedValueOnce({ rows: [] });
    await sweepMessageEmbeddings();
    const [sql] = queryMock.mock.calls[1];
    expect(sql).toContain('m.content_redacted IS NOT NULL');
    expect(sql).toContain('m.embedding IS NULL');
    expect(sql).toContain("m.role IN ('user', 'assistant')");
    expect(sql).toContain('u.is_sandbox IS NOT TRUE');
    expect(sql).not.toContain('m.content ');
  });

  it('embeds redacted text and writes vectors keyed by message_id', async () => {
    queryMock.mockResolvedValueOnce(settingsRow(true));
    queryMock.mockResolvedValueOnce({
      rows: [
        { message_id: 'm1', content_redacted: 'redacted one' },
        { message_id: 'm2', content_redacted: 'redacted two' },
      ],
    });
    embedTextBatchMock.mockResolvedValueOnce([[0.1, 0.2], [0.3, 0.4]]);
    queryMock.mockResolvedValue({ rowCount: 1 });

    const result = await sweepMessageEmbeddings();

    expect(result).toEqual({ embedded: 2 });
    expect(embedTextBatchMock).toHaveBeenCalledWith(['redacted one', 'redacted two']);
    const updateCalls = queryMock.mock.calls.slice(2);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][0]).toContain('SET embedding = $1::vector');
    expect(updateCalls[0][1]).toEqual(['[0.1,0.2]', 'm1']);
    expect(updateCalls[1][1]).toEqual(['[0.3,0.4]', 'm2']);
    // Idempotence guard: never overwrite an existing vector.
    expect(updateCalls[0][0]).toContain('embedding IS NULL');
  });

  it('counts only rows actually updated (concurrent sweep already wrote one)', async () => {
    queryMock.mockResolvedValueOnce(settingsRow(true));
    queryMock.mockResolvedValueOnce({
      rows: [
        { message_id: 'm1', content_redacted: 'a' },
        { message_id: 'm2', content_redacted: 'b' },
      ],
    });
    embedTextBatchMock.mockResolvedValueOnce([[1], [2]]);
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    queryMock.mockResolvedValueOnce({ rowCount: 0 });

    const result = await sweepMessageEmbeddings();
    expect(result).toEqual({ embedded: 1 });
  });
});
