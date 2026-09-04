// Participant survey schedule (ai-therapist-149): the app-side half of the
// Qualtrics flow. Enrollment (account minted from the baseline survey via
// /join-study) anchors a fixed protocol calendar — weekly check-ins for study
// weeks 1-8, the exit survey once 8 full weeks have elapsed, and the week-12
// follow-up once 12 have — and each due survey carries a personalized link
// (?sid=<userid>) so the response auto-links on sync with no typed study ID.
//
// Completion truth comes from qualtrics_responses (hourly sync), so a just
// finished survey can stay "due" for up to one sync interval; the client
// treats dismissal as session-local and the next sync reconciles.
import { getQualtricsSyncConfig } from './qualtricsSync.service.js';
import {
  getEnrollmentAnchor,
  getFinishedResponsesForUser,
  type FinishedResponse,
  type QualtricsSurveyRole,
} from '../db/index.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Weekly check-ins run study weeks 1..8 (protocol: 8 x ~5 min). */
const WEEKLY_WEEKS = 8;
const EXIT_AFTER_WEEKS = 8;
const WEEK12_AFTER_WEEKS = 12;

export interface DueSurvey {
  role: QualtricsSurveyRole;
  /** Study week the prompt is for (weekly only). */
  week?: number;
  label: string;
  url: string;
}

export interface ParticipantSurveySchedule {
  enrolled: boolean;
  /** 1-based study week (week 1 = first 7 days after enrollment). */
  studyWeek: number | null;
  due: DueSurvey[];
}

export function buildSurveyUrl(datacenter: string, surveyId: string, userId: number): string {
  return `https://${datacenter}.qualtrics.com/jfe/form/${surveyId}?sid=${userId}`;
}

/** Pure schedule computation, separated for tests. */
export function computeDueSurveys(args: {
  anchor: Date;
  now: Date;
  finished: FinishedResponse[];
  surveys: Partial<Record<QualtricsSurveyRole, string>>;
  datacenter: string;
  userId: number;
}): ParticipantSurveySchedule {
  const { anchor, now, finished, surveys, datacenter, userId } = args;
  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < 0) return { enrolled: true, studyWeek: null, due: [] };
  const weeksElapsed = Math.floor(elapsedMs / WEEK_MS);
  const studyWeek = weeksElapsed + 1;
  const due: DueSurvey[] = [];

  // Weekly check-in for the current week, unless already completed inside
  // this week's window. Past-week misses are not re-prompted: the instrument
  // asks about "this week", so a late fill would measure the wrong window.
  if (studyWeek <= WEEKLY_WEEKS && surveys.weekly) {
    const windowStart = anchor.getTime() + (studyWeek - 1) * WEEK_MS;
    const doneThisWeek = finished.some(
      (r) =>
        r.surveyRole === 'weekly' &&
        r.recordedAt !== null &&
        r.recordedAt.getTime() >= windowStart &&
        r.recordedAt.getTime() < windowStart + WEEK_MS
    );
    if (!doneThisWeek) {
      due.push({
        role: 'weekly',
        week: studyWeek,
        label: `Week ${studyWeek} check-in`,
        url: buildSurveyUrl(datacenter, surveys.weekly, userId),
      });
    }
  }

  const hasFinished = (role: QualtricsSurveyRole) => finished.some((r) => r.surveyRole === role);

  // Exit stays due until completed, even past week 12 — it is the primary
  // endpoint and always listed ahead of the follow-up.
  if (weeksElapsed >= EXIT_AFTER_WEEKS && surveys.exit && !hasFinished('exit')) {
    due.push({
      role: 'exit',
      label: 'Exit survey (end of Week 8)',
      url: buildSurveyUrl(datacenter, surveys.exit, userId),
    });
  }

  if (weeksElapsed >= WEEK12_AFTER_WEEKS && surveys.week12 && !hasFinished('week12')) {
    due.push({
      role: 'week12',
      label: 'Week 12 follow-up',
      url: buildSurveyUrl(datacenter, surveys.week12, userId),
    });
  }

  return { enrolled: true, studyWeek, due };
}

/**
 * Schedule for one participant, or a disabled result when the Qualtrics
 * integration is unconfigured / the user was not enrolled via the baseline
 * survey (staff, sandbox, and legacy accounts have no qualtrics_signups row).
 */
export async function getParticipantSurveySchedule(
  userId: number,
  now: Date = new Date()
): Promise<ParticipantSurveySchedule> {
  const config = getQualtricsSyncConfig();
  if (!config) return { enrolled: false, studyWeek: null, due: [] };
  const anchor = await getEnrollmentAnchor(userId);
  if (!anchor) return { enrolled: false, studyWeek: null, due: [] };
  const finished = await getFinishedResponsesForUser(userId);
  return computeDueSurveys({
    anchor,
    now,
    finished,
    surveys: config.surveys,
    datacenter: config.datacenter,
    userId,
  });
}
