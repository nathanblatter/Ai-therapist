// screener_trend producer: work-queue integration over a stateful in-memory
// work_items fake that mirrors the real insert (UNIQUE item_type+source_table+
// source_id, ON CONFLICT DO NOTHING) and expiry semantics, so multi-run
// behavior (dedup, supersede, recover, clinician-resolved stays resolved) is
// exercised end to end through enqueueWorkItem. Caseload/RBAC visibility of
// the resulting pool items is asserted in db/workQueue.queries.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeItem {
  item_id: number;
  org_id: number;
  client_id: number | null;
  assignee_id: number | null;
  assignee_role: string | null;
  item_type: string;
  severity: string;
  title: string;
  detail: Record<string, unknown> | null;
  source_table: string;
  source_id: string;
  status: 'open' | 'acked' | 'resolved' | 'expired';
  is_sandbox: boolean;
}

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  readings: [] as { client_id: number; scale: string; response_id: number; score: number; created_at: string }[],
  nextId: 1,
}));

const mocks = vi.hoisted(() => ({
  insertWorkItem: vi.fn(),
  expireScreenerTrendItems: vi.fn(),
  listScreenerTrendReadings: vi.fn(),
  getUserById: vi.fn(),
  getCareTeam: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
  getResearcherIds: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getOrgTherapistIds: vi.fn(),
  notifyWorkItem: vi.fn(),
  runDigestSweep: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: mocks.poolQuery } }));
vi.mock('../db/index.js', () => ({
  insertWorkItem: mocks.insertWorkItem,
  expireScreenerTrendItems: mocks.expireScreenerTrendItems,
  listScreenerTrendReadings: mocks.listScreenerTrendReadings,
  getUserById: mocks.getUserById,
  getCareTeam: mocks.getCareTeam,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
  getResearcherIds: mocks.getResearcherIds,
  getSessionAccessInfo: mocks.getSessionAccessInfo,
  getOrgTherapistIds: mocks.getOrgTherapistIds,
  getTherapistIdsForClient: vi.fn(),
  getCaseworkerIdsForClient: vi.fn(),
}));
vi.mock('./notification.service.js', () => ({
  notifyWorkItem: mocks.notifyWorkItem,
  runDigestSweep: mocks.runDigestSweep,
}));

const { runScreenerTrendSweep, runWorkItemSweep, screenerTrendSourceId } = await import('./workQueue.service.js');

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
let nextResponseId = 100;

function addReading(clientId: number, scale: string, daysAgo: number, score: number): number {
  const responseId = nextResponseId++;
  state.readings.push({
    client_id: clientId,
    scale,
    response_id: responseId,
    score,
    created_at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
  });
  return responseId;
}

function items(): FakeItem[] {
  return state.items as FakeItem[];
}

function live(): FakeItem[] {
  return items().filter((i) => i.status === 'open' || i.status === 'acked');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.items = [];
  state.readings = [];
  state.nextId = 1;
  nextResponseId = 100;

  mocks.insertWorkItem.mockImplementation(async (input: Record<string, unknown>) => {
    const dup = items().find(
      (i) => i.item_type === input.itemType && i.source_table === input.sourceTable && i.source_id === input.sourceId,
    );
    if (dup) return null; // ON CONFLICT DO NOTHING (no reopen for screener_trend)
    const row: FakeItem = {
      item_id: state.nextId++,
      org_id: input.orgId as number,
      client_id: (input.clientId as number | null) ?? null,
      assignee_id: (input.assigneeId as number | null) ?? null,
      assignee_role: (input.assigneeRole as string | null) ?? null,
      item_type: input.itemType as string,
      severity: input.severity as string,
      title: input.title as string,
      detail: (input.detail as Record<string, unknown>) ?? null,
      source_table: input.sourceTable as string,
      source_id: input.sourceId as string,
      status: 'open',
      is_sandbox: Boolean(input.isSandbox),
    };
    items().push(row);
    return row;
  });
  mocks.expireScreenerTrendItems.mockImplementation(
    async (clientId: number, scale: string, keepSourceId: string | null) => {
      const expired: FakeItem[] = [];
      for (const item of items()) {
        if (
          item.item_type === 'screener_trend' &&
          item.client_id === clientId &&
          item.detail?.scale === scale &&
          (item.status === 'open' || item.status === 'acked') &&
          (keepSourceId === null || item.source_id !== keepSourceId)
        ) {
          item.status = 'expired';
          expired.push(item);
        }
      }
      return expired;
    },
  );
  // The DB layer returns the last 3 per client+scale, oldest first.
  mocks.listScreenerTrendReadings.mockImplementation(async () => {
    const groups = new Map<string, typeof state.readings>();
    for (const r of state.readings) {
      const key = `${r.client_id}:${r.scale}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].flatMap((g) =>
      g.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.response_id - b.response_id).slice(-3),
    );
  });
  mocks.getUserById.mockResolvedValue({ userid: 42, organization_id: 5, is_sandbox: false });
  mocks.getCareTeam.mockResolvedValue([
    { member_id: 7, username: 't1', member_role: 'therapist', assigned_at: 'x' },
    { member_id: 8, username: 'cw1', member_role: 'caseworker', assigned_at: 'x' },
  ]);
  mocks.getIrbStudyOrgId.mockResolvedValue(1);
  mocks.getResearcherIds.mockResolvedValue([99]);
  mocks.getOrgTherapistIds.mockResolvedValue([]);
  mocks.notifyWorkItem.mockResolvedValue(undefined);
  mocks.poolQuery.mockResolvedValue({ rows: [] });
});

describe('runScreenerTrendSweep', () => {
  it('files a descriptive pool item for a cutoff crossing, routed to the care team like screener_worsening', async () => {
    addReading(42, 'phq2', 8, 2);
    const latest = addReading(42, 'phq2', 1, 4);
    await runScreenerTrendSweep(NOW);

    expect(mocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: 'screener_trend',
        severity: 'warning',
        title:
          'PHQ-2 rose from 2 to 4 across the last two administrations. ' +
          'The latest score is at or above the standard screening cutoff of 3.',
        sourceTable: 'scale_responses',
        sourceId: `screener_trend:42:phq2:${latest}`,
        clientId: 42,
        assigneeId: null, // pool item: caseload-scoped visibility, no direct assignee
        orgId: 5,
      }),
    );
    const [item] = live();
    expect(item.detail).toMatchObject({
      scale: 'phq2',
      rules: ['cutoff_crossed'],
      scores: [2, 4],
      from_score: 2,
      to_score: 4,
      cutoff: 3,
      latest_response_id: latest,
      kind: 'descriptive_self_report_screening_trend',
    });
    // Care team only: no researcher fan-out, no org-wide therapist fan-out.
    expect(mocks.notifyWorkItem).toHaveBeenCalledWith(expect.anything(), [
      { userId: 7, role: 'therapist' },
      { userId: 8, role: 'caseworker' },
    ]);
    expect(mocks.getResearcherIds).not.toHaveBeenCalled();
    expect(mocks.getOrgTherapistIds).not.toHaveBeenCalled();
  });

  it('never touches crisis state or SQL directly (descriptive only)', async () => {
    addReading(42, 'phq2', 15, 1);
    addReading(42, 'phq2', 8, 2);
    addReading(42, 'phq2', 1, 5);
    await runScreenerTrendSweep(NOW);
    expect(live()).toHaveLength(1);
    expect(live()[0].item_type).toBe('screener_trend');
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('dedups: a persisting trend with no new reading does not re-file or re-notify', async () => {
    addReading(42, 'phq2', 8, 2);
    addReading(42, 'phq2', 1, 4);
    await runScreenerTrendSweep(NOW);
    await runScreenerTrendSweep(NOW);
    await runScreenerTrendSweep(new Date(NOW.getTime() + 2 * DAY_MS));
    expect(items()).toHaveLength(1);
    expect(mocks.notifyWorkItem).toHaveBeenCalledTimes(1);
  });

  it('a clinician-resolved item stays resolved while the same readings persist', async () => {
    addReading(42, 'phq2', 8, 2);
    addReading(42, 'phq2', 1, 4);
    await runScreenerTrendSweep(NOW);
    items()[0].status = 'resolved';
    await runScreenerTrendSweep(NOW);
    expect(items()).toHaveLength(1);
    expect(items()[0].status).toBe('resolved');
    expect(mocks.notifyWorkItem).toHaveBeenCalledTimes(1);
  });

  it('a newer reading that is still worsening supersedes the old item (one live item per client+scale)', async () => {
    addReading(42, 'phq2', 15, 1);
    addReading(42, 'phq2', 8, 3); // crossing
    await runScreenerTrendSweep(new Date(NOW.getTime() - 7 * DAY_MS));
    const first = live()[0];
    const latest = addReading(42, 'phq2', 1, 5); // 1, 3, 5: sustained
    await runScreenerTrendSweep(NOW);

    expect(first.status).toBe('expired');
    expect(live()).toHaveLength(1);
    expect(live()[0].source_id).toBe(screenerTrendSourceId(42, 'phq2', latest));
    expect(live()[0].detail).toMatchObject({ rules: ['sustained_increase'], scores: [1, 3, 5] });
  });

  it('keeps the item open while the score stays at or above the cutoff', async () => {
    addReading(42, 'phq2', 15, 2);
    addReading(42, 'phq2', 8, 4);
    await runScreenerTrendSweep(new Date(NOW.getTime() - 7 * DAY_MS));
    mocks.expireScreenerTrendItems.mockClear();
    addReading(42, 'phq2', 1, 3); // dipped, still >= cutoff
    await runScreenerTrendSweep(NOW);
    expect(live()).toHaveLength(1);
    expect(mocks.expireScreenerTrendItems).not.toHaveBeenCalled();
  });

  it('expires the item when scores recover (back under the cutoff and not rising)', async () => {
    addReading(42, 'phq2', 15, 2);
    addReading(42, 'phq2', 8, 4);
    await runScreenerTrendSweep(new Date(NOW.getTime() - 7 * DAY_MS));
    addReading(42, 'phq2', 1, 1);
    await runScreenerTrendSweep(NOW);
    expect(live()).toHaveLength(0);
    expect(items()[0].status).toBe('expired');
    expect(mocks.expireScreenerTrendItems).toHaveBeenCalledWith(42, 'phq2', null);
  });

  it('acked items also expire on recovery', async () => {
    addReading(42, 'phq2', 15, 2);
    addReading(42, 'phq2', 8, 4);
    await runScreenerTrendSweep(new Date(NOW.getTime() - 7 * DAY_MS));
    items()[0].status = 'acked';
    addReading(42, 'phq2', 1, 2);
    await runScreenerTrendSweep(NOW);
    expect(items()[0].status).toBe('expired');
  });

  it('stale data neither files nor clears', async () => {
    addReading(42, 'phq2', 50, 1);
    addReading(42, 'phq2', 40, 4);
    await runScreenerTrendSweep(NOW);
    expect(items()).toHaveLength(0);
    expect(mocks.expireScreenerTrendItems).not.toHaveBeenCalled();
  });

  it('never flags a single reading', async () => {
    addReading(42, 'phq2', 1, 6);
    await runScreenerTrendSweep(NOW);
    expect(items()).toHaveLength(0);
  });

  it('PHQ-2 and GAD-2 are tracked independently for the same client', async () => {
    addReading(42, 'phq2', 8, 2);
    addReading(42, 'phq2', 1, 4);
    addReading(42, 'gad2', 8, 1);
    addReading(42, 'gad2', 1, 0); // recovered: must not expire the PHQ-2 item
    await runScreenerTrendSweep(NOW);
    expect(live()).toHaveLength(1);
    expect(live()[0].detail?.scale).toBe('phq2');
    expect(mocks.expireScreenerTrendItems).toHaveBeenCalledWith(42, 'gad2', null);
  });

  it('ignores scales other than PHQ-2 / GAD-2', async () => {
    addReading(42, 'phq9', 8, 2);
    addReading(42, 'phq9', 1, 20);
    await runScreenerTrendSweep(NOW);
    expect(items()).toHaveLength(0);
  });

  it('one client failing does not stop the others, and the sweep never throws', async () => {
    addReading(41, 'phq2', 8, 2);
    addReading(41, 'phq2', 1, 4);
    addReading(42, 'phq2', 8, 2);
    addReading(42, 'phq2', 1, 4);
    mocks.expireScreenerTrendItems.mockRejectedValueOnce(new Error('db hiccup'));
    await expect(runScreenerTrendSweep(NOW)).resolves.toBeUndefined();
    expect(items().map((i) => i.client_id)).toEqual([41, 42]);
  });

  it('a failing readings query is logged and swallowed', async () => {
    mocks.listScreenerTrendReadings.mockRejectedValueOnce(new Error('bad query'));
    await expect(runScreenerTrendSweep(NOW)).resolves.toBeUndefined();
    expect(mocks.insertWorkItem).not.toHaveBeenCalled();
  });

  it('runs as part of the daily work-item sweep (no new scheduler)', async () => {
    addReading(42, 'phq2', 8, 2);
    addReading(42, 'phq2', 1, 4);
    await runWorkItemSweep(undefined, NOW);
    expect(mocks.insertWorkItem).toHaveBeenCalledWith(expect.objectContaining({ itemType: 'screener_trend' }));
  });
});
