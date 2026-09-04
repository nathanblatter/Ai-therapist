// Survey-definition drift guard (ai-therapist-149). Instrument scoring
// (qualtricsScoring.service.ts) and adverse-report detection depend on QID
// maps verified against the live Qualtrics surveys, and the survey wording
// itself is an IRB-approved instrument — a silent edit in Qualtrics could
// corrupt scores or drift from the approved protocol. Once a day (claimed
// atomically in system_config so multi-container deploys check once) this
// hashes each configured survey's question structure and opens a work-queue
// item when it differs from the stored baseline. The stored hash updates on
// alert, so each distinct change alerts exactly once.
import { createHash } from 'node:crypto';
import { pool } from '../config/db.js';
import { enqueueWorkItem } from './workQueue.service.js';
import { getQualtricsSyncConfig, type QualtricsSyncConfig } from './qualtricsSync.service.js';
import type { QualtricsSurveyRole } from '../db/index.js';

const HASH_KEY_PREFIX = 'qualtrics.survey_hash.';
const CLAIM_KEY = 'qualtrics.drift_last_check_date';

/** Canonical JSON: objects with sorted keys so hashes are order-independent. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

interface SurveyDefinition {
  Questions?: Record<string, Record<string, unknown>>;
  SurveyFlow?: { Flow?: Array<Record<string, unknown>> };
}

/**
 * Hash the parts of a definition that scoring/triage/IRB-wording depend on:
 * per-question type, text, choices, answers, recodes, and the embedded-data
 * fields declared in the flow. Cosmetic properties (look & feel, validation
 * messages) are deliberately excluded to avoid alert noise.
 */
export function computeSurveyDefinitionHash(definition: SurveyDefinition): string {
  const questions: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(definition.Questions ?? {})) {
    questions[qid] = {
      type: q.QuestionType,
      text: q.QuestionText,
      choices: q.Choices ?? null,
      answers: q.Answers ?? null,
      recodes: q.RecodeValues ?? null,
    };
  }
  const embedded = (definition.SurveyFlow?.Flow ?? [])
    .filter((el) => el.Type === 'EmbeddedData')
    .flatMap((el) => (Array.isArray(el.EmbeddedData) ? el.EmbeddedData : []))
    .map((ed) => (ed as { Field?: string }).Field ?? '')
    .sort();
  return createHash('sha256').update(canonical({ questions, embedded })).digest('hex');
}

async function fetchDefinition(config: QualtricsSyncConfig, surveyId: string): Promise<SurveyDefinition> {
  const res = await fetch(
    `https://${config.datacenter}.qualtrics.com/API/v3/survey-definitions/${surveyId}`,
    { headers: { 'X-API-TOKEN': config.apiToken }, signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) throw new Error(`survey-definition fetch HTTP ${res.status}`);
  const body = (await res.json()) as { result?: SurveyDefinition };
  if (!body.result) throw new Error('survey-definition fetch: empty result');
  return body.result;
}

export interface DriftCheckResult {
  surveyRole: QualtricsSurveyRole;
  surveyId: string;
  outcome: 'baseline-stored' | 'unchanged' | 'drifted' | 'error';
  error?: string;
}

/** Check every configured survey against its stored baseline hash. */
export async function runDriftCheck(): Promise<DriftCheckResult[]> {
  const config = getQualtricsSyncConfig();
  if (!config) return [];
  const results: DriftCheckResult[] = [];

  for (const [surveyRole, surveyId] of Object.entries(config.surveys) as Array<
    [QualtricsSurveyRole, string]
  >) {
    try {
      const hash = computeSurveyDefinitionHash(await fetchDefinition(config, surveyId));
      const key = `${HASH_KEY_PREFIX}${surveyId}`;
      const { rows } = await pool.query(
        'SELECT config_value FROM system_config WHERE config_key = $1',
        [key]
      );
      const stored = rows[0]?.config_value;
      const storedHash = typeof stored === 'string' ? stored : null;

      if (storedHash === hash) {
        results.push({ surveyRole, surveyId, outcome: 'unchanged' });
        continue;
      }

      await pool.query(
        `INSERT INTO system_config (config_key, config_value, description, updated_by)
         VALUES ($1, to_jsonb($2::text), 'Internal: Qualtrics survey-definition hash (drift guard)', 'qualtrics-drift-guard')
         ON CONFLICT (config_key) DO UPDATE
           SET config_value = EXCLUDED.config_value,
               updated_at = CURRENT_TIMESTAMP,
               updated_by = 'qualtrics-drift-guard'`,
        [key, hash]
      );

      if (storedHash === null) {
        results.push({ surveyRole, surveyId, outcome: 'baseline-stored' });
        continue;
      }

      await enqueueWorkItem({
        itemType: 'survey_drift',
        severity: 'warning',
        title: `Qualtrics ${surveyRole} survey definition changed`,
        detail: { surveyRole, surveyId, previousHash: storedHash, newHash: hash },
        sourceTable: 'system_config',
        // Source key includes the new hash so each DISTINCT change files its
        // own idempotent item (re-checks of the same change stay silent).
        sourceId: `${surveyId}:${hash.slice(0, 16)}`,
        clientId: null,
        reopen: true,
      });
      console.warn(`[QualtricsDrift] ${surveyRole} (${surveyId}) definition changed — work item filed`);
      results.push({ surveyRole, surveyId, outcome: 'drifted' });
    } catch (err) {
      console.error(`[QualtricsDrift] check failed for ${surveyRole}:`, err);
      results.push({
        surveyRole,
        surveyId,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Atomically claim today's drift check (America/Denver date) in
 * system_config; only the winning process/container actually runs it.
 */
export async function claimAndRunDailyDriftCheck(): Promise<DriftCheckResult[] | 'already-ran'> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const result = await pool.query(
    `INSERT INTO system_config (config_key, config_value, description, updated_by)
     VALUES ($1, to_jsonb($2::text), 'Internal: last Qualtrics drift-guard check date (America/Denver)', 'qualtrics-drift-guard')
     ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = 'qualtrics-drift-guard'
       WHERE system_config.config_value <> EXCLUDED.config_value
     RETURNING config_key`,
    [CLAIM_KEY, today]
  );
  if ((result.rowCount ?? 0) === 0) return 'already-ran';
  return runDriftCheck();
}
