// Survey reminders: env gating, the invite -> 48h followup -> stop ladder,
// ledger-first claiming (never duplicate on crash/blue-green overlap), and
// skip rules (inactive/sandbox/no-email participants).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const { enrolledMock } = vi.hoisted(() => ({ enrolledMock: vi.fn() }));
vi.mock('../db/index.js', () => ({ getEnrolledParticipants: enrolledMock }));

const { scheduleMock } = vi.hoisted(() => ({ scheduleMock: vi.fn() }));
vi.mock('./surveySchedule.service.js', () => ({ getParticipantSurveySchedule: scheduleMock }));

const { syncConfigMock } = vi.hoisted(() => ({ syncConfigMock: vi.fn() }));
vi.mock('./qualtricsSync.service.js', () => ({ getQualtricsSyncConfig: syncConfigMock }));

import { nextSendKind, sweepSurveyReminders, getReminderConfig } from './qualtricsReminders.service.js';

const NOW = new Date('2026-09-10T18:00:00Z');
const H = 60 * 60 * 1000;

const ENV_KEYS = [
  'QUALTRICS_DIRECTORY_ID',
  'QUALTRICS_MAILING_LIST_ID',
  'QUALTRICS_LIBRARY_ID',
  'QUALTRICS_REMINDER_MESSAGE_ID',
];

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  queryMock.mockReset();
  enrolledMock.mockReset();
  scheduleMock.mockReset();
  syncConfigMock.mockReset();
  vi.unstubAllEnvs();
});

describe('nextSendKind', () => {
  it('walks invite -> (48h) -> followup -> stop', () => {
    expect(nextSendKind([], NOW)).toBe('invite');
    expect(nextSendKind([{ kind: 'invite', sent_at: new Date(NOW.getTime() - 12 * H) }], NOW)).toBeNull();
    expect(nextSendKind([{ kind: 'invite', sent_at: new Date(NOW.getTime() - 49 * H) }], NOW)).toBe('followup');
    expect(
      nextSendKind(
        [
          { kind: 'invite', sent_at: new Date(NOW.getTime() - 100 * H) },
          { kind: 'followup', sent_at: new Date(NOW.getTime() - 50 * H) },
        ],
        NOW
      )
    ).toBeNull();
  });
});

describe('getReminderConfig / sweep gating', () => {
  it('ships dark unless every id is configured', async () => {
    syncConfigMock.mockReturnValue({ apiToken: 't', datacenter: 'dc', surveys: { weekly: 'SV_w' } });
    for (const k of ENV_KEYS) vi.stubEnv(k, '');
    expect(getReminderConfig()).toBeNull();
    const result = await sweepSurveyReminders(NOW);
    expect(result).toEqual({ participants: 0, sent: 0, skippedNoEmail: 0, failures: 0 });
    expect(enrolledMock).not.toHaveBeenCalled();
  });
});

describe('sweepSurveyReminders', () => {
  function configureEnv() {
    syncConfigMock.mockReturnValue({ apiToken: 't', datacenter: 'dc', surveys: { weekly: 'SV_w' } });
    vi.stubEnv('QUALTRICS_DIRECTORY_ID', 'POOL_1');
    vi.stubEnv('QUALTRICS_MAILING_LIST_ID', 'CG_1');
    vi.stubEnv('QUALTRICS_LIBRARY_ID', 'UR_1');
    vi.stubEnv('QUALTRICS_REMINDER_MESSAGE_ID', 'MS_1');
  }

  it('sends an invite for a due weekly survey and records the distribution', async () => {
    configureEnv();
    enrolledMock.mockResolvedValue([{ userId: 42, username: 'p42', enrolledAt: new Date() }]);
    scheduleMock.mockResolvedValue({
      enrolled: true,
      studyWeek: 2,
      due: [{ role: 'weekly', week: 2, label: 'Week 2 check-in', url: 'x' }],
    });
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT study_status')) return { rows: [{ study_status: 'active', is_sandbox: false }] };
      if (sql.includes("survey_role = 'baseline'")) return { rows: [{ email: 'p42@example.edu' }] };
      if (sql.includes('SELECT kind, sent_at')) return { rows: [] };
      if (sql.includes('INSERT INTO survey_reminders')) return { rows: [{ reminder_id: 1 }] };
      if (sql.includes('SELECT contact_id')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'CID_1' } }), { status: 200 })) // contact create
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'EMD_1' } }), { status: 200 })); // distribution

    const result = await sweepSurveyReminders(NOW);

    expect(result).toMatchObject({ participants: 1, sent: 1, failures: 0 });
    const distCall = fetchMock.mock.calls[1];
    expect(distCall[0]).toContain('/distributions');
    const body = JSON.parse(distCall[1].body);
    expect(body.surveyLink).toEqual({ surveyId: 'SV_w', type: 'Individual' });
    expect(body.recipients).toEqual({ mailingListId: 'CG_1', contactId: 'CID_1' });
  });

  it('skips inactive/sandbox participants and counts missing emails', async () => {
    configureEnv();
    enrolledMock.mockResolvedValue([
      { userId: 1, username: 'withdrawn', enrolledAt: new Date() },
      { userId: 2, username: 'noemail', enrolledAt: new Date() },
    ]);
    scheduleMock.mockResolvedValue({
      enrolled: true,
      studyWeek: 1,
      due: [{ role: 'weekly', week: 1, label: 'Week 1 check-in', url: 'x' }],
    });
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT study_status')) {
        return params[0] === 1
          ? { rows: [{ study_status: 'withdrawn', is_sandbox: false }] }
          : { rows: [{ study_status: 'active', is_sandbox: false }] };
      }
      if (sql.includes("survey_role = 'baseline'")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });

    const result = await sweepSurveyReminders(NOW);
    expect(result).toMatchObject({ participants: 1, sent: 0, skippedNoEmail: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases the ledger claim when the send fails so the next sweep retries', async () => {
    configureEnv();
    enrolledMock.mockResolvedValue([{ userId: 9, username: 'p9', enrolledAt: new Date() }]);
    scheduleMock.mockResolvedValue({
      enrolled: true,
      studyWeek: 3,
      due: [{ role: 'weekly', week: 3, label: 'Week 3 check-in', url: 'x' }],
    });
    const deletes: unknown[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT study_status')) return { rows: [{ study_status: 'active', is_sandbox: false }] };
      if (sql.includes("survey_role = 'baseline'")) return { rows: [{ email: 'p9@example.edu' }] };
      if (sql.includes('SELECT kind, sent_at')) return { rows: [] };
      if (sql.includes('INSERT INTO survey_reminders')) return { rows: [{ reminder_id: 77 }] };
      if (sql.includes('SELECT contact_id')) return { rows: [] };
      if (sql.includes('DELETE FROM survey_reminders')) { deletes.push(sql); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    });
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    const result = await sweepSurveyReminders(NOW);
    expect(result).toMatchObject({ sent: 0, failures: 1 });
    expect(deletes).toHaveLength(1);
  });
});
