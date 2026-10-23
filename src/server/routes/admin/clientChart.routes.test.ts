// Clinician chart bundle tests (ai-therapist-199 item 3): role matrix
// (caseworker 403, participant 403, anonymous 401), therapist caseload 404,
// researcher cross-org 404, the single audit row, and the zip manifest. The
// db barrel is mocked; the service and archiver run for real so the test
// unpacks the actual bytes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { inflateRawSync } from 'node:zlib';
import type { Response as SuperagentResponse } from 'superagent';

const dbMocks = vi.hoisted(() => ({
  // users / audit
  getUserById: vi.fn(),
  logDataAccess: vi.fn().mockResolvedValue(undefined),
  // clientChart.queries + reused readers
  getClientSignedNotes: vi.fn(),
  getClientScreeners: vi.fn(),
  getClientSessionSummaries: vi.fn(),
  getClientCrisisEvents: vi.fn(),
  getClientInterventionActions: vi.fn(),
  getUserLatestSafetyPlan: vi.fn(),
  listAssignmentsForClient: vi.fn(),
  listEscalations: vi.fn(),
  // imported by middleware/caseload.ts + middleware/org.ts
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import clientChartRoutes from './clientChart.routes.js';

const CLIENT = { userid: 42, username: 'p42', role: 'participant', organization_id: 5, is_sandbox: false };

const NOTE = {
  note_id: 1,
  org_id: 5,
  client_id: 42,
  author_id: 9,
  author_name: 'Dr T',
  author_role: 'therapist',
  note_type: 'progress',
  case_note_kind: null,
  session_id: 's1',
  seed_source: null,
  seed_model: null,
  content: { subjective: 'Client reported "a rough week"' },
  status: 'signed',
  shared_with_care_team: false,
  signed_at: '2026-10-20T10:00:00Z',
  sign_hash: 'abc123',
  amends_note_id: null,
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
};

function appAs(role: string | null, userId = 9, orgId: number | null = 5) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: `user${userId}`, ...(orgId === null ? {} : { orgId }) }
      : {};
    next();
  });
  app.use(clientChartRoutes());
  return app;
}

// Minimal zip reader: walk the central directory, inflate each entry.
function readZip(buf: Buffer): Record<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    entries[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function binaryParser(res: SuperagentResponse, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

async function download(app: express.Express) {
  return request(app).get('/admin/api/clients/42/chart.zip').buffer(true).parse(binaryParser);
}

const EXPECTED_FULL = [
  'notes.csv',
  'screeners.csv',
  'session_summaries.csv',
  'crisis_history.csv',
  'assignments.csv',
  'escalations.csv',
  'safety_plan.json',
  'README.txt',
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getUserById.mockResolvedValue(CLIENT);
  dbMocks.getOrganizationIdForUser.mockResolvedValue(5);
  dbMocks.getClientSignedNotes.mockResolvedValue([NOTE]);
  dbMocks.getClientScreeners.mockResolvedValue([
    { session_id: 's1', scale: 'phq2', score: 3, answers: [1, 2], created_at: new Date('2026-10-20T09:30:00Z') },
  ]);
  dbMocks.getClientSessionSummaries.mockResolvedValue([
    {
      session_id: 's1',
      session_name: 'Monday',
      session_type: 'realtime',
      modality: 'cbt',
      started_at: new Date('2026-10-20T09:00:00Z'),
      ended_at: new Date('2026-10-20T09:45:00Z'),
      duration_minutes: 45,
      crisis_flagged: true,
      crisis_severity: 'medium',
      summary: { headline: 'Work stress', topics: ['work', 'sleep'], mood_trajectory: 'improving' },
    },
  ]);
  dbMocks.getUserLatestSafetyPlan.mockResolvedValue({
    plan: { warning_signs: ['isolation'], support_contacts: ['Sam 555-0100'] },
    created_at: new Date('2026-10-19T00:00:00Z'),
    session_id: 's0',
  });
  dbMocks.getClientCrisisEvents.mockResolvedValue([
    {
      event_id: 11,
      session_id: 's1',
      origin: 'session',
      event_type: 'flagged',
      severity: 'medium',
      previous_severity: null,
      risk_score: 55,
      previous_risk_score: null,
      triggered_by: 'system',
      trigger_method: 'auto',
      risk_factors: ['hopelessness'],
      notes: 'Participant said "I cannot keep going"',
      created_at: new Date('2026-10-20T09:20:00Z'),
    },
  ]);
  dbMocks.getClientInterventionActions.mockResolvedValue([
    {
      action_id: 21,
      session_id: 's1',
      action_type: 'medium_risk_alert',
      risk_score: 55,
      performed_by: 'system',
      performed_at: new Date('2026-10-20T09:21:00Z'),
      outcome: 'alert sent',
      notes: 'quoted: "keep going"',
    },
  ]);
  dbMocks.listAssignmentsForClient.mockResolvedValue([
    {
      id: 7,
      user_id: 42,
      session_id: null,
      title: 'Worry log',
      description: 'Note each worry.',
      kind: 'worksheet',
      suggested_frequency: 'daily',
      status: 'assigned',
      assigned_at: new Date('2026-10-20T00:00:00Z'),
      completed_at: null,
      completion_note: null,
      source: 'therapist',
      authored_by: 9,
      cancelled_at: null,
      cancelled_by: null,
      cancel_reason: null,
      reissued_from: null,
      authored_by_username: 'user9',
      cancelled_by_username: null,
    },
  ]);
  dbMocks.listEscalations.mockResolvedValue([
    {
      escalation_id: 3,
      org_id: 5,
      client_id: 42,
      raised_by: 9,
      raised_by_role: 'therapist',
      assigned_to: null,
      reason: 'Missed two sessions',
      urgency: 'routine',
      crisis_event_id: null,
      session_id: null,
      note_id: null,
      status: 'open',
      acknowledged_by: null,
      acknowledged_at: null,
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
      created_at: '2026-10-21T00:00:00Z',
      updated_at: '2026-10-21T00:00:00Z',
      client_username: 'p42',
      assigned_username: null,
    },
  ]);
});

describe('role matrix', () => {
  it('401 anonymous', async () => {
    expect((await request(appAs(null)).get('/admin/api/clients/42/chart.zip')).status).toBe(401);
  });

  it('403 caseworker (never receives verbatim clinical content)', async () => {
    const res = await request(appAs('caseworker', 2)).get('/admin/api/clients/42/chart.zip');
    expect(res.status).toBe(403);
    expect(dbMocks.getClientSignedNotes).not.toHaveBeenCalled();
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('403 participant', async () => {
    expect((await request(appAs('participant', 42)).get('/admin/api/clients/42/chart.zip')).status).toBe(403);
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('therapist downloads a full-scope bundle for a caseload client', async () => {
    const res = await download(appAs('therapist', 9));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="client-p42-chart-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(dbMocks.isAssigned).toHaveBeenCalledWith(9, 42);

    const entries = readZip(res.body as Buffer);
    expect(Object.keys(entries)).toEqual(EXPECTED_FULL);

    // Verbatim content present at full scope.
    expect(entries['notes.csv']).toContain('abc123');
    expect(entries['notes.csv']).toContain('a rough week');
    expect(entries['crisis_history.csv']).toContain('I cannot keep going');
    expect(entries['crisis_history.csv']).toContain('alert sent');
    expect(JSON.parse(entries['safety_plan.json']).safety_plan.plan.support_contacts).toEqual(['Sam 555-0100']);
    expect(entries['session_summaries.csv']).toContain('"medium"');
    expect(entries['session_summaries.csv']).toContain('"work; sleep"');
    expect(entries['session_summaries.csv']).not.toContain('soap');
    expect(entries['README.txt']).toContain('Client reference: p42 (id 42)');
    expect(entries['README.txt']).toContain('Exported by: user9 (id 9, role therapist)');
    expect(entries['README.txt']).toContain('Scope: full');
  });

  it('researcher in the same org downloads a summary-scope bundle without verbatim content', async () => {
    const res = await download(appAs('researcher', 3));
    expect(res.status).toBe(200);
    expect(dbMocks.isAssigned).not.toHaveBeenCalled();
    // Escalations are org-scoped for researchers.
    expect(dbMocks.listEscalations).toHaveBeenCalledWith(expect.objectContaining({ clientId: 42, orgId: 5 }));
    expect(dbMocks.getUserLatestSafetyPlan).not.toHaveBeenCalled();

    const entries = readZip(res.body as Buffer);
    expect(Object.keys(entries)).toEqual(EXPECTED_FULL.filter((n) => n !== 'safety_plan.json'));
    expect(entries['notes.csv']).toContain('abc123');
    expect(entries['notes.csv']).not.toContain('a rough week');
    expect(entries['crisis_history.csv']).toContain('flagged');
    expect(entries['crisis_history.csv']).not.toContain('I cannot keep going');
    expect(entries['crisis_history.csv']).not.toContain('keep going');
    expect(entries['crisis_history.csv']).not.toContain('alert sent');
    expect(entries['README.txt']).toContain('Scope: summary');
    expect(entries['README.txt']).toContain('safety_plan.json (participant free text');
  });
});

describe('scoping (404-over-403)', () => {
  it('therapist off-caseload -> 404, nothing read, nothing logged', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist', 9)).get('/admin/api/clients/42/chart.zip');
    expect(res.status).toBe(404);
    expect(dbMocks.getClientSignedNotes).not.toHaveBeenCalled();
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('researcher in another org -> 404', async () => {
    dbMocks.getOrganizationIdForUser.mockResolvedValue(5); // client org
    const res = await request(appAs('researcher', 3, 6)).get('/admin/api/clients/42/chart.zip');
    expect(res.status).toBe(404);
    expect(dbMocks.getClientSignedNotes).not.toHaveBeenCalled();
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('researcher org lookup failure -> 500 (fail closed)', async () => {
    dbMocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3, null)).get('/admin/api/clients/42/chart.zip');
    expect(res.status).toBe(500);
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('unknown user or non-participant -> 404', async () => {
    dbMocks.getUserById.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).get('/admin/api/clients/42/chart.zip')).status).toBe(404);
    dbMocks.getUserById.mockResolvedValue({ ...CLIENT, role: 'therapist' });
    expect((await request(appAs('therapist', 9)).get('/admin/api/clients/42/chart.zip')).status).toBe(404);
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('non-numeric id -> 400', async () => {
    expect((await request(appAs('therapist', 9)).get('/admin/api/clients/abc/chart.zip')).status).toBe(400);
  });
});

describe('audit', () => {
  it('writes exactly one data_access_log row naming the bundle', async () => {
    const res = await download(appAs('therapist', 9));
    expect(res.status).toBe(200);
    expect(dbMocks.logDataAccess).toHaveBeenCalledTimes(1);
    expect(dbMocks.logDataAccess).toHaveBeenCalledWith({
      accessedBy: 9,
      role: 'therapist',
      action: 'export',
      userId: 42,
      detail: expect.objectContaining({
        kind: 'client_chart',
        scope: 'full',
        files: EXPECTED_FULL,
        rowCounts: expect.objectContaining({ 'notes.csv': 1, 'crisis_history.csv': 2, 'safety_plan.json': 1 }),
      }),
    });
  });

  it('does not log when a read fails (500, no audit row for a bundle that never left)', async () => {
    dbMocks.getClientScreeners.mockRejectedValue(new Error('boom'));
    const res = await request(appAs('therapist', 9)).get('/admin/api/clients/42/chart.zip');
    expect(res.status).toBe(500);
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });
});
