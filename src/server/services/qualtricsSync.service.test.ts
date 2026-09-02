// Qualtrics response sync: env gating, the export create/poll/download flow,
// study-ID extraction, and the linkage ladder (sid embedded data -> typed ID
// -> baseline signup fallback). DB writes are mocked; assertions focus on what
// gets upserted and how responses resolve to users.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  upsertQualtricsResponse: vi.fn(),
  resolveStudySidToUserId: vi.fn(),
  findUserIdForBaselineResponse: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);

import {
  getQualtricsSyncConfig,
  extractTypedStudyId,
  fetchAllResponses,
  syncAllSurveys,
  type QualtricsSyncConfig,
} from './qualtricsSync.service.js';

const CONFIG: QualtricsSyncConfig = {
  apiToken: 'tok',
  datacenter: 'byu.pdx1',
  surveys: { weekly: 'SV_weekly' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('getQualtricsSyncConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of [
      'QUALTRICS_API_TOKEN',
      'QUALTRICS_BASELINE_SURVEY_ID',
      'QUALTRICS_WEEKLY_SURVEY_ID',
      'QUALTRICS_EXIT_SURVEY_ID',
      'QUALTRICS_WEEK12_SURVEY_ID',
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is null without a token or without any survey id', () => {
    delete process.env.QUALTRICS_API_TOKEN;
    expect(getQualtricsSyncConfig()).toBeNull();
    process.env.QUALTRICS_API_TOKEN = 't';
    delete process.env.QUALTRICS_BASELINE_SURVEY_ID;
    delete process.env.QUALTRICS_WEEKLY_SURVEY_ID;
    delete process.env.QUALTRICS_EXIT_SURVEY_ID;
    delete process.env.QUALTRICS_WEEK12_SURVEY_ID;
    expect(getQualtricsSyncConfig()).toBeNull();
  });

  it('collects whichever survey roles are configured', () => {
    process.env.QUALTRICS_API_TOKEN = 't';
    process.env.QUALTRICS_WEEKLY_SURVEY_ID = 'SV_w';
    process.env.QUALTRICS_WEEK12_SURVEY_ID = 'SV_f';
    delete process.env.QUALTRICS_BASELINE_SURVEY_ID;
    delete process.env.QUALTRICS_EXIT_SURVEY_ID;
    expect(getQualtricsSyncConfig()?.surveys).toEqual({ weekly: 'SV_w', week12: 'SV_f' });
  });
});

describe('extractTypedStudyId', () => {
  it('finds a numeric _TEXT answer and ignores prose text answers', () => {
    expect(
      extractTypedStudyId({ QID2_TEXT: ' 23 ', QID9_TEXT: 'I felt sad this week', finished: 1 })
    ).toBe('23');
  });

  it('returns null when nothing looks like a study id', () => {
    expect(extractTypedStudyId({ QID9_TEXT: 'no id here', finished: 1 })).toBeNull();
  });
});

describe('fetchAllResponses', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('runs create -> poll -> download and returns the responses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { result: { progressId: 'PG1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: { status: 'complete', fileId: 'F1' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, { responses: [{ responseId: 'R_1', values: { finished: 1 } }] })
      );

    const responses = await fetchAllResponses(CONFIG, 'SV_weekly');
    expect(responses).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/surveys/SV_weekly/export-responses');
    expect(fetchMock.mock.calls[2][0]).toContain('/export-responses/F1/file');
  });

  it('throws when Qualtrics reports the export failed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { result: { progressId: 'PG1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: { status: 'failed' } }));
    await expect(fetchAllResponses(CONFIG, 'SV_weekly')).rejects.toThrow('failed');
  });
});

describe('syncAllSurveys', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.clearAllMocks();
    dbMocks.resolveStudySidToUserId.mockResolvedValue(null);
    dbMocks.findUserIdForBaselineResponse.mockResolvedValue(null);
    dbMocks.upsertQualtricsResponse.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  function mockExport(responses: unknown[]) {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { result: { progressId: 'PG1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: { status: 'complete', fileId: 'F1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { responses }));
  }

  it('links via sid embedded data first and upserts the response', async () => {
    dbMocks.resolveStudySidToUserId.mockResolvedValue(42);
    mockExport([
      { responseId: 'R_1', values: { finished: 1, recordedDate: '2026-09-02T10:00:00Z', sid: '23' } },
    ]);

    const results = await syncAllSurveys(CONFIG);
    expect(results[0]).toMatchObject({ surveyRole: 'weekly', fetched: 1, upserted: 1, linked: 1 });
    expect(dbMocks.resolveStudySidToUserId).toHaveBeenCalledWith('23');
    expect(dbMocks.upsertQualtricsResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'R_1',
        surveyRole: 'weekly',
        userId: 42,
        studySid: '23',
        finished: true,
        recordedAt: '2026-09-02T10:00:00Z',
      })
    );
  });

  it('falls back to the typed study-ID answer when sid is absent', async () => {
    dbMocks.resolveStudySidToUserId.mockResolvedValue(7);
    mockExport([{ responseId: 'R_2', values: { finished: 1, QID2_TEXT: '7' } }]);

    await syncAllSurveys(CONFIG);
    expect(dbMocks.resolveStudySidToUserId).toHaveBeenCalledWith('7');
    expect(dbMocks.upsertQualtricsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, studySid: '7' })
    );
  });

  it('uses the /join-study signup fallback for baseline responses', async () => {
    dbMocks.findUserIdForBaselineResponse.mockResolvedValue(99);
    mockExport([{ responseId: 'R_3', values: { finished: 1 } }]);

    const config: QualtricsSyncConfig = { ...CONFIG, surveys: { baseline: 'SV_base' } };
    const results = await syncAllSurveys(config);
    expect(dbMocks.findUserIdForBaselineResponse).toHaveBeenCalledWith('R_3');
    expect(results[0].linked).toBe(1);
  });

  it('still upserts unlinked responses (userId null) so nothing is silently dropped', async () => {
    mockExport([{ responseId: 'R_4', values: { finished: 0 } }]);
    const results = await syncAllSurveys(CONFIG);
    expect(results[0]).toMatchObject({ fetched: 1, upserted: 1, linked: 0 });
    expect(dbMocks.upsertQualtricsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, finished: false })
    );
  });

  it('reports per-survey errors without aborting the run', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const results = await syncAllSurveys(CONFIG);
    expect(results[0].error).toBeDefined();
    expect(results[0].upserted).toBe(0);
  });
});
