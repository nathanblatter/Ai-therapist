// Withdrawal D4 deletion requests: remote delete per response, local answers
// blanked to a skeleton (withdrawal keeps structured choices, loses free
// text), one audit row per artifact, remote failures reported not swallowed.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const { insertDeletionLogMock } = vi.hoisted(() => ({ insertDeletionLogMock: vi.fn() }));
vi.mock('../db/dataRetention.queries.js', () => ({
  insertDeletionLog: insertDeletionLogMock,
}));

vi.mock('./qualtricsSync.service.js', () => ({
  getQualtricsSyncConfig: () => ({ apiToken: 'tok', datacenter: 'byu.pdx1', surveys: {} }),
  WITHDRAWAL_KEYS: { reason: 'QID3', details: 'QID4', scope: 'QID5', dataUse: 'QID6' },
}));

import { deleteParticipantSurveyData } from './qualtricsDeletion.service.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  queryMock.mockReset();
  insertDeletionLogMock.mockReset().mockResolvedValue(undefined);
});

function rows(r: unknown[]) {
  queryMock.mockResolvedValueOnce({ rows: r });
  queryMock.mockResolvedValue({ rowCount: 1 }); // subsequent UPDATEs
}

describe('deleteParticipantSurveyData', () => {
  it('deletes remotely, blanks locally, and audits each response', async () => {
    rows([
      { response_id: 'R_w', survey_id: 'SV_weekly', survey_role: 'weekly', answers: { QID8: 4, QID11_TEXT: 'private' } },
      { response_id: 'R_d', survey_id: 'SV_wd', survey_role: 'withdrawal', answers: { QID3: 2, QID4_TEXT: 'my reasons', QID5: 1, QID6: 2 } },
    ]);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const result = await deleteParticipantSurveyData(42, 'nathan');

    expect(result).toMatchObject({ responses: 2, remoteDeleted: 2, remoteFailed: 0, localBlanked: 2 });
    expect(fetchMock.mock.calls[0][0]).toContain('/surveys/SV_weekly/responses/R_w?decrementQuotas=false');
    // weekly row blanks to {}, withdrawal keeps structured choices, drops free text
    const updates = queryMock.mock.calls.slice(1);
    expect(JSON.parse(updates[0][1][1])).toEqual({});
    expect(JSON.parse(updates[1][1][1])).toEqual({ QID3: 2, QID5: 1, QID6: 2 });
    expect(insertDeletionLogMock).toHaveBeenCalledTimes(2);
    expect(insertDeletionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      artifactType: 'survey_response',
      reason: 'participant_request',
      triggeredByUser: 'nathan',
      success: true,
    }));
  });

  it('treats a remote 404 as satisfied, and reports real failures without skipping local blanking', async () => {
    rows([
      { response_id: 'R_1', survey_id: 'SV_a', survey_role: 'weekly', answers: { QID8: 3 } },
      { response_id: 'R_2', survey_id: 'SV_a', survey_role: 'weekly', answers: { QID8: 5 } },
    ]);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    const result = await deleteParticipantSurveyData(7, 'ra');

    expect(result).toMatchObject({ remoteDeleted: 1, remoteFailed: 1, localBlanked: 2 });
    const failLog = insertDeletionLogMock.mock.calls.map((c) => c[0]).find((l) => !l.success);
    expect(failLog).toBeDefined();
  });

  it('is a no-op for a participant with no responses', async () => {
    rows([]);
    const result = await deleteParticipantSurveyData(9, 'ra');
    expect(result).toMatchObject({ responses: 0, remoteDeleted: 0, localBlanked: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
