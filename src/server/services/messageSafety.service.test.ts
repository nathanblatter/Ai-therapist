// messageSafety.service tests (caseworker portal, messaging slice): sandbox
// short-circuit, clear/low results, medium/high flag path (crisis event ->
// scan update -> work item -> notifications -> broadcast -> page on high),
// and fail-soft behavior (scan_failed, never throws).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  listThreadMessages: vi.fn(),
  updateThreadMessageScan: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);

// Integration slice: work item + care-team notifications + email policy all
// flow through workQueue.service.enqueueWorkItem (single choke point).
const { enqueueWorkItemMock } = vi.hoisted(() => ({ enqueueWorkItemMock: vi.fn() }));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: enqueueWorkItemMock }));

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));

const { analyzeStandaloneRiskMock } = vi.hoisted(() => ({ analyzeStandaloneRiskMock: vi.fn() }));
vi.mock('./crisisDetection.service.js', () => ({
  analyzeStandaloneRisk: analyzeStandaloneRiskMock,
}));

const { sendCrisisAlertMock } = vi.hoisted(() => ({ sendCrisisAlertMock: vi.fn() }));
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: sendCrisisAlertMock }));

const { broadcastAdminEventMock } = vi.hoisted(() => ({ broadcastAdminEventMock: vi.fn() }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEvent: broadcastAdminEventMock }));

import { scanThreadMessage, userRoom } from './messageSafety.service.js';
import type { MessageThreadRow, ThreadMessageRow } from '../db/messaging.queries.js';

function thread(overrides: Partial<MessageThreadRow> = {}): MessageThreadRow {
  return {
    thread_id: 5,
    org_id: 1,
    client_id: 42,
    clinician_id: 9,
    clinician_role: 'caseworker',
    status: 'active',
    frozen_at: null,
    frozen_reason: null,
    is_sandbox: false,
    created_at: '2026-08-27T00:00:00Z',
    last_message_at: null,
    ...overrides,
  };
}

function message(overrides: Partial<ThreadMessageRow> = {}): ThreadMessageRow {
  return {
    message_id: 101,
    thread_id: 5,
    sender_id: 42,
    sender_role: 'participant',
    body: 'hello',
    created_at: '2026-08-27T00:00:01Z',
    risk_score: null,
    risk_severity: null,
    scan_status: 'pending',
    crisis_event_id: null,
    ...overrides,
  };
}

const emitMock = vi.fn();
const toMock = vi.fn(() => ({ emit: emitMock }));

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.listThreadMessages.mockResolvedValue([]);
  dbMocks.updateThreadMessageScan.mockResolvedValue(undefined);
  enqueueWorkItemMock.mockResolvedValue({ item_id: 77 });
  poolQueryMock.mockResolvedValue({ rows: [{ event_id: 900 }] });
  sendCrisisAlertMock.mockResolvedValue(undefined);
  broadcastAdminEventMock.mockResolvedValue(undefined);
  // @ts-expect-error minimal socket.io stand-in
  global.io = { to: toMock };
});

describe('userRoom', () => {
  it('formats the per-user messaging room name', () => {
    expect(userRoom(42)).toBe('user:42');
  });
});

describe('scanThreadMessage', () => {
  it('short-circuits sandbox threads to not_applicable without analyzing', async () => {
    await scanThreadMessage(message(), thread({ is_sandbox: true }));
    expect(dbMocks.updateThreadMessageScan).toHaveBeenCalledWith(101, { scanStatus: 'not_applicable' });
    expect(analyzeStandaloneRiskMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    // Participant still gets the scanned echo (flagged: false).
    expect(toMock).toHaveBeenCalledWith('user:42');
    expect(emitMock).toHaveBeenCalledWith('messaging:message-scanned', {
      threadId: 5, messageId: 101, flagged: false,
    });
  });

  it('marks a no-risk message clear with no crisis machinery', async () => {
    analyzeStandaloneRiskMock.mockResolvedValue({
      riskScore: 0, severity: 'none', factors: [], method: 'keyword_only',
    });
    await scanThreadMessage(message(), thread());
    expect(dbMocks.updateThreadMessageScan).toHaveBeenCalledWith(101, {
      scanStatus: 'clear', riskScore: 0, riskSeverity: null,
    });
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('records low severity on the message but does not flag', async () => {
    analyzeStandaloneRiskMock.mockResolvedValue({
      riskScore: 20, severity: 'low', factors: ['hopelessness'], method: 'llm_assessed',
    });
    await scanThreadMessage(message(), thread());
    expect(dbMocks.updateThreadMessageScan).toHaveBeenCalledWith(101, {
      scanStatus: 'clear', riskScore: 20, riskSeverity: 'low',
    });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('medium severity: crisis event + flagged scan + warning work item + notifications, no page', async () => {
    analyzeStandaloneRiskMock.mockResolvedValue({
      riskScore: 55, severity: 'medium', factors: ['passive ideation'], method: 'llm_assessed',
    });
    await scanThreadMessage(message(), thread());

    // Crisis event insert: origin='thread_message', session_id absent.
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain(`'thread_message'`);
    expect(sql).toContain('crisis_events');
    expect(params).toEqual([
      101, 42, 'medium', 55, JSON.stringify(['passive ideation']),
      'Message risk score: 55 - Factors: passive ideation',
    ]);

    expect(dbMocks.updateThreadMessageScan).toHaveBeenCalledWith(101, {
      scanStatus: 'flagged', riskScore: 55, riskSeverity: 'medium', crisisEventId: 900,
    });

    // Single choke point: enqueueWorkItem owns the care-team notifications
    // and email policy; its payload must never carry the message body.
    expect(enqueueWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 1, clientId: 42, itemType: 'message_crisis', severity: 'warning',
      sourceTable: 'thread_messages', sourceId: '101',
    }));
    expect(JSON.stringify(enqueueWorkItemMock.mock.calls[0][0])).not.toContain('hello');

    // Summary-tier broadcast, keyed on the client, body-free.
    expect(broadcastAdminEventMock).toHaveBeenCalledWith(
      global.io, 'message:crisis-detected',
      expect.objectContaining({ clientId: 42, threadId: 5, messageId: 101, severity: 'medium' }),
      42, 'summary',
    );
    expect(JSON.stringify(broadcastAdminEventMock.mock.calls[0][2])).not.toContain('hello');

    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith('messaging:message-scanned', {
      threadId: 5, messageId: 101, flagged: true,
    });
  });

  it('high severity: urgent work item and pages the on-call without PHI', async () => {
    analyzeStandaloneRiskMock.mockResolvedValue({
      riskScore: 85, severity: 'high', factors: ['active ideation'], method: 'llm_assessed',
    });
    await scanThreadMessage(message({ body: 'secret content' }), thread());
    expect(enqueueWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ severity: 'urgent' }));
    expect(JSON.stringify(enqueueWorkItemMock.mock.calls[0][0])).not.toContain('secret content');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    const pageText = sendCrisisAlertMock.mock.calls[0][0] as string;
    expect(pageText).toContain('85');
    expect(pageText).not.toContain('secret content');
  });

  it('excludes the scanned message itself from the LLM history lines', async () => {
    dbMocks.listThreadMessages.mockResolvedValue([
      message({ message_id: 100, body: 'earlier turn', sender_role: 'caseworker' }),
      message({ message_id: 101, body: 'current turn' }),
    ]);
    analyzeStandaloneRiskMock.mockResolvedValue({
      riskScore: 0, severity: 'none', factors: [], method: 'keyword_only',
    });
    await scanThreadMessage(message({ message_id: 101, body: 'current turn' }), thread());
    expect(analyzeStandaloneRiskMock).toHaveBeenCalledWith('current turn', [
      { role: 'assistant', content: 'earlier turn' },
    ]);
  });

  it('marks scan_failed and swallows the error when analysis throws', async () => {
    analyzeStandaloneRiskMock.mockRejectedValue(new Error('LLM exploded'));
    await expect(scanThreadMessage(message(), thread())).resolves.toBeUndefined();
    expect(dbMocks.updateThreadMessageScan).toHaveBeenCalledWith(101, { scanStatus: 'scan_failed' });
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
  });

  it('a queue failure (enqueueWorkItem -> null) does not stop the page', async () => {
    analyzeStandaloneRiskMock.mockResolvedValue({
      riskScore: 85, severity: 'high', factors: [], method: 'keyword_fallback',
    });
    // enqueueWorkItem never throws; internal failures surface as null.
    enqueueWorkItemMock.mockResolvedValueOnce(null);
    await scanThreadMessage(message(), thread());
    expect(sendCrisisAlertMock).toHaveBeenCalled();
  });
});
