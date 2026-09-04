#!/usr/bin/env node
// Pre-launch cleanup for Qualtrics test data (ai-therapist-149).
//
// Deletes, on BOTH sides, the artifacts created by preview/E2E testing:
//   Qualtrics: responses whose distributionChannel is 'preview', plus any
//     response linked to a --test-user account (integration test submissions
//     ride the real 'anonymous' channel).
//   App DB:    matching qualtrics_responses rows, work_items and
//     adverse_event_reports derived from them, and for each --test-user the
//     qualtrics_signups row and the account itself.
//
// DRY RUN by default — prints everything it would delete. Pass --execute to
// actually delete. Run with the target env loaded, e.g. on stage:
//   node scripts/wipe-qualtrics-test-data.mjs --test-user qualtrics-e2e-test
//   node scripts/wipe-qualtrics-test-data.mjs --test-user qualtrics-e2e-test --execute
//
// Env: QUALTRICS_API_TOKEN, QUALTRICS_DATACENTER, QUALTRICS_*_SURVEY_ID,
//      DATABASE_URL (+ DATABASE_SSL=true against RDS).
import 'dotenv/config';
import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');
const TEST_USERS = process.argv.flatMap((a, i) =>
  a === '--test-user' && process.argv[i + 1] ? [process.argv[i + 1]] : []
);

const token = process.env.QUALTRICS_API_TOKEN;
const datacenter = process.env.QUALTRICS_DATACENTER || 'byu.pdx1';
if (!token) {
  console.error('QUALTRICS_API_TOKEN is not set');
  process.exit(1);
}
const surveys = Object.entries({
  baseline: process.env.QUALTRICS_BASELINE_SURVEY_ID,
  weekly: process.env.QUALTRICS_WEEKLY_SURVEY_ID,
  exit: process.env.QUALTRICS_EXIT_SURVEY_ID,
  week12: process.env.QUALTRICS_WEEK12_SURVEY_ID,
}).filter(([, id]) => id);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function api(method, path, body) {
  const res = await fetch(`https://${datacenter}.qualtrics.com/API/v3${path}`, {
    method,
    headers: { 'X-API-TOKEN': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function exportResponses(surveyId) {
  const start = await api('POST', `/surveys/${surveyId}/export-responses`, {
    format: 'json',
    compress: false,
  });
  if (!start.ok) throw new Error(`export start HTTP ${start.status}`);
  const { result } = await start.json();
  let fileId;
  for (let i = 0; i < 40; i++) {
    const poll = await api('GET', `/surveys/${surveyId}/export-responses/${result.progressId}`);
    const body = await poll.json();
    if (body.result?.status === 'complete') { fileId = body.result.fileId; break; }
    if (body.result?.status === 'failed') throw new Error('export failed');
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!fileId) throw new Error('export timed out');
  const dl = await api('GET', `/surveys/${surveyId}/export-responses/${fileId}/file`);
  return (await dl.json()).responses ?? [];
}

const testUserIds = new Set();
for (const username of TEST_USERS) {
  const { rows } = await pool.query('SELECT userid FROM users WHERE username = $1', [username]);
  if (rows[0]) testUserIds.add(rows[0].userid);
  else console.warn(`(test user '${username}' not found in this DB — Qualtrics-side sid match still applies)`);
}

const doomed = []; // { surveyId, responseId, reason }
for (const [role, surveyId] of surveys) {
  const responses = await exportResponses(surveyId);
  for (const r of responses) {
    const v = r.values ?? {};
    const sid = typeof v.sid === 'string' ? v.sid.trim() : '';
    if (v.distributionChannel === 'preview') {
      doomed.push({ surveyId, role, responseId: r.responseId, reason: 'preview' });
    } else if (sid && testUserIds.has(Number(sid))) {
      doomed.push({ surveyId, role, responseId: r.responseId, reason: `test user sid=${sid}` });
    }
  }
}

console.log(`${EXECUTE ? 'DELETING' : 'DRY RUN — would delete'}:`);
for (const d of doomed) console.log(`  qualtrics ${d.role} ${d.responseId} (${d.reason})`);
console.log(`  + app rows: qualtrics_responses for those ${doomed.length} response ids`);
console.log(`  + work_items/adverse_event_reports derived from them`);
for (const username of TEST_USERS) {
  console.log(`  + account '${username}' with its qualtrics_signups/work_items rows`);
}

if (!EXECUTE) {
  console.log('\nPass --execute to delete.');
  await pool.end();
  process.exit(0);
}

const responseIds = doomed.map((d) => d.responseId);
for (const d of doomed) {
  const res = await api('DELETE', `/surveys/${d.surveyId}/responses/${d.responseId}`);
  // 404 = already gone (idempotent re-runs)
  if (!res.ok && res.status !== 404) {
    console.error(`  FAILED qualtrics delete ${d.responseId}: HTTP ${res.status}`);
  } else {
    console.log(`  deleted qualtrics ${d.responseId}`);
  }
}

const del = async (label, sql, params) => {
  const r = await pool.query(sql, params);
  console.log(`  deleted ${r.rowCount} ${label}`);
};
if (responseIds.length > 0) {
  await del('adverse_event_reports', `DELETE FROM adverse_event_reports WHERE trigger_source = 'auto_survey' AND session_ref = ANY($1)`, [responseIds.map((r) => `qualtrics:${r}`)]);
  await del('work_items (responses)', `DELETE FROM work_items WHERE source_table = 'qualtrics_responses' AND source_id = ANY($1)`, [responseIds]);
  await del('qualtrics_responses', `DELETE FROM qualtrics_responses WHERE response_id = ANY($1)`, [responseIds]);
}
for (const userId of testUserIds) {
  await del('work_items (client)', 'DELETE FROM work_items WHERE client_id = $1', [userId]);
  await del('qualtrics_signups', 'DELETE FROM qualtrics_signups WHERE user_id = $1', [userId]);
  await del('qualtrics_responses (user)', 'DELETE FROM qualtrics_responses WHERE user_id = $1', [userId]);
  await del('users', 'DELETE FROM users WHERE userid = $1', [userId]);
}
await pool.end();
console.log('Done.');
