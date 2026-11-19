// Every scenario that reads post-session output opts in (ai-therapist-383);
// the harness client opts in exactly the sessions of such a scenario; the
// summary says when post-session work was skipped.
import { describe, it, expect, vi } from 'vitest';
import { selectSuite } from './scenarios/index.js';
import { postSessionOptInProblems, postSessionOptInReason } from './postSessionOptIn.js';
import { HarnessClient } from './harnessClient.js';
import { costNotes } from './sessionCost.js';
import type { RedteamSuite } from './config.js';
import type { Scenario } from './types.js';

const SUITES: RedteamSuite[] = [
  'smoke',
  'full',
  'quality',
  'voice',
  'voice-safety',
  'extended',
  'voice-crawl',
  'voice-walk',
  'voice-run',
];
const all = new Map<string, Scenario>();
for (const suite of SUITES) for (const e of selectSuite(suite)) all.set(e.scenario.id, e.scenario);

describe('post-session opt-in', () => {
  it('every scenario that reads post-session output sets postSessionWork', () => {
    expect([...all.values()].flatMap(postSessionOptInProblems)).toEqual([]);
  });

  it('the opted-in set is exactly the multi-session scenarios plus CONF-07/08', () => {
    const optedIn = [...all.values()].filter((s) => s.postSessionWork).map((s) => s.id);
    const needed = [...all.values()].filter((s) => postSessionOptInReason(s) !== null).map((s) => s.id);
    expect(optedIn.sort()).toEqual(needed.sort());
    expect(optedIn).toContain('conf-identifiers-volunteered');
    expect(optedIn).toContain('conf-redaction-injection');
    expect([...all.values()].filter((s) => s.sessions).every((s) => s.postSessionWork)).toBe(true);
    // The smoke suite opts nothing in: it saves the whole post-session spend.
    expect(selectSuite('smoke').filter((e) => e.scenario.postSessionWork)).toEqual([]);
  });

  it('a scenario reading post-session output without opting in is reported', () => {
    const conf = all.get('conf-redaction-injection')!;
    expect(postSessionOptInProblems({ ...conf, postSessionWork: undefined })).toEqual([
      'conf-redaction-injection: asserts on post-session output (identifiers-absent-from-deidentified-data); set postSessionWork: true',
    ]);
    const multi = [...all.values()].find((s) => s.sessions)!;
    expect(postSessionOptInProblems({ ...multi, postSessionWork: false })[0]).toMatch(/multi-session/);
  });
});

describe('HarnessClient opt-in hook', () => {
  function client() {
    // The app and io are never touched by noteSession.
    return new HarnessClient({} as never, {} as never, 'v1');
  }

  it('opts in the sessions of a scenario that wants post-session work, and only those', () => {
    const c = client();
    const optIn = vi.fn();
    c.postSessionOptIn = optIn;
    c.noteSession('a');
    c.scenarioWantsPostSession = true;
    c.noteSession('b');
    c.scenarioWantsPostSession = false;
    c.noteSession('c');
    expect(optIn.mock.calls).toEqual([['b']]);
  });

  it('chat starts opt in too', async () => {
    const c = client();
    const optIn = vi.fn();
    c.postSessionOptIn = optIn;
    c.scenarioWantsPostSession = true;
    const agent = {
      post: () => ({ send: async () => ({ status: 200, body: { sessionId: 'chat-1' }, headers: {} }) }),
    };
    await c.startChat(agent as never);
    expect(optIn).toHaveBeenCalledWith('chat-1');
  });
});

describe('summary says when post-session work was skipped', () => {
  it('adds a line naming the count and the scenarios that kept it', () => {
    const notes = costNotes(null, [], false, { skippedSessions: 5, optedIn: ['conf-redaction-injection'] });
    expect(
      notes.excluded.some((n) =>
        /post-session work .* skipped for 5 harness session\(s\).*kept for conf-redaction-injection/.test(n),
      ),
    ).toBe(true);
  });

  it('says nothing when nothing was skipped', () => {
    expect(costNotes(null, [], false).excluded.some((n) => /post-session work/.test(n))).toBe(false);
  });
});
