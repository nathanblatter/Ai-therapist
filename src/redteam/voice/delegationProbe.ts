// Delegation probe (ai-therapist-348): start ONE GPT-Live session through the
// in-process server, normal or recovery, say a few lines, and print what the
// delegation layer did. The voice suites cannot start in a recovery session
// and ask a question (a recovery start there only follows a vendor cut), and
// they do not show the nested backend events; this does both.
//
//   DATABASE_URL=postgresql://postgres@localhost:5432/<your scratch db> \
//     npx tsx src/redteam/voice/delegationProbe.ts --mode recovery \
//       --say "What happens to my data if I leave the study?" --say "Hello?"
//
// Flags: --mode normal|recovery   (default normal)
//        --say "<line>"           repeatable; spoken in order (TTS)
//        --user <username>        participant to log in as (default the harness
//                                 account, whose sessions are non-study, so the
//                                 fallback wording names nobody). Seed another
//                                 with scripts/redteam-seed-user.mjs
//                                 (REDTEAM_PARTICIPANT_USER / _USERID) to see
//                                 the study wording.
//
// Prints, per delegation: every nested backend event with its delegation id
// and the time since the previous one (the longest gap is what the stall
// watchdog's quiet period has to cover), then the transcript, the server's
// delegation fallbacks and the recorded usage.
//
// Costs real money (roughly $0.05 to $0.15 a run). Same guards as cli.ts, and
// it refuses a database whose name does not look disposable: never point it
// at stage or prod.
process.env.IMESSAGE_API_KEY = '';
process.env.CRISIS_ALERT_PHONE = '';
process.env.SOCKET_PG_ADAPTER = 'off';
process.env.NODE_ENV = 'test';

interface NestedEvent {
  at: number;
  type: string;
  delegationId: string | null;
}

function parseArgs(argv: string[]): { mode: 'normal' | 'recovery'; say: string[]; user: string | null } {
  const out = { mode: 'normal' as 'normal' | 'recovery', say: [] as string[], user: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') out.mode = argv[++i] === 'recovery' ? 'recovery' : 'normal';
    else if (argv[i] === '--say') out.say.push(argv[++i] ?? '');
    else if (argv[i] === '--user') out.user = argv[++i] ?? null;
  }
  out.say = out.say.filter((s) => s.trim());
  if (out.say.length === 0) out.say = ['What happens to my data if I withdraw from the study?'];
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point at a disposable scratch database');
  const t0 = Date.now();
  const rel = (t = Date.now()) => `${((t - t0) / 1000).toFixed(1)}s`;
  const print = console.log.bind(console);
  // The server logs every sideband event; keep the ones that tell the story.
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      const first = String(a[0] ?? '');
      if (!first.startsWith('[Live]')) return level === 'log' ? undefined : orig(...a);
      if (/response\.event|usage\.updated/.test(first)) return;
      orig(`[${rel()}]`, ...a);
    };
  }

  const { app, io } = await import('../../server/index.js');
  const { pool } = await import('../../server/config/db.js');
  const dbName = String((await pool.query('select current_database() as db')).rows[0].db);
  if (!/^(rt_|redteam|scratch)|_(redteam|scratch)$/.test(dbName)) {
    throw new Error(`refusing to run against database "${dbName}": the name does not look disposable`);
  }
  const { CURRENT_CONSENT_VERSION } = await import('../../server/utils/consent.js');
  const { HarnessClient } = await import('../harnessClient.js');
  const { LiveVoiceSession } = await import('../liveVoiceClient.js');
  const { CostTracker } = await import('../config.js');
  const { sidebandManager } = await import('../../server/services/sidebandManager.service.js');
  const { getOpenAIKey } = await import('../../server/config/secrets.js');
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: await getOpenAIKey() });

  // Tap the nested backend events where the sideband dispatches them.
  const nested: NestedEvent[] = [];
  const created: Array<{ at: number; id: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = sidebandManager as any;
  const origNested = sb.handleNestedResponseEvent.bind(sb);
  sb.handleNestedResponseEvent = (sid: string, inner: { type?: string } | undefined, delegationId: string | null) => {
    nested.push({ at: Date.now(), type: String(inner?.type ?? ''), delegationId });
    return origNested(sid, inner, delegationId);
  };
  const origEvent = sb.handleEvent.bind(sb);
  sb.handleEvent = (sid: string, event: { type: string; delegation?: { id?: string } }) => {
    if (event.type === 'session.delegation.created' && event.delegation?.id) {
      created.push({ at: Date.now(), id: event.delegation.id });
    }
    return origEvent(sid, event);
  };

  const participant = args.user ? { username: args.user, password: 'redteam-Passw0rd!' } : undefined;
  const client = new HarnessClient(app, io, CURRENT_CONSENT_VERSION, participant);
  client.patchEmissions();
  const agent = client.newAgent();
  await client.loginParticipant(agent, participant);
  await client.acceptConsent(agent);
  const cost = new CostTracker();

  const { session: vs, opening } = await LiveVoiceSession.start(
    client,
    agent,
    openai,
    cost,
    { textTurns: false, recovery: args.mode === 'recovery' },
    '',
  );
  print(`[${rel()}] SESSION ${vs.sessionId} mode=${args.mode} user=${args.user ?? 'harness'} db=${dbName}`);
  print(`[${rel()}] OPENING ${JSON.stringify(opening)}`);
  try {
    for (const line of args.say) {
      const turn = await vs.speakBeat(line);
      print(`[${rel()}] SAID   ${JSON.stringify(turn.userText)}`);
      print(`[${rel()}] REPLY  (${turn.layer?.layer ?? '?'}) ${JSON.stringify(turn.assistantText)}`);
      if (turn.terminated) {
        print(`[${rel()}] TERMINATED ${turn.terminated}`);
        break;
      }
    }
    const trailing = await vs.drainTrailing?.(8_000);
    if (trailing?.text) print(`[${rel()}] LATER  ${JSON.stringify(trailing.text)}`);
  } finally {
    await vs.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));

    for (const d of created) {
      const events = nested.filter((e) => e.delegationId === d.id);
      print(`DELEGATION ${d.id} created at ${rel(d.at)}: ${events.length} nested event(s) carry its id`);
      let prev = d.at;
      let longest = 0;
      const kept = new Set(['response.created', 'response.completed', 'response.failed', 'response.incomplete']);
      for (const e of events) {
        const gap = e.at - prev;
        longest = Math.max(longest, gap);
        if (kept.has(e.type) || /output_item\.(added|done)/.test(e.type) || gap >= 1_000) {
          print(`  +${String(e.at - d.at).padStart(6)} ms (gap ${String(gap).padStart(5)} ms) ${e.type}`);
        }
        prev = e.at;
      }
      print(`  longest gap with no backend event: ${longest} ms`);
    }
    const stray = nested.filter((e) => !created.some((d) => d.id === e.delegationId));
    print(
      `NESTED EVENTS WITH ANOTHER OR NO DELEGATION ID: ${stray.length}` +
        (stray.length ? ` (ids: ${[...new Set(stray.map((e) => String(e.delegationId)))].join(', ')})` : ''),
    );

    const fallbacks = await pool.query(
      `SELECT action_details FROM intervention_actions
        WHERE session_id = $1 AND action_details->>'event' = 'delegation_fallback' ORDER BY performed_at`,
      [vs.sessionId],
    );
    print(`FALLBACKS ${JSON.stringify(fallbacks.rows.map((r) => r.action_details))}`);
    const tools = await pool.query(
      `SELECT metadata->>'tool_name' AS name FROM messages WHERE session_id = $1 AND message_type = 'tool_call'`,
      [vs.sessionId],
    );
    print(`TOOLS ${JSON.stringify(tools.rows.map((r) => r.name))}`);
    const usage = await pool.query('SELECT duration_seconds::float8 AS s FROM live_usage WHERE session_id = $1', [
      vs.sessionId,
    ]);
    const llm = await pool.query(
      `SELECT purpose, model, COUNT(*)::int AS calls, SUM(tokens_in)::int AS tin, SUM(tokens_out)::int AS tout
         FROM session_llm_usage WHERE session_id = $1 GROUP BY 1, 2`,
      [vs.sessionId],
    );
    print(
      `USAGE voice_seconds=${usage.rows[0]?.s ?? 'n/a'} llm=${JSON.stringify(llm.rows)} tts_usd=${cost.usd.toFixed(4)}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('delegation probe failed:', err);
    process.exit(1);
  });
