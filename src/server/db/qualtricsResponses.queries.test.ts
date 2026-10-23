// Qualtrics response linkage queries (ai-therapist-236 chunk 4): the study-id
// guard, participant/sandbox scoping, the finished + linked predicates every
// aggregate depends on, pseudonymised export shapes, and null handling.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import {
  upsertQualtricsResponse,
  resolveStudySidToUserId,
  getEnrollmentAnchor,
  getFinishedResponsesForUser,
  getLinkedSurveyRows,
  getEnrolledParticipants,
  getEnrollmentFunnel,
  getSurveyAnswersForExport,
  findUserIdForBaselineResponse,
  getQualtricsLinkageStats,
  getUnlinkedFinishedResponses,
  getSurveyResponsesExport,
} from './qualtricsResponses.queries.js';

function lastCall(): [string, unknown[] | undefined] {
  return queryMock.mock.calls[queryMock.mock.calls.length - 1] as [string, unknown[] | undefined];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('upsertQualtricsResponse', () => {
  it('keys on response_id, serialises answers, and refreshes linkage on conflict', async () => {
    await upsertQualtricsResponse({
      responseId: 'R_1', surveyId: 'SV_1', surveyRole: 'weekly', userId: 42, studySid: '42',
      finished: true, recordedAt: '2026-01-02T00:00:00Z', answers: { QID1: 3 },
    });
    const [sql, params] = lastCall();
    expect(sql).toContain('INSERT INTO qualtrics_responses');
    expect(sql).toMatch(/\(response_id, survey_id, survey_role, user_id, study_sid, finished, recorded_at, answers, synced_at\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, now\(\)\)/);
    expect(sql).toContain('ON CONFLICT (response_id) DO UPDATE SET');
    for (const col of ['user_id', 'study_sid', 'finished', 'recorded_at', 'answers']) {
      expect(sql).toContain(`${col} = EXCLUDED.${col}`);
    }
    expect(sql).toContain('synced_at = now()');
    // survey_id / survey_role are identity, not refreshed.
    expect(sql).not.toContain('survey_role = EXCLUDED');
    expect(params).toEqual(['R_1', 'SV_1', 'weekly', 42, '42', true, '2026-01-02T00:00:00Z', '{"QID1":3}']);
  });

  it('passes null linkage through for an unlinked response', async () => {
    await upsertQualtricsResponse({
      responseId: 'R_2', surveyId: 'SV_1', surveyRole: 'exit', userId: null, studySid: null,
      finished: false, recordedAt: null, answers: {},
    });
    expect(lastCall()[1]).toEqual(['R_2', 'SV_1', 'exit', null, null, false, null, '{}']);
  });
});

describe('resolveStudySidToUserId', () => {
  it('rejects anything but a short digit string without querying', async () => {
    for (const bad of ['', 'abc', '12a', '-1', '1.5', ' 7', '1234567890', '42; DROP TABLE users']) {
      await expect(resolveStudySidToUserId(bad)).resolves.toBeNull();
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('resolves only non-sandbox participants, by numeric id', async () => {
    queryMock.mockResolvedValue({ rows: [{ userid: 42 }] });
    await expect(resolveStudySidToUserId('042')).resolves.toBe(42);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/SELECT userid FROM users\s+WHERE userid = \$1 AND role = 'participant' AND is_sandbox IS NOT TRUE/);
    expect(params).toEqual([42]);
  });

  it('returns null when no participant matches', async () => {
    await expect(resolveStudySidToUserId('42')).resolves.toBeNull();
  });
});

describe('getEnrollmentAnchor', () => {
  it('returns the earliest signup registration, or null', async () => {
    const anchor = new Date('2026-01-01T00:00:00Z');
    queryMock.mockResolvedValueOnce({ rows: [{ anchor }] });
    await expect(getEnrollmentAnchor(42)).resolves.toBe(anchor);
    expect(lastCall()).toEqual(['SELECT min(registered_at) AS anchor FROM qualtrics_signups WHERE user_id = $1', [42]]);

    queryMock.mockResolvedValueOnce({ rows: [{ anchor: null }] });
    await expect(getEnrollmentAnchor(42)).resolves.toBeNull();
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getEnrollmentAnchor(42)).resolves.toBeNull();
  });
});

describe('getFinishedResponsesForUser', () => {
  it('returns only finished responses for that user', async () => {
    await getFinishedResponsesForUser(42);
    const [sql, params] = lastCall();
    expect(sql).toContain('SELECT survey_role AS "surveyRole", recorded_at AS "recordedAt"');
    expect(sql).toContain('WHERE user_id = $1 AND finished');
    expect(params).toEqual([42]);
  });
});

describe('getLinkedSurveyRows', () => {
  it('requires finished and linked, inner-joins users, oldest first', async () => {
    await getLinkedSurveyRows();
    const [sql, params] = lastCall();
    expect(sql).toContain('JOIN users u ON u.userid = qr.user_id');
    expect(sql).toContain('WHERE qr.finished AND qr.user_id IS NOT NULL');
    expect(sql).toContain('ORDER BY qr.recorded_at ASC');
    expect(sql).toContain('qr.answers');
    expect(params).toBeUndefined();
  });
});

describe('getEnrolledParticipants', () => {
  it('groups signups per linked user with their earliest registration', async () => {
    await getEnrolledParticipants();
    const [sql] = lastCall();
    expect(sql).toContain('min(qs.registered_at) AS "enrolledAt"');
    expect(sql).toContain('JOIN users u ON u.userid = qs.user_id');
    expect(sql).toContain('WHERE qs.user_id IS NOT NULL');
    expect(sql).toMatch(/GROUP BY qs\.user_id, u\.username\s+ORDER BY min\(qs\.registered_at\) ASC/);
  });
});

describe('getEnrollmentFunnel', () => {
  it('coerces the three bigint counts to numbers', async () => {
    queryMock.mockResolvedValue({ rows: [{ baseline: '12', accounts: '9', unlinked: '2' }] });
    await expect(getEnrollmentFunnel()).resolves.toEqual({ baselineFinished: 12, accountsCreated: 9, unlinkedFinished: 2 });
    const [sql] = lastCall();
    expect(sql).toContain("WHERE survey_role = 'baseline' AND finished) AS baseline");
    expect(sql).toContain('WHERE registered_at IS NOT NULL) AS accounts');
    expect(sql).toContain("WHERE finished AND user_id IS NULL AND survey_role <> 'baseline') AS unlinked");
  });
});

describe('export queries', () => {
  const EXPORT_SCOPE = /JOIN research_pseudonyms rp\s+ON rp\.entity_type = 'participant' AND rp\.entity_key = qr\.user_id::text\s+JOIN users u ON u\.userid = qr\.user_id\s+WHERE qr\.finished\s+AND qr\.recorded_at <= \$1::timestamptz\s+AND u\.is_sandbox IS NOT TRUE\s+ORDER BY rp\.pseudonym, qr\.recorded_at/;

  it('getSurveyAnswersForExport keys on the pseudonym, excludes sandbox users, and ships answers', async () => {
    await getSurveyAnswersForExport('2026-03-01T00:00:00Z');
    const [sql, params] = lastCall();
    expect(sql).toContain('rp.pseudonym AS participant_id');
    expect(sql).toContain('qr.answers');
    expect(sql).not.toContain('user_id AS');
    expect(sql).toMatch(EXPORT_SCOPE);
    expect(params).toEqual(['2026-03-01T00:00:00Z']);
  });

  it('getSurveyResponsesExport uses the same scope but never selects the answers payload', async () => {
    await getSurveyResponsesExport('2026-03-01T00:00:00Z');
    const [sql, params] = lastCall();
    expect(sql).toContain('rp.pseudonym AS participant_id');
    expect(sql).toContain('qr.finished,');
    expect(sql).not.toContain('answers');
    expect(sql).not.toContain('username');
    expect(sql).toMatch(EXPORT_SCOPE);
    expect(params).toEqual(['2026-03-01T00:00:00Z']);
  });
});

describe('findUserIdForBaselineResponse', () => {
  it('looks the signup up by ResponseID and only returns a linked account', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ user_id: 7 }] });
    await expect(findUserIdForBaselineResponse('R_1')).resolves.toBe(7);
    expect(lastCall()).toEqual(['SELECT user_id FROM qualtrics_signups WHERE response_id = $1 AND user_id IS NOT NULL', ['R_1']]);
    await expect(findUserIdForBaselineResponse('R_none')).resolves.toBeNull();
  });
});

describe('getQualtricsLinkageStats', () => {
  it('maps per-role counters to camelCase', async () => {
    queryMock.mockResolvedValue({ rows: [
      { survey_role: 'baseline', total: 10, finished: 8, linked: 7, unlinked_finished: 1, last_recorded_at: '2026-02-01T00:00:00Z' },
      { survey_role: 'weekly', total: 0, finished: 0, linked: 0, unlinked_finished: 0, last_recorded_at: null },
    ] });
    await expect(getQualtricsLinkageStats()).resolves.toEqual([
      { surveyRole: 'baseline', total: 10, finished: 8, linked: 7, unlinkedFinished: 1, lastRecordedAt: '2026-02-01T00:00:00Z' },
      { surveyRole: 'weekly', total: 0, finished: 0, linked: 0, unlinkedFinished: 0, lastRecordedAt: null },
    ]);
    const [sql] = lastCall();
    expect(sql).toContain('count(*) FILTER (WHERE finished AND user_id IS NULL)::int AS unlinked_finished');
    expect(sql).toMatch(/GROUP BY survey_role\s+ORDER BY survey_role/);
  });
});

describe('getUnlinkedFinishedResponses', () => {
  it('lists finished-but-unlinked responses newest first, default limit 50', async () => {
    queryMock.mockResolvedValue({ rows: [
      { response_id: 'R_9', survey_role: 'exit', study_sid: 'zz', recorded_at: '2026-02-01T00:00:00Z' },
      { response_id: 'R_8', survey_role: 'weekly', study_sid: null, recorded_at: null },
    ] });
    await expect(getUnlinkedFinishedResponses()).resolves.toEqual([
      { responseId: 'R_9', surveyRole: 'exit', studySid: 'zz', recordedAt: '2026-02-01T00:00:00Z' },
      { responseId: 'R_8', surveyRole: 'weekly', studySid: null, recordedAt: null },
    ]);
    const [sql, params] = lastCall();
    expect(sql).toContain('WHERE finished AND user_id IS NULL');
    expect(sql).toMatch(/ORDER BY recorded_at DESC NULLS LAST\s+LIMIT \$1/);
    expect(params).toEqual([50]);

    await getUnlinkedFinishedResponses(5);
    expect(lastCall()[1]).toEqual([5]);
  });
});
