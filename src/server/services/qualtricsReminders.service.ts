// App-driven survey reminder emails, sent through Qualtrics as the mailer
// (Qualtrics ops). Rolling enrollment means each participant's study weeks
// are anchored to their own enrollment date, so Qualtrics' list-wide
// scheduled distributions can't do this — the app computes who is due
// (surveySchedule.service) and asks Qualtrics to send one individual-link
// email per due survey. At most one invite and one 48h follow-up per
// (participant, survey, week), guaranteed by the survey_reminders ledger.
//
// Contact email comes from the baseline survey's BEMAIL answer (QID35_TEXT,
// verified against the live survey 2026-09-04) — it stays in the synced
// response payload; no email column is added to users.
//
// Configuration (plain env, ships dark until all are set):
//   QUALTRICS_DIRECTORY_ID   e.g. POOL_...
//   QUALTRICS_MAILING_LIST_ID e.g. CG_...
//   QUALTRICS_LIBRARY_ID     e.g. UR_...
//   QUALTRICS_REMINDER_MESSAGE_ID e.g. MS_...
//   (plus the base sync config: QUALTRICS_API_TOKEN + survey ids)
import { pool } from '../config/db.js';
import { getQualtricsSyncConfig, type QualtricsSyncConfig } from './qualtricsSync.service.js';
import { getParticipantSurveySchedule, type DueSurvey } from './surveySchedule.service.js';
import { getEnrolledParticipants } from '../db/index.js';

// VERIFY after any baseline-survey rebuild (same rule as every QID map).
const BASELINE_EMAIL_KEY = 'QID35_TEXT';

const FOLLOWUP_AFTER_MS = 48 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly tick; ledger makes it idempotent

const SURVEY_META: Record<string, { label: string; minutes: string }> = {
  weekly: { label: 'weekly 5-minute check-in', minutes: '5' },
  exit: { label: 'exit survey', minutes: '20' },
  week12: { label: 'Week 12 follow-up survey', minutes: '5' },
};

export interface ReminderConfig extends QualtricsSyncConfig {
  directoryId: string;
  mailingListId: string;
  libraryId: string;
  messageId: string;
}

export function getReminderConfig(): ReminderConfig | null {
  const base = getQualtricsSyncConfig();
  const directoryId = process.env.QUALTRICS_DIRECTORY_ID;
  const mailingListId = process.env.QUALTRICS_MAILING_LIST_ID;
  const libraryId = process.env.QUALTRICS_LIBRARY_ID;
  const messageId = process.env.QUALTRICS_REMINDER_MESSAGE_ID;
  if (!base || !directoryId || !mailingListId || !libraryId || !messageId) return null;
  return { ...base, directoryId, mailingListId, libraryId, messageId };
}

async function api(
  config: ReminderConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`https://${config.datacenter}.qualtrics.com/API/v3${path}`, {
    method,
    headers: {
      'X-API-TOKEN': config.apiToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

async function getBaselineEmail(userId: number): Promise<string | null> {
  const { rows } = await pool.query<{ email: string | null }>(
    `SELECT answers->>$2 AS email
       FROM qualtrics_responses
      WHERE user_id = $1 AND survey_role = 'baseline' AND finished
      ORDER BY recorded_at ASC NULLS LAST LIMIT 1`,
    [userId, BASELINE_EMAIL_KEY]
  );
  const email = rows[0]?.email?.trim() ?? null;
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

/** Create or refresh the participant's directory contact; returns contactId. */
async function upsertContact(
  config: ReminderConfig,
  userId: number,
  email: string,
  due: DueSurvey
): Promise<string | null> {
  const meta = SURVEY_META[due.role] ?? { label: due.label, minutes: '5' };
  const embeddedData = {
    sid: String(userId),
    surveyLabel: due.week ? `week ${due.week} check-in survey` : meta.label,
    surveyMinutes: meta.minutes,
  };
  const existing = await pool.query<{ contact_id: string; email: string }>(
    `SELECT contact_id, email FROM qualtrics_contacts WHERE user_id = $1`,
    [userId]
  );
  const row = existing.rows[0];
  if (row) {
    const res = await api(
      config,
      'PUT',
      `/directories/${config.directoryId}/mailinglists/${config.mailingListId}/contacts/${row.contact_id}`,
      { email, embeddedData }
    );
    if (res.ok) {
      if (row.email !== email) {
        await pool.query(`UPDATE qualtrics_contacts SET email = $2, updated_at = now() WHERE user_id = $1`, [userId, email]);
      }
      return row.contact_id;
    }
    // fall through to re-create on e.g. contact deleted remotely
  }
  const res = await api(
    config,
    'POST',
    `/directories/${config.directoryId}/mailinglists/${config.mailingListId}/contacts`,
    { email, extRef: String(userId), embeddedData }
  );
  if (!res.ok) {
    console.error(`[QualtricsReminders] contact upsert failed for user ${userId}: HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { result?: { id?: string; contactLookupId?: string } };
  const contactId = body.result?.id ?? null;
  if (!contactId) return null;
  await pool.query(
    `INSERT INTO qualtrics_contacts (user_id, contact_id, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET contact_id = EXCLUDED.contact_id, email = EXCLUDED.email, updated_at = now()`,
    [userId, contactId, email]
  );
  return contactId;
}

async function sendDistribution(
  config: ReminderConfig,
  surveyId: string,
  contactId: string,
  subject: string
): Promise<string | null> {
  const res = await api(config, 'POST', '/distributions', {
    message: { libraryId: config.libraryId, messageId: config.messageId },
    recipients: { mailingListId: config.mailingListId, contactId },
    header: {
      fromEmail: 'noreply@qemailserver.com',
      fromName: 'BYU AI Support Agent Study',
      replyToEmail: 'nzb22@byu.edu',
      subject,
    },
    surveyLink: { surveyId, type: 'Individual' },
    sendDate: new Date().toISOString(),
  });
  if (!res.ok) {
    console.error(`[QualtricsReminders] distribution failed: HTTP ${res.status} ${await res.text()}`);
    return null;
  }
  const body = (await res.json()) as { result?: { id?: string } };
  return body.result?.id ?? null;
}

interface LedgerRow {
  kind: 'invite' | 'followup';
  sent_at: Date;
}

/** Decide what (if anything) to send for one due survey. Pure given ledger rows. */
export function nextSendKind(ledger: LedgerRow[], now: Date): 'invite' | 'followup' | null {
  const invite = ledger.find((l) => l.kind === 'invite');
  if (!invite) return 'invite';
  const followup = ledger.find((l) => l.kind === 'followup');
  if (followup) return null;
  return now.getTime() - invite.sent_at.getTime() >= FOLLOWUP_AFTER_MS ? 'followup' : null;
}

export interface ReminderSweepResult {
  participants: number;
  sent: number;
  skippedNoEmail: number;
  failures: number;
}

/** One sweep: for every enrolled, active participant with due surveys, send
 *  whatever the ledger allows. Idempotent — the unique ledger row is written
 *  before Qualtrics is called, so a crash can suppress a send but never
 *  duplicate one. */
export async function sweepSurveyReminders(now: Date = new Date()): Promise<ReminderSweepResult> {
  const config = getReminderConfig();
  const result: ReminderSweepResult = { participants: 0, sent: 0, skippedNoEmail: 0, failures: 0 };
  if (!config) return result;

  const enrolled = await getEnrolledParticipants();
  for (const participant of enrolled) {
    const status = await pool.query<{ study_status: string; is_sandbox: boolean | null }>(
      `SELECT study_status, is_sandbox FROM users WHERE userid = $1`,
      [participant.userId]
    );
    const row = status.rows[0];
    if (!row || row.study_status !== 'active' || row.is_sandbox) continue;

    const schedule = await getParticipantSurveySchedule(participant.userId, now);
    if (!schedule.enrolled || schedule.due.length === 0) continue;
    result.participants++;

    const email = await getBaselineEmail(participant.userId);
    if (!email) {
      result.skippedNoEmail++;
      continue;
    }

    for (const due of schedule.due) {
      const week = due.week ?? 0;
      const { rows: ledger } = await pool.query<LedgerRow>(
        `SELECT kind, sent_at FROM survey_reminders
          WHERE user_id = $1 AND survey_role = $2 AND week = $3`,
        [participant.userId, due.role, week]
      );
      const kind = nextSendKind(ledger, now);
      if (!kind) continue;

      // Claim the ledger slot first (unique constraint = cross-container dedupe).
      const claim = await pool.query(
        `INSERT INTO survey_reminders (user_id, survey_role, week, kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, survey_role, week, kind) DO NOTHING
         RETURNING reminder_id`,
        [participant.userId, due.role, week, kind]
      );
      if (claim.rows.length === 0) continue; // another container got it

      try {
        const contactId = await upsertContact(config, participant.userId, email, due);
        if (!contactId) throw new Error('contact upsert failed');
        const surveyId = config.surveys[due.role];
        if (!surveyId) throw new Error(`no survey id for role ${due.role}`);
        const subject =
          kind === 'followup'
            ? `Reminder: your ${due.label} is still open — AI Support Agent Study`
            : `Your ${due.label} is ready — AI Support Agent Study`;
        const distributionId = await sendDistribution(config, surveyId, contactId, subject);
        if (!distributionId) throw new Error('distribution create failed');
        await pool.query(`UPDATE survey_reminders SET distribution_id = $2 WHERE reminder_id = $1`, [
          claim.rows[0].reminder_id,
          distributionId,
        ]);
        result.sent++;
      } catch (err) {
        result.failures++;
        console.error(
          `[QualtricsReminders] send failed (user ${participant.userId}, ${due.role} w${week} ${kind}):`,
          err
        );
        // Release the claim so the next sweep retries.
        await pool.query(`DELETE FROM survey_reminders WHERE reminder_id = $1`, [claim.rows[0].reminder_id])
          .catch(() => {});
      }
    }
  }
  if (result.sent > 0 || result.failures > 0) {
    console.log(
      `[QualtricsReminders] sweep: ${result.sent} sent, ${result.failures} failed, ` +
        `${result.skippedNoEmail} without email (of ${result.participants} due)`
    );
  }
  return result;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startSurveyReminderScheduler(): void {
  if (sweepTimer) return;
  if (!getReminderConfig()) return; // ships dark until env is set
  sweepTimer = setInterval(() => {
    sweepSurveyReminders().catch((err) => console.error('[QualtricsReminders] sweep failed:', err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  sweepSurveyReminders().catch((err) => console.error('[QualtricsReminders] initial sweep failed:', err));
  console.log('[QualtricsReminders] scheduler started (hourly sweep)');
}

export function stopSurveyReminderScheduler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
