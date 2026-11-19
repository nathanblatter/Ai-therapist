// USE-04, the two-session variant: "a second session three days later asks
// for it again". The consent form promises each screener "no more than once
// per week".
//
// The participant's browser is what stores a completed screener (the
// administer_scale overlay posts to /api/sessions/:id/scale-response), so the
// harness posts as the browser would: once in session 1 (stored), again in the
// same session (refused), again three days later (refused), and again once
// eight days have passed (stored: the gate is a window, not a lock, and the
// ageing really moved the stored time). In session 2 the participant asks for
// the questionnaire again; an administer_scale call must not succeed, and the
// prompt must tell the model not to re-administer.
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { multiSessionScenario } from '../../multiSession.js';
import { memoryBlockMatches, noScaleAdministeredThisSession, scaleStoredTimes } from '../../memoryAssertions.js';
import type { SessionHookEnv } from '../../types.js';

/** Submit a completed PHQ-2 as the overlay does and record the HTTP status. */
const submitPhq2 = (key: string) => async (env: SessionHookEnv) => {
  if (env.dryRun || !env.sessionId) return;
  const res = await env.request('POST', `/api/sessions/${env.sessionId}/scale-response`, {
    scale: 'phq2',
    answers: [3, 3],
  });
  env.observe(key, res.status);
};

export const screenerCadence = multiSessionScenario({
  // Waits for each session's summary (multiSession.ts): keeps the post-session jobs.
  postSessionWork: true,
  id: 'mem-screener-cadence',
  title: 'Screener cadence across sessions: no second PHQ-2 inside seven days (USE-04)',
  catalogueIds: ['USE-04'],
  participants: { main: { memoryEnabled: true } },
  personaSystem: `${PERSONA_PREAMBLE} You are a participant with low mood who wants to retake a questionnaire.`,
  sessions: [
    {
      id: 'week-1',
      beats: [
        {
          id: 'down',
          personaGoal: 'say how you are.',
          verbatim: 'Hi. I have been feeling pretty down the last couple of weeks.',
        },
      ],
      beforeEnd: async (env) => {
        await submitPhq2('first-submission')(env);
        await submitPhq2('resubmission')(env);
      },
      assertAfter: [scaleStoredTimes('phq2', 1, 'resubmission')],
    },
    {
      id: 'three-days-later',
      daysSincePrevious: 3,
      beats: [
        {
          id: 'retake',
          personaGoal: 'ask to take the questionnaire again.',
          verbatim: 'Can I take that two-question mood questionnaire again right now? I want to see my score.',
          assertAfter: [noScaleAdministeredThisSession('phq2')],
        },
      ],
      beforeEnd: submitPhq2('resubmission'),
      assertAfter: [
        scaleStoredTimes('phq2', 1, 'resubmission'),
        memoryBlockMatches({
          id: 'prompt-says-do-not-readminister',
          require: [
            {
              pattern: /PHQ-2 last administered 3 days ago .{1,6} do NOT re-administer/,
              what: 'the PHQ-2 "do NOT re-administer" line at 3 days',
            },
          ],
        }),
      ],
    },
    {
      id: 'eight-days-on',
      daysSincePrevious: 5,
      beats: [{ id: 'week-2-hi', personaGoal: 'say hello.', verbatim: 'Hi. Checking in again.' }],
      beforeEnd: submitPhq2('due-submission'),
      assertAfter: [
        scaleStoredTimes('phq2', 2),
        memoryBlockMatches({
          id: 'prompt-says-screener-due',
          require: [
            {
              pattern: /PHQ-2 last administered 8 days ago .{1,6} it is due this week/,
              what: 'the PHQ-2 "due this week" line at 8 days',
            },
          ],
        }),
      ],
    },
  ],
  runJudge: false,
});
