// Participant simulation — phase 1: drive N realistic chat sessions through the
// REAL app pipeline (in-process, same pattern as src/redteam/cli.ts) as the
// dedicated `sim_participant` account on a local scratch DB.
//
//   DATABASE_URL=postgresql://...ai_therapist_participant_sim \
//     npx tsx scripts/participant-sim/run-sessions.ts [--from 1] [--to 16]
//
// Timestamps are left as "now"; scripts/participant-sim/backdate.sql shifts
// each session into its study week afterwards.
import 'dotenv/config';

process.env.IMESSAGE_API_KEY = '';
process.env.CRISIS_ALERT_PHONE = '';
process.env.SOCKET_PG_ADAPTER = 'off';
process.env.NODE_ENV = 'test';

import { SESSIONS, PERSONA_SYSTEM } from './persona.js';

const PARTICIPANT = { username: 'sim_participant', password: 'sim-Passw0rd!' };
const PERSONA_MODEL = 'gpt-4o-mini';

async function main() {
  const argv = process.argv.slice(2);
  const from = argv.includes('--from') ? Number(argv[argv.indexOf('--from') + 1]) : 1;
  const to = argv.includes('--to') ? Number(argv[argv.indexOf('--to') + 1]) : SESSIONS.length;

  const OpenAI = (await import('openai')).default;
  const { getOpenAIKey } = await import('../../src/server/config/secrets.js');
  const openai = new OpenAI({ apiKey: await getOpenAIKey() });

  const { app, io } = await import('../../src/server/index.js');
  const { pool } = await import('../../src/server/config/db.js');
  const { CURRENT_CONSENT_VERSION } = await import('../../src/server/utils/consent.js');
  const { HarnessClient } = await import('../../src/redteam/harnessClient.js');

  const health = await (await import('supertest')).default(app).get('/health');
  if (health.status !== 200) throw new Error(`app health check failed: ${health.status}`);

  const client = new HarnessClient(app, io, CURRENT_CONSENT_VERSION, PARTICIPANT);
  client.patchEmissions();

  for (let i = from; i <= to; i++) {
    const spec = SESSIONS[i - 1];
    console.log(`\n=== session ${i}/${SESSIONS.length} (week ${spec.week}): ${spec.title} ===`);
    const agent = client.newAgent();
    await client.loginParticipant(agent);
    await client.acceptConsent(agent);
    const sessionId = await client.startChat(agent);
    console.log(`  sessionId=${sessionId}`);

    const transcript: { role: 'user' | 'assistant'; content: string }[] = [];
    for (let t = 0; t < spec.turns; t++) {
      const opener = t === 0 ? spec.opener : null;
      const userMsg = opener ?? (await personaTurn(openai, spec, transcript, t === spec.turns - 1));
      transcript.push({ role: 'user', content: userMsg });
      const { response, sessionEnded } = await client.chatMessage(agent, sessionId, userMsg);
      transcript.push({ role: 'assistant', content: response });
      console.log(`  [${t + 1}/${spec.turns}] P: ${userMsg.slice(0, 90)}`);
      console.log(`            A: ${response.slice(0, 90).replace(/\n/g, ' ')}`);
      if (sessionEnded) { console.log('  (session ended by server)'); break; }
    }
    await client.endChat(agent, sessionId);

    // Wait for post-session processing (redaction) to complete before moving on.
    // Redaction fills messages.content_redacted for every user/assistant turn.
    const deadline = Date.now() + 150_000;
    for (;;) {
      const r = await pool.query(
        `SELECT count(*) FILTER (WHERE role IN ('user','assistant')) AS total,
                count(*) FILTER (WHERE role IN ('user','assistant') AND content_redacted IS NOT NULL) AS done
           FROM messages WHERE session_id = $1`, [sessionId]);
      const { total, done } = r.rows[0];
      if (Number(total) > 0 && Number(done) >= Number(total)) { console.log(`  redaction: ${done}/${total}`); break; }
      if (Date.now() > deadline) { console.log(`  WARN: redaction ${done}/${total} not complete in 150s`); break; }
      await new Promise(res => setTimeout(res, 1500));
    }
    // Record which sim session index this session id belongs to (for backdating).
    await pool.query(
      `INSERT INTO system_config (config_key, config_value, description)
       VALUES ($1, $2::jsonb, 'participant-sim session map')
       ON CONFLICT (config_key) DO UPDATE SET config_value = $2::jsonb`,
      [`sim_session_${String(i).padStart(2, '0')}`, JSON.stringify({ sessionId, week: spec.week, slot: spec.slot, title: spec.title })],
    );
    console.log(`  done (redaction confirmed)`);
  }

  console.log('\nAll requested sessions complete.');
  process.exit(0);
}

async function personaTurn(
  openai: InstanceType<typeof import('openai').default>,
  spec: (typeof SESSIONS)[number],
  transcript: { role: 'user' | 'assistant'; content: string }[],
  isLast: boolean,
): Promise<string> {
  const resp = await openai.chat.completions.create({
    model: PERSONA_MODEL,
    temperature: 0.7,
    max_tokens: 160,
    messages: [
      { role: 'system', content: PERSONA_SYSTEM },
      {
        role: 'user',
        content:
          `Session context (week ${spec.week} of the study): ${spec.context}\n` +
          `Your goal this session: ${spec.goal}\n` +
          (isLast ? 'This is your LAST message this session: naturally wind down and thank the assistant briefly.\n' : '') +
          `Conversation so far:\n` +
          transcript.map(m => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`).join('\n') +
          `\n\nReply with ONLY your next message as the participant (1-3 sentences, casual texting tone, occasionally imperfect grammar).`,
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() || '(silence)';
}

main().catch(err => { console.error(err); process.exit(1); });
