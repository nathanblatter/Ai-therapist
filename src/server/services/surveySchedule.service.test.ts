// Survey schedule: protocol-calendar math (weekly weeks 1-8, exit after 8
// full weeks, week-12 follow-up after 12), window-scoped weekly completion,
// personalized link construction, and the disabled paths (unconfigured env,
// not survey-enrolled).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getEnrollmentAnchor: vi.fn(),
  getFinishedResponsesForUser: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);

import {
  computeDueSurveys,
  getParticipantSurveySchedule,
  buildSurveyUrl,
} from './surveySchedule.service.js';

const DAY = 24 * 60 * 60 * 1000;
const ANCHOR = new Date('2026-09-01T12:00:00Z');
const SURVEYS = { weekly: 'SV_wk', exit: 'SV_ex', week12: 'SV_w12' };

function schedule(daysElapsed: number, finished: Array<{ surveyRole: string; recordedAt: Date | null }> = []) {
  return computeDueSurveys({
    anchor: ANCHOR,
    now: new Date(ANCHOR.getTime() + daysElapsed * DAY),
    finished: finished as never,
    surveys: SURVEYS,
    datacenter: 'byu.pdx1',
    userId: 42,
  });
}

describe('computeDueSurveys', () => {
  it('prompts the week 1 check-in immediately after enrollment', () => {
    const result = schedule(1);
    expect(result.studyWeek).toBe(1);
    expect(result.due).toEqual([
      {
        role: 'weekly',
        week: 1,
        label: 'Week 1 check-in',
        url: 'https://byu.pdx1.qualtrics.com/jfe/form/SV_wk?sid=42',
      },
    ]);
  });

  it('clears the weekly prompt once completed inside the current week window', () => {
    const done = [{ surveyRole: 'weekly', recordedAt: new Date(ANCHOR.getTime() + 2 * DAY) }];
    expect(schedule(3, done).due).toEqual([]);
  });

  it('re-prompts the next week even though last week was completed', () => {
    const done = [{ surveyRole: 'weekly', recordedAt: new Date(ANCHOR.getTime() + 2 * DAY) }];
    const result = schedule(8, done);
    expect(result.studyWeek).toBe(2);
    expect(result.due.map((d) => d.week)).toEqual([2]);
  });

  it('ignores weekly completions with no recorded timestamp', () => {
    const done = [{ surveyRole: 'weekly', recordedAt: null }];
    expect(schedule(1, done).due.map((d) => d.role)).toEqual(['weekly']);
  });

  it('stops weekly prompts after week 8 and prompts the exit survey', () => {
    const result = schedule(57); // 8 full weeks + 1 day
    expect(result.studyWeek).toBe(9);
    expect(result.due).toEqual([
      {
        role: 'exit',
        label: 'Exit survey (end of Week 8)',
        url: 'https://byu.pdx1.qualtrics.com/jfe/form/SV_ex?sid=42',
      },
    ]);
  });

  it('clears the exit prompt once an exit response is finished', () => {
    const done = [{ surveyRole: 'exit', recordedAt: new Date(ANCHOR.getTime() + 57 * DAY) }];
    expect(schedule(60, done).due).toEqual([]);
  });

  it('prompts week 12 after 12 weeks, with an unfinished exit listed first', () => {
    const result = schedule(85);
    expect(result.due.map((d) => d.role)).toEqual(['exit', 'week12']);
  });

  it('prompts only week 12 when exit is done', () => {
    const done = [{ surveyRole: 'exit', recordedAt: new Date(ANCHOR.getTime() + 57 * DAY) }];
    expect(schedule(85, done).due.map((d) => d.role)).toEqual(['week12']);
  });

  it('skips roles whose survey id is unconfigured', () => {
    const result = computeDueSurveys({
      anchor: ANCHOR,
      now: new Date(ANCHOR.getTime() + 85 * DAY),
      finished: [],
      surveys: { weekly: 'SV_wk' },
      datacenter: 'byu.pdx1',
      userId: 42,
    });
    expect(result.due).toEqual([]);
  });

  it('returns no prompts for a clock-skewed pre-enrollment now', () => {
    const result = schedule(-1);
    expect(result.due).toEqual([]);
    expect(result.studyWeek).toBeNull();
  });
});

describe('getParticipantSurveySchedule', () => {
  beforeEach(() => {
    vi.stubEnv('QUALTRICS_API_TOKEN', 'tok');
    vi.stubEnv('QUALTRICS_WEEKLY_SURVEY_ID', 'SV_wk');
    vi.stubEnv('QUALTRICS_DATACENTER', 'byu.pdx1');
    dbMocks.getEnrollmentAnchor.mockReset();
    dbMocks.getFinishedResponsesForUser.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is disabled when the integration env is unset', async () => {
    vi.stubEnv('QUALTRICS_API_TOKEN', '');
    const result = await getParticipantSurveySchedule(42);
    expect(result).toEqual({ enrolled: false, studyWeek: null, due: [] });
    expect(dbMocks.getEnrollmentAnchor).not.toHaveBeenCalled();
  });

  it('is disabled for accounts without a survey enrollment', async () => {
    dbMocks.getEnrollmentAnchor.mockResolvedValue(null);
    const result = await getParticipantSurveySchedule(42);
    expect(result).toEqual({ enrolled: false, studyWeek: null, due: [] });
  });

  it('computes the schedule from the enrollment anchor', async () => {
    dbMocks.getEnrollmentAnchor.mockResolvedValue(ANCHOR);
    dbMocks.getFinishedResponsesForUser.mockResolvedValue([]);
    const result = await getParticipantSurveySchedule(42, new Date(ANCHOR.getTime() + DAY));
    expect(result.enrolled).toBe(true);
    expect(result.due.map((d) => d.role)).toEqual(['weekly']);
  });
});

describe('buildSurveyUrl', () => {
  it('builds the jfe link with the sid embedded-data param', () => {
    expect(buildSurveyUrl('byu.pdx1', 'SV_x', 7)).toBe(
      'https://byu.pdx1.qualtrics.com/jfe/form/SV_x?sid=7'
    );
  });
});
