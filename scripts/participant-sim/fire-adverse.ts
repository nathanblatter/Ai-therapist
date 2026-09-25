import 'dotenv/config';
process.env.NODE_ENV = 'test';
const { processExportedResponse } = await import('../../src/server/services/qualtricsSync.service.js');
const { pool } = await import('../../src/server/config/db.js');
const uid = (await pool.query("SELECT userid FROM users WHERE username='sim_participant'")).rows[0].userid;
// Replay the W4 weekly through the shared sync path so the adverse-experience
// report (QID10=2 + QID11_TEXT) drafts an AE + work-queue item authentically.
const values: Record<string, unknown> = {
  QID8:3, QID9:5, QID6:4, QID4:4,
  QID7_1:4, QID7_2:4, QID7_3:3, QID7_4:4, QID7_5:4, QID7_6:4,
  QID7_7:3, QID7_8:4, QID7_9:3, QID7_10:4, QID7_11:4, QID7_12:3,
  QID10:2,
  QID11_TEXT:"had a panic-type moment in the library during midterm studying - heart racing, couldnt catch my breath. talked it through with the app after and calmed down. not an emergency but it scared me.",
  duration:168, finished:1, recordedDate:'2026-07-06T20:30:00-06:00', sid:String(uid),
};
const r = await processExportedResponse('weekly', 'SV_emV8ohMB6FujVLU', { responseId:'R_SIM_JORDAN_W4', values } as any);
console.log('processed, linked=', r.linked);
const ae = await pool.query("SELECT report_id, status, severity, event_type FROM adverse_event_reports ORDER BY report_id DESC LIMIT 3");
console.log('adverse_event_reports:', JSON.stringify(ae.rows));
const wq = await pool.query("SELECT id, item_type, severity, title, status FROM work_queue ORDER BY id DESC LIMIT 3");
console.log('work_queue:', JSON.stringify(wq.rows));
await pool.end();
