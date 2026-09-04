// Qualtrics response sync: env gating, the export create/poll/download flow,
// study-ID extraction, and the linkage ladder (sid embedded data -> typed ID
// -> baseline signup fallback). DB writes are mocked; assertions focus on what
// gets upserted and how responses resolve to users.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  upsertQualtricsResponse: vi.fn(),
  resolveStudySidToUserId: vi.fn(),
  findUserIdForBaselineResponse: vi.fn(),
  insertAdverseEventDraft: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);

const workQueueMocks = vi.hoisted(() => ({ enqueueWorkItem: vi.fn() }));
vi.mock('./workQueue.service.js', () => workQueueMocks);

import {
  getQualtricsSyncConfig,
  extractTypedStudyId,
  detectAdverseReport,
  nextBusinessDay,
  fetchAllResponses,
  syncAllSurveys,
  handleResponseWebhook,
  runSync,
  getSyncRunStatus,
  startQualtricsSyncScheduler,
  stopQualtricsSyncScheduler,
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
    workQueueMocks.enqueueWorkItem.mockReset();
    workQueueMocks.enqueueWorkItem.mockResolvedValue(null);
    dbMocks.insertAdverseEventDraft.mockResolvedValue(101);
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

  it('enqueues an adverse_event work item for a distress report', async () => {
    dbMocks.resolveStudySidToUserId.mockResolvedValue(42);
    mockExport([
      {
        responseId: 'R_adv',
        values: { finished: 1, sid: '42', QID10: 2, QID11_TEXT: 'it upset me' },
      },
    ]);
    await syncAllSurveys(CONFIG);
    expect(workQueueMocks.enqueueWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: 'adverse_event',
        sourceTable: 'qualtrics_responses',
        sourceId: 'R_adv',
        clientId: 42,
        detail: { surveyRole: 'weekly', responseId: 'R_adv', triggers: ['QID10', 'QID11_TEXT'], reportId: 101 },
      })
    );
    // The distress text itself must never leave qualtrics_responses.
    const call = workQueueMocks.enqueueWorkItem.mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain('it upset me');
  });

  it('does not enqueue for clean, unfinished, or preview responses', async () => {
    mockExport([
      { responseId: 'R_clean', values: { finished: 1, QID10: 1 } },
      { responseId: 'R_unfin', values: { finished: 0, QID10: 2 } },
      { responseId: 'R_prev', values: { finished: 1, QID10: 2, distributionChannel: 'preview' } },
    ]);
    await syncAllSurveys(CONFIG);
    expect(workQueueMocks.enqueueWorkItem).not.toHaveBeenCalled();
  });
});

describe('runSync + scheduler', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.clearAllMocks();
    dbMocks.resolveStudySidToUserId.mockResolvedValue(null);
    dbMocks.findUserIdForBaselineResponse.mockResolvedValue(null);
    dbMocks.upsertQualtricsResponse.mockResolvedValue(undefined);
    process.env.QUALTRICS_API_TOKEN = 't';
    process.env.QUALTRICS_WEEKLY_SURVEY_ID = 'SV_w';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    stopQualtricsSyncScheduler();
    delete process.env.QUALTRICS_API_TOKEN;
    delete process.env.QUALTRICS_WEEKLY_SURVEY_ID;
    delete process.env.QUALTRICS_SYNC_INTERVAL_MINUTES;
  });

  function mockExportOnce() {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { result: { progressId: 'PG1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { result: { status: 'complete', fileId: 'F1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { responses: [{ responseId: 'R_1', values: { finished: 1 } }] }));
  }

  it('records last-run state on success', async () => {
    mockExportOnce();
    const results = await runSync('manual');
    expect(results?.[0]).toMatchObject({ surveyRole: 'weekly', fetched: 1 });
    const status = getSyncRunStatus();
    expect(status.lastRunTrigger).toBe('manual');
    expect(status.lastRunAt).toBeTruthy();
    expect(status.lastError).toBeNull();
  });

  it('returns null (never throws config errors) when unconfigured', async () => {
    delete process.env.QUALTRICS_API_TOKEN;
    expect(await runSync('scheduled')).toBeNull();
  });

  it('scheduler is a no-op without QUALTRICS_SYNC_INTERVAL_MINUTES', () => {
    startQualtricsSyncScheduler();
    expect(getSyncRunStatus().schedulerActive).toBe(false);
  });

  it('scheduler activates with a floored-to-5-minutes interval and runs immediately', async () => {
    process.env.QUALTRICS_SYNC_INTERVAL_MINUTES = '1';
    mockExportOnce();
    startQualtricsSyncScheduler();
    const status = getSyncRunStatus();
    expect(status.schedulerActive).toBe(true);
    expect(status.intervalMinutes).toBe(5);
    // the boot-time tick ran
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

describe('detectAdverseReport', () => {
  it('flags weekly bother=Yes and description text separately', () => {
    expect(detectAdverseReport('weekly', { QID10: 2 })).toEqual(['QID10']);
    expect(detectAdverseReport('weekly', { QID11_TEXT: 'something' })).toEqual(['QID11_TEXT']);
    expect(detectAdverseReport('weekly', { QID10: 1, QID11_TEXT: '  ' })).toBeNull();
  });

  it('flags exit free-text reports on either question', () => {
    expect(detectAdverseReport('exit', { QID13_TEXT: 'unhelpful moment' })).toEqual(['QID13_TEXT']);
    expect(detectAdverseReport('exit', { QID14_TEXT: 'crisis handling' })).toEqual(['QID14_TEXT']);
    expect(detectAdverseReport('exit', {})).toBeNull();
  });

  it('flags week12 negative/mixed lasting effects but not positive ones', () => {
    expect(detectAdverseReport('week12', { QID10: 2 })).toEqual(['QID10']);
    expect(detectAdverseReport('week12', { QID10: 3 })).toEqual(['QID10']);
    expect(detectAdverseReport('week12', { QID10: 1 })).toBeNull();
    expect(detectAdverseReport('week12', { QID10: 4 })).toBeNull();
  });

  it('never flags baseline responses', () => {
    expect(detectAdverseReport('baseline', { QID11_TEXT: 'text' })).toBeNull();
  });
});

describe('adverse-event drafting + webhook', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.clearAllMocks();
    vi.stubEnv('QUALTRICS_API_TOKEN', 'tok');
    vi.stubEnv('QUALTRICS_WEEKLY_SURVEY_ID', 'SV_weekly');
    dbMocks.resolveStudySidToUserId.mockResolvedValue(42);
    dbMocks.upsertQualtricsResponse.mockResolvedValue(undefined);
    dbMocks.insertAdverseEventDraft.mockResolvedValue(101);
    workQueueMocks.enqueueWorkItem.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('files an AE draft carrying the description text and links it on the work item', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        result: {
          responseId: 'R_adv',
          values: { finished: 1, sid: '42', QID10: 2, QID11_TEXT: ' it upset me ' },
        },
      })
    );
    const outcome = await handleResponseWebhook('SV_weekly', 'R_adv');
    expect(outcome).toBe('ok');
    expect(dbMocks.insertAdverseEventDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSource: 'auto_survey',
        category: 'survey_report',
        sessionRef: 'qualtrics:R_adv',
        userId: 42,
        transcriptExcerpt: 'it upset me',
      })
    );
    expect(workQueueMocks.enqueueWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ reportId: 101 }) })
    );
  });

  it('still files the work item when the AE draft insert fails', async () => {
    dbMocks.insertAdverseEventDraft.mockRejectedValue(new Error('db down'));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        result: { responseId: 'R_adv2', values: { finished: 1, sid: '42', QID10: 2 } },
      })
    );
    await handleResponseWebhook('SV_weekly', 'R_adv2');
    expect(workQueueMocks.enqueueWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ reportId: null }) })
    );
  });

  it('maps webhook edge cases: unknown survey, missing response, disabled env', async () => {
    expect(await handleResponseWebhook('SV_other', 'R_x')).toBe('unknown-survey');
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    expect(await handleResponseWebhook('SV_weekly', 'R_gone')).toBe('not-found');
    vi.stubEnv('QUALTRICS_API_TOKEN', '');
    expect(await handleResponseWebhook('SV_weekly', 'R_x')).toBe('disabled');
  });
});

describe('nextBusinessDay', () => {
  it('skips weekends', () => {
    // Friday 2026-09-04 UTC -> Monday 2026-09-07
    expect(nextBusinessDay(new Date('2026-09-04T12:00:00Z')).toISOString()).toBe(
      '2026-09-07T12:00:00.000Z'
    );
    // Wednesday -> Thursday
    expect(nextBusinessDay(new Date('2026-09-02T12:00:00Z')).toISOString()).toBe(
      '2026-09-03T12:00:00.000Z'
    );
  });
});
