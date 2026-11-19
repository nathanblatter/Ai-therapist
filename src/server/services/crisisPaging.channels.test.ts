// The paging policy on two channels (ai-therapist-355): what is written on a
// page's row, and what "delivered" means to the folding rule (at least one
// channel accepted). The channels themselves are tested in
// crisisAlert.channels.test.ts; here the transport is a fake and the database
// is a small in-memory one, so nothing can page a person.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { channelResult } from '../testing/alertMock.js';
import type { AlertDelivery } from './crisisAlert.service.js';

interface Row {
  action_id: number;
  session_id: string;
  action_type: string;
  action_details: Record<string, unknown>;
  performed_at: Date;
}

const { rows, pager, broadcastMock } = vi.hoisted(() => ({
  rows: [] as Row[],
  pager: vi.fn(),
  broadcastMock: vi.fn(async () => undefined),
}));

vi.mock('../db/paging.queries.js', () => ({
  INCIDENT_CHAIN_BACKSTOP_MS: 12 * 60 * 60 * 1000,
  getPagingParticipantUserId: vi.fn(async () => 7),
  getRecentPagingRecords: vi.fn(async () => [...rows].reverse()),
  getIncidentChainSessionIds: vi.fn(async (id: string) => [id]),
  getParticipantFlagEvents: vi.fn(async () => []),
  getParticipantAssessedRisk: vi.fn(async () => []),
  participantSpokeSince: vi.fn(async () => false),
  getUnfinishedSilenceChecks: vi.fn(async () => []),
  claimSilenceCheck: vi.fn(async () => null),
  finishSilenceCheck: vi.fn(async () => false),
  insertPagingRecord: vi.fn(async (sessionId: string, actionType: string, details: Record<string, unknown>) => {
    const row: Row = {
      action_id: rows.length + 1,
      session_id: sessionId,
      action_type: actionType,
      action_details: JSON.parse(JSON.stringify(details)) as Record<string, unknown>,
      performed_at: new Date(),
    };
    rows.push(row);
    return row.action_id;
  }),
}));
vi.mock('./crisisAlert.service.js', async () => (await import('../testing/alertMock.js')).alertModuleMock(pager));
vi.mock('./suppression.js', () => ({ sessionSuppressesCrisisPaging: vi.fn(async () => false) }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));

import { pageHighRisk, pageVendorTermination, _resetPagingStateForTests } from './crisisPaging.service.js';

const delivery = (imessage: boolean | null, aws: boolean | null): AlertDelivery => {
  const channels = [
    ...(imessage === null ? [] : [channelResult('imessage', imessage)]),
    ...(aws === null
      ? []
      : [channelResult('aws_sms', aws, aws ? { messageIds: ['aws-msg-9'] } : { error: 'ThrottlingException' })]),
  ];
  return { delivered: channels.some((c) => c.ok), skipped: null, channels };
};
const paging = (row: Row): Record<string, unknown> => row.action_details['paging'] as Record<string, unknown>;
const notices = (): string[] =>
  broadcastMock.mock.calls.map((c) => String(((c as unknown[])[2] as { message: string }).message));

beforeEach(() => {
  rows.length = 0;
  pager.mockReset();
  broadcastMock.mockClear();
  (global as { io?: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
  _resetPagingStateForTests();
});
afterEach(() => {
  delete (global as { io?: unknown }).io;
});

describe('per-channel results are recorded on the page row', () => {
  it('both channels accepted: delivered, each channel listed with its provider message id', async () => {
    pager.mockResolvedValue(delivery(true, true));
    const decision = await pageHighRisk('s1', 82);
    expect(decision.outcome).toBe('paged');
    expect(rows[0].action_type).toBe('crisis_sms_alert');
    expect(paging(rows[0])).toMatchObject({
      decision: 'paged',
      delivered: true,
      channelsSkipped: null,
      channels: [
        { channel: 'imessage', ok: true, error: null, messageIds: [], parts: 1, partsAccepted: 1 },
        { channel: 'aws_sms', ok: true, error: null, messageIds: ['aws-msg-9'], parts: 1, partsAccepted: 1 },
      ],
    });
    // A clean risk page needs no extra dashboard notice (it has its own alert).
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('one channel failed: still delivered, the failure is on the row and shown to admins', async () => {
    pager.mockResolvedValue(delivery(false, true));
    const decision = await pageHighRisk('s1', 82);
    expect(decision.outcome).toBe('paged');
    expect(paging(rows[0])).toMatchObject({
      delivered: true,
      channels: [
        { channel: 'imessage', ok: false, error: 'http_502' },
        { channel: 'aws_sms', ok: true },
      ],
    });
    expect(String(paging(rows[0])['summary'])).toMatch(/Delivered by aws_sms; FAILED on imessage \(http_502\)\./);
    expect(notices()[0]).toMatch(/^On-call paged: .*FAILED on imessage \(http_502\)/);
  });

  it('every channel failed: not delivered, said so on the row and to admins, for a risk page too', async () => {
    pager.mockResolvedValue(delivery(false, false));
    const decision = await pageHighRisk('s1', 82);
    expect(decision.outcome).toBe('not_delivered');
    expect(paging(rows[0])).toMatchObject({ decision: 'not_delivered', delivered: false });
    expect(String(paging(rows[0])['summary'])).toMatch(
      /Every paging channel failed: imessage \(http_502\), aws_sms \(ThrottlingException\)\./,
    );
    expect(notices()[0]).toMatch(/^Page NOT delivered: .*Every paging channel failed/);
  });

  it('nothing configured (the harness): the row says why no channel was attempted, and no failure is raised', async () => {
    pager.mockResolvedValue({ delivered: false, skipped: 'not_configured', channels: [] });
    await pageHighRisk('s1', 82);
    expect(paging(rows[0])).toMatchObject({
      decision: 'not_delivered',
      kind: 'risk',
      channels: [],
      channelsSkipped: 'not_configured',
    });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('the row never holds a phone number or the message text', async () => {
    pager.mockResolvedValue(delivery(true, true));
    await pageHighRisk('s1', 82);
    const stored = JSON.stringify(rows[0].action_details);
    expect(stored).not.toMatch(/\+1\d{10}|URGENT|Why:/);
  });
});

describe('folding uses the combined result: delivered = at least one channel accepted', () => {
  it('delivered by AWS alone (bridge down): the repeat is folded', async () => {
    pager.mockResolvedValue(delivery(false, true));
    expect((await pageHighRisk('s1', 80)).outcome).toBe('paged');
    expect((await pageHighRisk('s2', 84)).outcome).toBe('folded');
    expect(pager).toHaveBeenCalledTimes(1);
  });

  it('delivered by the bridge alone (AWS down): the repeat is folded', async () => {
    pager.mockResolvedValue(delivery(true, false));
    expect((await pageHighRisk('s1', 80)).outcome).toBe('paged');
    expect((await pageHighRisk('s2', 84)).outcome).toBe('folded');
    expect(pager).toHaveBeenCalledTimes(1);
  });

  it('accepted by no channel: nothing is absorbed, the repeat pages again', async () => {
    pager.mockResolvedValueOnce(delivery(false, false)).mockResolvedValue(delivery(true, true));
    expect((await pageHighRisk('s1', 80)).outcome).toBe('not_delivered');
    expect((await pageHighRisk('s2', 84)).outcome).toBe('paged');
    expect((await pageHighRisk('s3', 85)).outcome).toBe('folded');
    expect(pager).toHaveBeenCalledTimes(2);
  });

  it('survives a restart: a stored row delivered by one channel is enough to fold', async () => {
    pager.mockResolvedValue(delivery(false, true));
    await pageHighRisk('s1', 80);
    _resetPagingStateForTests();
    expect((await pageHighRisk('s2', 84)).outcome).toBe('folded');
  });

  it('two events at once wait for the combined result, and fold only if a channel accepted', async () => {
    let settle: (d: AlertDelivery) => void = () => undefined;
    pager.mockReturnValueOnce(new Promise<AlertDelivery>((resolve) => (settle = resolve)));
    pager.mockResolvedValue(delivery(true, true));
    const first = pageHighRisk('s1', 80);
    const second = pageHighRisk('s2', 82);
    await new Promise((resolve) => setTimeout(resolve, 10));
    settle(delivery(false, false));
    expect((await first).outcome).toBe('not_delivered');
    expect((await second).outcome).toBe('paged');
  });

  it('a vendor-cut page keeps its notice and carries the channel results too', async () => {
    pager.mockResolvedValue(delivery(true, true));
    const decision = await pageVendorTermination({
      sessionId: 's1',
      cause: 'expired',
      flagged: true,
      severity: 'high',
    });
    expect(decision.outcome).toBe('paged');
    expect((paging(rows[0])['channels'] as unknown[]).length).toBe(2);
    expect(notices()[0]).toMatch(/^On-call paged: /);
  });
});
