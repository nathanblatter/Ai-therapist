import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const { deleteObjectMock } = vi.hoisted(() => ({ deleteObjectMock: vi.fn() }));
vi.mock('../config/objectStorage.js', () => ({ deleteObject: deleteObjectMock }));

const mocks = vi.hoisted(() => ({
  getRecordingsToAgeOut: vi.fn(),
  getOrphanedRecordingsPastGrace: vi.fn(),
  clearRecordingColumns: vi.fn(),
  insertDeletionLog: vi.fn(),
}));
vi.mock('../db/dataRetention.queries.js', () => mocks);

const messagingMocks = vi.hoisted(() => ({
  deleteAgedThreadMessages: vi.fn(),
}));
vi.mock('../db/messagingRetention.queries.js', () => messagingMocks);

import {
  getDataRetentionSettings,
  enforceRetention,
} from './dataRetention.service.js';

const SETTINGS = {
  enabled: true,
  recordings_retention_days: 90,
  wiped_user_grace_days: 14,
  run_time: '03:30',
  last_run_at: null,
  last_run_deletions: 0,
};

beforeEach(() => {
  queryMock.mockReset();
  deleteObjectMock.mockReset();
  mocks.getRecordingsToAgeOut.mockReset().mockResolvedValue([]);
  mocks.getOrphanedRecordingsPastGrace.mockReset().mockResolvedValue([]);
  mocks.clearRecordingColumns.mockReset().mockResolvedValue(undefined);
  mocks.insertDeletionLog.mockReset().mockResolvedValue(undefined);
  messagingMocks.deleteAgedThreadMessages.mockReset().mockResolvedValue({ messagesDeleted: 0, crisisEventsDeleted: 0 });
  // Default: settings SELECT returns enabled settings; any UPDATE resolves.
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT config_value')) return Promise.resolve({ rows: [{ config_value: SETTINGS }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('getDataRetentionSettings', () => {
  it('merges stored config over defaults', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ config_value: { enabled: true, recordings_retention_days: 30 } }] });
    const s = await getDataRetentionSettings();
    expect(s.recordings_retention_days).toBe(30);
    expect(s.wiped_user_grace_days).toBe(14); // default preserved
  });

  it('ships disabled by default when config is absent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const s = await getDataRetentionSettings();
    expect(s.enabled).toBe(false);
  });
});

describe('enforceRetention', () => {
  it('skips a scheduled run when disabled', async () => {
    queryMock.mockImplementation((sql: string) =>
      sql.includes('SELECT config_value')
        ? Promise.resolve({ rows: [{ config_value: { ...SETTINGS, enabled: false } }] })
        : Promise.resolve({ rows: [] }));
    const result = await enforceRetention('scheduler');
    expect(result.skipped).toBe(true);
    expect(mocks.getRecordingsToAgeOut).not.toHaveBeenCalled();
  });

  it('runs a manual pass even when disabled', async () => {
    queryMock.mockImplementation((sql: string) =>
      sql.includes('SELECT config_value')
        ? Promise.resolve({ rows: [{ config_value: { ...SETTINGS, enabled: false } }] })
        : Promise.resolve({ rows: [] }));
    const result = await enforceRetention('manual', 'cli');
    expect(result.skipped).toBe(false);
  });

  it('deletes aged-out recordings: MinIO delete, then columns nulled, then a success log row', async () => {
    mocks.getRecordingsToAgeOut.mockResolvedValue([
      { session_id: 's1', recording_object_key: 'rec/s1.wav', user_id: 7 },
    ]);
    deleteObjectMock.mockResolvedValue(undefined);
    const result = await enforceRetention('manual', 'cli');
    expect(deleteObjectMock).toHaveBeenCalledWith('rec/s1.wav');
    expect(mocks.clearRecordingColumns).toHaveBeenCalledWith('s1');
    expect(mocks.insertDeletionLog).toHaveBeenCalledWith(expect.objectContaining({
      artifactType: 'recording_object', artifactRef: 'rec/s1.wav',
      reason: 'recording_retention', success: true, policySnapshot: expect.objectContaining({ recordings_retention_days: 90 }),
    }));
    expect(result.recordingsDeleted).toBe(1);
    expect(result.failures).toBe(0);
  });

  it('on MinIO failure leaves DB columns intact and logs success=false', async () => {
    mocks.getRecordingsToAgeOut.mockResolvedValue([
      { session_id: 's1', recording_object_key: 'rec/s1.wav', user_id: null },
    ]);
    deleteObjectMock.mockRejectedValue(new Error('minio down'));
    const result = await enforceRetention('manual', 'cli');
    expect(mocks.clearRecordingColumns).not.toHaveBeenCalled();
    expect(mocks.insertDeletionLog).toHaveBeenCalledWith(expect.objectContaining({
      success: false, errorMessage: 'minio down',
    }));
    expect(result.failures).toBe(1);
    expect(result.recordingsDeleted).toBe(0);
  });

  it('handles wiped-user grace deletions with the grace reason, deduped against age-out', async () => {
    mocks.getRecordingsToAgeOut.mockResolvedValue([
      { session_id: 's1', recording_object_key: 'rec/s1.wav', user_id: null },
    ]);
    mocks.getOrphanedRecordingsPastGrace.mockResolvedValue([
      { session_id: 's1', recording_object_key: 'rec/s1.wav', user_id: null }, // dup, skipped
      { session_id: 's2', recording_object_key: 'rec/s2.wav', user_id: null },
    ]);
    deleteObjectMock.mockResolvedValue(undefined);
    const result = await enforceRetention('manual', 'cli');
    expect(result.recordingsDeleted).toBe(1);
    expect(result.graceDeleted).toBe(1);
    expect(mocks.insertDeletionLog).toHaveBeenCalledWith(expect.objectContaining({
      artifactRef: 'rec/s2.wav', reason: 'wiped_user_grace',
    }));
    // s1 only processed once (age-out), not again under grace.
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
  });

  it('stamps last_run_at/last_run_deletions in system_config', async () => {
    mocks.getRecordingsToAgeOut.mockResolvedValue([
      { session_id: 's1', recording_object_key: 'rec/s1.wav', user_id: 1 },
    ]);
    deleteObjectMock.mockResolvedValue(undefined);
    await enforceRetention('manual', 'cli');
    const updateCall = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE system_config'));
    expect(updateCall).toBeTruthy();
    const payload = JSON.parse(updateCall![1][0]);
    expect(payload.last_run_deletions).toBe(1);
    expect(payload.last_run_at).toBeTruthy();
  });

  // Message age-out (caseworker portal spec section 10 item 8): thread
  // messages are swept in the same pass, on the same retention window.
  it('ages out thread messages in the same pass on the recordings retention window', async () => {
    messagingMocks.deleteAgedThreadMessages.mockResolvedValue({ messagesDeleted: 3, crisisEventsDeleted: 1 });
    const result = await enforceRetention('manual', 'cli');
    expect(messagingMocks.deleteAgedThreadMessages).toHaveBeenCalledWith(expect.objectContaining({
      days: 90, // SAME window as recordings — one consistent records policy
      runId: result.runId,
      triggeredBy: 'manual',
      triggeredByUser: 'cli',
      policySnapshot: expect.objectContaining({ recordings_retention_days: 90 }),
    }));
    expect(result.threadMessagesDeleted).toBe(3);
    expect(result.failures).toBe(0);
  });

  it('counts message deletions into last_run_deletions', async () => {
    messagingMocks.deleteAgedThreadMessages.mockResolvedValue({ messagesDeleted: 2, crisisEventsDeleted: 0 });
    await enforceRetention('manual', 'cli');
    const updateCall = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE system_config'));
    expect(JSON.parse(updateCall![1][0]).last_run_deletions).toBe(2);
  });

  it('a failed (rolled-back) message age-out is a failure but does not break recording deletion', async () => {
    mocks.getRecordingsToAgeOut.mockResolvedValue([
      { session_id: 's1', recording_object_key: 'rec/s1.wav', user_id: 7 },
    ]);
    deleteObjectMock.mockResolvedValue(undefined);
    messagingMocks.deleteAgedThreadMessages.mockRejectedValue(new Error('audit CHECK rejected'));
    const result = await enforceRetention('manual', 'cli');
    expect(result.recordingsDeleted).toBe(1);
    expect(result.threadMessagesDeleted).toBe(0);
    expect(result.failures).toBe(1);
  });

  it('does not touch thread messages when a scheduled run is disabled', async () => {
    queryMock.mockImplementation((sql: string) =>
      sql.includes('SELECT config_value')
        ? Promise.resolve({ rows: [{ config_value: { ...SETTINGS, enabled: false } }] })
        : Promise.resolve({ rows: [] }));
    await enforceRetention('scheduler');
    expect(messagingMocks.deleteAgedThreadMessages).not.toHaveBeenCalled();
  });
});
