// Work-queue producer contract: client/org/sandbox resolution, idempotent
// duplicate handling (no double-notify), pool vs assignee recipient routing,
// the never-throws guarantee, and the daily sweep producers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  insertWorkItemMock,
  getSessionAccessInfoMock,
  getUserByIdMock,
  getCareTeamMock,
  getIrbStudyOrgIdMock,
  notifyWorkItemMock,
  runDigestSweepMock,
  poolQueryMock,
} = vi.hoisted(() => ({
  insertWorkItemMock: vi.fn(),
  getSessionAccessInfoMock: vi.fn(),
  getUserByIdMock: vi.fn(),
  getCareTeamMock: vi.fn(),
  getIrbStudyOrgIdMock: vi.fn(),
  notifyWorkItemMock: vi.fn(),
  runDigestSweepMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('../db/index.js', () => ({
  insertWorkItem: insertWorkItemMock,
  getSessionAccessInfo: getSessionAccessInfoMock,
  getUserById: getUserByIdMock,
  getCareTeam: getCareTeamMock,
  getIrbStudyOrgId: getIrbStudyOrgIdMock,
  // Transitive imports of utils/adminBroadcast.js:
  getTherapistIdsForClient: vi.fn(),
  getCaseworkerIdsForClient: vi.fn(),
}));
vi.mock('./notification.service.js', () => ({
  notifyWorkItem: notifyWorkItemMock,
  runDigestSweep: runDigestSweepMock,
}));

const {
  enqueueWorkItem,
  runWorkItemSweep,
  startWorkQueueScheduler,
  stopWorkQueueScheduler,
} = await import('./workQueue.service.js');

function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 1, org_id: 5, client_id: 42, assignee_id: null, assignee_role: null,
    item_type: 'crisis_flag', severity: 'urgent', title: 'Crisis flag', detail: null,
    source_table: 'crisis_events', source_id: '7', status: 'open',
    acked_by: null, acked_at: null, resolved_by: null, resolved_at: null,
    resolution_note: null, is_sandbox: false, created_at: 'now',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserByIdMock.mockResolvedValue({ userid: 42, username: 'p42', role: 'participant', organization_id: 5, is_sandbox: false });
  getCareTeamMock.mockResolvedValue([
    { member_id: 7, username: 't1', member_role: 'therapist', assigned_at: 'x' },
    { member_id: 8, username: 'cw1', member_role: 'caseworker', assigned_at: 'x' },
  ]);
  getIrbStudyOrgIdMock.mockResolvedValue(1);
  insertWorkItemMock.mockResolvedValue(insertedRow());
  notifyWorkItemMock.mockResolvedValue(undefined);
  poolQueryMock.mockResolvedValue({ rows: [] });
});

const BASE = {
  itemType: 'crisis_flag' as const,
  severity: 'urgent' as const,
  title: 'Crisis flag',
  sourceTable: 'crisis_events',
  sourceId: '7',
};

describe('enqueueWorkItem', () => {
  it('resolves org and sandbox from the client row and notifies the care team pool', async () => {
    const item = await enqueueWorkItem({ ...BASE, clientId: 42 });
    expect(item).not.toBeNull();
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 5, clientId: 42, isSandbox: false, itemType: 'crisis_flag',
    }));
    expect(notifyWorkItemMock).toHaveBeenCalledWith(insertedRow(), [
      { userId: 7, role: 'therapist' },
      { userId: 8, role: 'caseworker' },
    ]);
  });

  it('resolves the client from a session id when clientId is absent', async () => {
    getSessionAccessInfoMock.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'voice' });
    await enqueueWorkItem({ ...BASE, sessionId: 'sess-1' });
    expect(getSessionAccessInfoMock).toHaveBeenCalledWith('sess-1');
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 42 }));
  });

  it('stamps is_sandbox from the client account', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 42, username: 'fake', role: 'participant', organization_id: 9, is_sandbox: true });
    await enqueueWorkItem({ ...BASE, clientId: 42 });
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: 9, isSandbox: true }));
  });

  it('does not re-notify on an idempotent duplicate', async () => {
    insertWorkItemMock.mockResolvedValue(null);
    const item = await enqueueWorkItem({ ...BASE, clientId: 42 });
    expect(item).toBeNull();
    expect(notifyWorkItemMock).not.toHaveBeenCalled();
  });

  it('routes to the assignee only when one is set', async () => {
    insertWorkItemMock.mockResolvedValue(insertedRow({ assignee_id: 7, assignee_role: 'therapist' }));
    await enqueueWorkItem({ ...BASE, clientId: 42, assigneeId: 7, assigneeRole: 'therapist' });
    expect(getCareTeamMock).not.toHaveBeenCalled();
    expect(notifyWorkItemMock).toHaveBeenCalledWith(expect.anything(), [{ userId: 7, role: 'therapist' }]);
  });

  it('falls back to the IRB org when no client resolves the org', async () => {
    getUserByIdMock.mockResolvedValue(null);
    await enqueueWorkItem({ ...BASE, clientId: 42 });
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: 1 }));
  });

  it('drops the item (returns null) when no org can be resolved', async () => {
    getUserByIdMock.mockResolvedValue(null);
    getIrbStudyOrgIdMock.mockResolvedValue(null);
    expect(await enqueueWorkItem({ ...BASE, clientId: 42 })).toBeNull();
    expect(insertWorkItemMock).not.toHaveBeenCalled();
  });

  it('never throws into the producer', async () => {
    insertWorkItemMock.mockRejectedValue(new Error('db down'));
    await expect(enqueueWorkItem({ ...BASE, clientId: 42 })).resolves.toBeNull();
  });

  it('never throws even when notification fan-out fails', async () => {
    notifyWorkItemMock.mockRejectedValue(new Error('smtp exploded'));
    await expect(enqueueWorkItem({ ...BASE, clientId: 42 })).resolves.toBeNull();
  });
});

describe('runWorkItemSweep', () => {
  it('enqueues ONE inactivity item per client (per-client source id, reopen on recurrence)', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT tc.client_id')) return { rows: [{ client_id: 42 }] };
      return { rows: [] };
    });
    await runWorkItemSweep(undefined, new Date('2026-08-27T18:00:00Z'));
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({
      itemType: 'inactivity',
      sourceId: 'inactivity:42', // no date: an open item is refreshed, never stacked daily
      clientId: 42,
      reopen: true, // expired-on-re-engagement items reactivate when inactivity recurs
    }));
  });

  it('enqueues screener_worsening pool items with the score delta in detail', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH ranked AS')) {
        return { rows: [{ client_id: 42, scale: 'PHQ-9', latest_score: 18, previous_score: 10, latest_at: '2026-08-25' }] };
      }
      return { rows: [] };
    });
    await runWorkItemSweep();
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({
      itemType: 'screener_worsening',
      severity: 'warning',
      sourceId: 'screener:42:PHQ-9:2026-08-25',
      detail: { scale: 'PHQ-9', latest_score: 18, previous_score: 10 },
    }));
  });

  it('assigns message_unread_stale items to the thread clinician', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM message_threads t')) {
        return { rows: [{ thread_id: 3, client_id: 42, clinician_id: 8, clinician_role: 'caseworker', last_message_id: 99, unread_count: 2 }] };
      }
      return { rows: [] };
    });
    await runWorkItemSweep();
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({
      itemType: 'message_unread_stale',
      sourceId: 'thread:3:99',
      assigneeId: 8,
      assigneeRole: 'caseworker',
    }));
  });

  it('survives a failing producer query and still runs the others', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH ranked AS')) throw new Error('bad query');
      if (sql.includes('SELECT DISTINCT tc.client_id')) return { rows: [{ client_id: 42 }] };
      return { rows: [] };
    });
    await expect(runWorkItemSweep()).resolves.toBeUndefined();
    expect(insertWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ itemType: 'inactivity' }));
  });
});

describe('startWorkQueueScheduler', () => {
  // 12:00 America/Denver (MDT, UTC-6): past the 06:00 daily-sweep hour.
  const NOON_DENVER = new Date('2026-08-27T18:00:00Z');
  const MAX_JITTER_MS = 2 * 60 * 1000;

  function poolFor(claimWon: boolean) {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('system_config')) {
        return claimWon
          ? { rows: [{ config_key: 'work_queue.last_sweep_date' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_DENVER);
  });

  afterEach(() => {
    stopWorkQueueScheduler();
    vi.useRealTimers();
  });

  it('runs an immediate (jittered) first tick so sub-hour restarts do not starve the sweeps', async () => {
    poolFor(true);
    startWorkQueueScheduler();
    expect(runDigestSweepMock).not.toHaveBeenCalled(); // jitter pending
    await vi.advanceTimersByTimeAsync(MAX_JITTER_MS);
    expect(runDigestSweepMock).toHaveBeenCalledTimes(1);
    // Claim won -> the daily work-item sweep ran on the initial tick.
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('SELECT DISTINCT tc.client_id'))).toBe(true);
  });

  it('skips the daily sweep when the persisted claim says today already ran (restart / paired instance)', async () => {
    poolFor(false);
    startWorkQueueScheduler();
    await vi.advanceTimersByTimeAsync(MAX_JITTER_MS);
    expect(runDigestSweepMock).toHaveBeenCalledTimes(1); // digest still runs every tick
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('SELECT DISTINCT tc.client_id'))).toBe(false);
  });

  it('claims the sweep date at most once per day (in-memory guard on later ticks)', async () => {
    poolFor(true);
    startWorkQueueScheduler();
    await vi.advanceTimersByTimeAsync(MAX_JITTER_MS);
    const claimCalls = () =>
      poolQueryMock.mock.calls.filter(([sql]) => String(sql).includes('system_config')).length;
    expect(claimCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // next hourly tick, same day
    expect(runDigestSweepMock).toHaveBeenCalledTimes(2);
    expect(claimCalls()).toBe(1);
  });
});
