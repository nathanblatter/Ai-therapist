// Participant simulation — phase 5: copy the complete "Jordan" record from the
// local scratch DB into the STAGE database (additive only; one transaction).
// Serial PKs are re-assigned by stage; user_id and message_id references are
// remapped; research_pseudonyms are NOT copied (stage's export assigns its own).
//
//   npx tsx scripts/participant-sim/copy-to-stage.ts [--dry-run]
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const SRC = 'postgresql://nathanblatter@/ai_therapist_participant_sim?host=/tmp';
const stageEnv = readFileSync('/Users/nathanblatter/deploy/Ai-therapist/.env', 'utf8');
const stageUrl = stageEnv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace('host.docker.internal', '127.0.0.1');
if (!stageUrl) throw new Error('stage DATABASE_URL not found');

const src = new pg.Pool({ connectionString: SRC });
const dstPool = new pg.Pool({ connectionString: stageUrl });

const SIM_UID = 3;

// (table, filter-kind) in FK-safe order. filter: 'user' = user_id/userid = SIM_UID,
// 'session' = session_id IN sim sessions, 'special' handled inline.
const TABLES: Array<[string, 'user' | 'session']> = [
  ['qualtrics_signups', 'user'],
  ['qualtrics_responses', 'user'],
  ['therapy_sessions', 'user'],
  ['session_configurations', 'session'],
  ['participant_consents', 'user'],
  ['messages', 'session'],
  ['risk_score_history', 'session'],
  ['risk_check_steps', 'session'],
  ['tool_invocations', 'session'],
  ['session_evals', 'session'],
  ['session_feedback', 'session'],
  ['session_insights', 'session'],
  ['session_llm_usage', 'session'],
  ['turn_latency', 'session'],
  ['practice_assignments', 'session'],
];

async function columns(pool: pg.Pool, table: string) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, coalesce(column_default,'') AS def
       FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
  return rows as { column_name: string; data_type: string; def: string }[];
}

async function main() {
  const dst = await dstPool.connect();
  const sessionIds: string[] = (await src.query(
    'SELECT session_id FROM therapy_sessions WHERE user_id=$1 ORDER BY created_at', [SIM_UID])).rows.map(r => r.session_id);

  try {
    await dst.query('BEGIN');

    // --- 1. user ---------------------------------------------------------
    const simUser = (await src.query('SELECT * FROM users WHERE userid=$1', [SIM_UID])).rows[0];
    const exists = await dst.query('SELECT userid FROM users WHERE username=$1', [simUser.username]);
    if (exists.rows.length) throw new Error(`stage already has user ${simUser.username} (userid ${exists.rows[0].userid}) — aborting to avoid mixing records`);
    const org = await dst.query(`SELECT org_id FROM organizations WHERE slug='irb-study'`);
    if (!org.rows.length) throw new Error('stage has no irb-study organization');
    const uSrcCols = await columns(src, 'users');
    const uDstCols = new Set((await columns(dstPool, 'users')).map(c => c.column_name));
    const uCols = uSrcCols.filter(c => uDstCols.has(c.column_name) && c.column_name !== 'userid' && c.column_name !== 'organization_id');
    const names = uCols.map(c => `"${c.column_name}"`).join(',');
    const ph = uCols.map((_, i) => `$${i + 1}`).join(',');
    const vals = uCols.map(c => simUser[c.column_name]);
    const ins = await dst.query(
      `INSERT INTO users (${names}, organization_id) VALUES (${ph}, $${uCols.length + 1}) RETURNING userid`,
      [...vals, org.rows[0].org_id]);
    const newUid: number = ins.rows[0].userid;
    console.log(`users: sim_participant -> stage userid ${newUid}`);

    const userMap = new Map([[SIM_UID, newUid]]);
    const msgMap = new Map<string, string>(); // old message_id -> new (as strings; bigint)

    // --- 2. bulk tables --------------------------------------------------
    for (const [table, kind] of TABLES) {
      const srcCols = await columns(src, table);
      const dstColSet = new Set((await columns(dstPool, table)).map(c => c.column_name));
      const serials = new Set(srcCols.filter(c => c.def.startsWith('nextval(')).map(c => c.column_name));
      // therapy_sessions.session_id defaults to gen_random_uuid() but we keep it (text key).
      const keep = srcCols.filter(c => dstColSet.has(c.column_name) && !serials.has(c.column_name));

      const where = kind === 'user'
        ? `WHERE user_id = ${SIM_UID}`
        : `WHERE session_id = ANY($1)`;
      const params = kind === 'user' ? [] : [sessionIds];
      const orderCol = serials.size ? [...serials][0] : null;
      const sel = keep.map(c =>
        c.data_type === 'USER-DEFINED' && c.column_name === 'embedding'
          ? `"embedding"::text AS "embedding"` : `"${c.column_name}"`).join(',');
      const serialSel = serials.size ? `, "${[...serials][0]}" AS __old_pk` : '';
      const rows = (await src.query(
        `SELECT ${sel}${serialSel} FROM ${table} ${where} ${orderCol ? `ORDER BY "${orderCol}"` : ''}`, params)).rows;

      let n = 0;
      for (const row of rows) {
        const cols: string[] = []; const vals: unknown[] = [];
        for (const c of keep) {
          let v = row[c.column_name];
          if (v !== null && ['user_id', 'userid', 'client_user_id', 'client_id'].includes(c.column_name)) {
            v = userMap.get(Number(v)) ?? v;
          }
          if (v !== null && c.column_name === 'message_id' && table !== 'messages') {
            v = msgMap.get(String(v)) ?? null; // unmapped -> null (FK is SET NULL anyway)
          }
          if (v !== null && (c.data_type === 'json' || c.data_type === 'jsonb')) v = JSON.stringify(v);
          cols.push(`"${c.column_name}"`);
          vals.push(v);
        }
        const phs = keep.map((c, i) => c.column_name === 'embedding' ? `$${i + 1}::vector` : `$${i + 1}`).join(',');
        const returning = table === 'messages' ? 'RETURNING message_id' : '';
        const r = await dst.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${phs}) ${returning}`, vals);
        if (table === 'messages') msgMap.set(String(row.__old_pk), String(r.rows[0].message_id));
        n++;
      }
      console.log(`${table}: ${n} rows`);
    }

    // study_sid was the sim userid as text — point it at the stage userid.
    await dst.query(`UPDATE qualtrics_responses SET study_sid=$1 WHERE response_id LIKE 'R_SIM_JORDAN_%'`, [String(newUid)]);

    // --- 3. adverse event + work item ------------------------------------
    const ae = (await src.query('SELECT * FROM adverse_event_reports')).rows[0];
    if (ae) {
      const aeSrc = await columns(src, 'adverse_event_reports');
      const aeDst = new Set((await columns(dstPool, 'adverse_event_reports')).map(c => c.column_name));
      const serials = new Set(aeSrc.filter(c => c.def.startsWith('nextval(')).map(c => c.column_name));
      const keep = aeSrc.filter(c => aeDst.has(c.column_name) && !serials.has(c.column_name));
      const cols: string[] = []; const vals: unknown[] = [];
      for (const c of keep) {
        let v = ae[c.column_name];
        if (v !== null && ['user_id', 'userid', 'client_user_id', 'client_id'].includes(c.column_name)) v = userMap.get(Number(v)) ?? v;
        if (v !== null && (c.data_type === 'json' || c.data_type === 'jsonb')) v = JSON.stringify(v);
        cols.push(`"${c.column_name}"`); vals.push(v);
      }
      await dst.query(`INSERT INTO adverse_event_reports (${cols.join(',')}) VALUES (${keep.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      console.log('adverse_event_reports: 1 row');
    }
    const wi = (await src.query('SELECT * FROM work_items')).rows;
    for (const w of wi) {
      const wSrc = await columns(src, 'work_items');
      const wDst = new Set((await columns(dstPool, 'work_items')).map(c => c.column_name));
      const serials = new Set(wSrc.filter(c => c.def.startsWith('nextval(')).map(c => c.column_name));
      const keep = wSrc.filter(c => wDst.has(c.column_name) && !serials.has(c.column_name));
      const cols: string[] = []; const vals: unknown[] = [];
      for (const c of keep) {
        let v = w[c.column_name];
        if (v !== null && ['client_id', 'user_id'].includes(c.column_name)) v = userMap.get(Number(v)) ?? v;
        if (v !== null && (c.data_type === 'json' || c.data_type === 'jsonb')) v = JSON.stringify(v);
        cols.push(`"${c.column_name}"`); vals.push(v);
      }
      await dst.query(
        `INSERT INTO work_items (${cols.join(',')}) VALUES (${keep.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (item_type, source_table, source_id) DO NOTHING`, vals);
    }
    console.log(`work_items: ${wi.length} row(s)`);

    if (DRY) { await dst.query('ROLLBACK'); console.log('\nDRY RUN — rolled back.'); }
    else { await dst.query('COMMIT'); console.log('\nCOMMITTED to stage.'); }
  } catch (err) {
    await dst.query('ROLLBACK');
    throw err;
  } finally {
    dst.release();
    await src.end(); await dstPool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
