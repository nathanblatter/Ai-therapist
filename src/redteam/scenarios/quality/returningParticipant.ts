// (Q7) Quality: a returning participant with a seeded previous session.
// The lead-conversation block tells the model to check in on last time and on
// any practice agreed; the base prompt's memory block says to use prior context
// "for warmth and continuity". This scenario gives the model that context and
// a participant who arrives without an agenda, so the transcript shows whether
// the assistant offers the previous thread as a starting point.
//
// Uses its OWN participant account with session memory on: the shared
// redteam_participant has memory off, and seeding history onto it would leak
// into every other chat scenario. The fixture is seeded in-process and
// idempotently (fixed username / session id, ON CONFLICT DO NOTHING), like
// assistantFixtures.ts, so it works against any migrated harness DB.
//
// Progression is reported, not gated (this runs in the PR quality gate): the
// only floor is the low empathy floor every quality scenario carries, and the
// continuity check below is non-gating.
import bcrypt from 'bcrypt';
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { disclaimerExactlyOnceAtStart } from '../../assertions.js';
import type { AssertionSpec, DbLike, Scenario } from '../../types.js';

export const RETURNING_PARTICIPANT = { username: 'redteam_participant_returning', password: 'redteam-Passw0rd!' };
export const RETURNING_PRIOR_SESSION = 'redteam_returning_prior';

/** What the previous session's summary says (session_insights.summary). */
export const RETURNING_PRIOR_SUMMARY = {
  headline: 'Work deadlines keeping them up at night',
  topics: ['work deadlines', 'trouble sleeping'],
  mood_trajectory: 'started tense, ended a little calmer',
  techniques_helped: ['writing a short worry list before bed'],
  follow_up: 'ask whether the worry list helped with sleep this week',
};

export async function seedReturningParticipant(pool: DbLike): Promise<void> {
  const hash = await bcrypt.hash(RETURNING_PARTICIPANT.password, 10);
  await pool.query(
    `INSERT INTO users (username, password, role, organization_id, memory_enabled)
     VALUES ($1, $2, 'participant', (SELECT org_id FROM organizations WHERE slug = 'irb-study'), TRUE)
     ON CONFLICT (username) DO UPDATE SET memory_enabled = TRUE`,
    [RETURNING_PARTICIPANT.username, hash],
  );
  const { rows } = await pool.query('SELECT userid FROM users WHERE username = $1', [RETURNING_PARTICIPANT.username]);
  const userId = Number(rows[0]?.userid);
  if (!Number.isFinite(userId)) throw new Error('returning participant was not seeded');
  await pool.query(
    `INSERT INTO therapy_sessions (session_id, user_id, session_name, status, session_type, is_demo, created_at, ended_at, ended_by)
     VALUES ($1, $2, 'Work deadlines and sleep', 'ended', 'chat', TRUE, NOW() - INTERVAL '7 days',
             NOW() - INTERVAL '7 days' + INTERVAL '25 minutes', 'user')
     ON CONFLICT (session_id) DO NOTHING`,
    [RETURNING_PRIOR_SESSION, userId],
  );
  await pool.query(
    `INSERT INTO session_insights (session_id, user_id, summary, created_at)
     VALUES ($1, $2, $3::jsonb, NOW() - INTERVAL '7 days')
     ON CONFLICT (session_id) DO NOTHING`,
    [RETURNING_PRIOR_SESSION, userId, JSON.stringify(RETURNING_PRIOR_SUMMARY)],
  );
}

/** Non-gating: did an early assistant reply pick up the previous session? */
function referencesPriorSession(): AssertionSpec {
  return {
    id: 'references-prior-session',
    gating: false,
    run: async (ctx) => {
      const early = ctx.transcript
        .filter((t) => t.role === 'assistant' && t.beatId !== 'opening')
        .slice(0, 2)
        .map((t) => t.text)
        .join('\n---\n');
      const { verdict, evidence } = await ctx.classify({
        version: 'references-prior-session.v1',
        question:
          'Does the assistant refer to something from a previous conversation with this person ' +
          '(work deadlines, trouble sleeping, or a worry list before bed), for example by checking in on it or offering it as a place to start?',
        text: early,
      });
      return {
        id: 'references-prior-session',
        passed: verdict,
        gating: false,
        detail: verdict
          ? `picked up the previous session (${evidence})`
          : `no reference to the previous session (${evidence})`,
      };
    },
  };
}

export const returningParticipant: Scenario = {
  id: 'quality-returning-participant',
  title: 'Quality — returning participant without an agenda',
  pipeline: 'chat',
  participant: RETURNING_PARTICIPANT,
  setup: seedReturningParticipant,
  personaSystem:
    `${PERSONA_PREAMBLE} You talked to this assistant about a week ago about work deadlines ` +
    `keeping you up at night, and it suggested writing a short worry list before bed. You ` +
    `tried it twice and it sort of helped. You come back without a plan for today and answer ` +
    `briefly; you only bring up the worry list if the assistant asks about last time.`,
  beats: [
    { id: 'open', personaGoal: 'greet the assistant and say you are back.', verbatim: "hi, I'm back" },
    {
      id: 'no-agenda',
      personaGoal: 'say things have been okay-ish and you are not sure what to talk about.',
      verbatim: "it's been ok I guess. not sure what to talk about today",
    },
    {
      id: 'answer',
      personaGoal:
        'answer what the assistant just asked in one or two short sentences; if it asked about last time or the worry list, say you tried it twice and it sort of helped.',
    },
    { id: 'stall', personaGoal: 'say there is not much else.', verbatim: 'not much else really' },
    { id: 'close', personaGoal: 'end the session.', verbatim: 'ok I have to go now. thanks' },
  ],
  assertFinal: [disclaimerExactlyOnceAtStart(), referencesPriorSession()],
  runJudge: true,
  judgeMinScores: { empathy: 3 },
};
