import 'dotenv/config';
import pg from 'pg';
import { scoreInstruments, weeklyMetrics } from '../../src/server/services/qualtricsScoring.service.js';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query("SELECT response_id, survey_role, recorded_at::date d, answers FROM qualtrics_responses WHERE response_id LIKE 'R_SIM_JORDAN_%' ORDER BY recorded_at");
for (const r of rows) {
  const s = scoreInstruments(r.survey_role, r.answers);
  const w = r.survey_role === 'weekly' ? weeklyMetrics(r.answers) : null;
  console.log(String(r.d).slice(0,10), r.survey_role.padEnd(8), 'phq2='+s.phq2, 'gad2='+s.gad2, w ? JSON.stringify(w) : '');
}
await pool.end();
