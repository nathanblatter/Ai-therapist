// GET /api/me/reflections (ai-therapist-204). Four properties are pinned here:
//
//   1. Flag gate: with features.participant_reflections_enabled anything but
//      a literal true, the route 404s and reads nothing.
//   2. Ownership: the user id comes from the session only.
//   3. Allow-list: the response carries no key outside REFLECTION_ALLOWED_KEYS
//      and none in REFLECTION_FORBIDDEN_KEYS, even when the db layer hands the
//      route rows poisoned with every forbidden column.
//   4. Crisis default: a session with safety events shows neutral facts only
//      and is indistinguishable from a session with no notes.
//
// The projection (utils/participantReflections.ts) is deliberately NOT mocked:
// this test exercises the real route + real projection over a fake db.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getOwnProgress: vi.fn(),
  getUserLatestSafetyPlan: vi.fn(),
  listUserWorksheetInstances: vi.fn(),
  listUserAssignments: vi.fn(),
  completeAssignment: vi.fn(),
  getMessageHistoryForClient: vi.fn(),
  getOwnReflectionSource: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const helperMocks = vi.hoisted(() => ({ getSystemConfig: vi.fn() }));
vi.mock('../../utils/sessionHelpers.js', () => helperMocks);

import progressRoutes from './progress.routes.js';
import {
  REFLECTION_ALLOWED_KEYS,
  REFLECTION_FORBIDDEN_KEYS,
  REFLECTIONS_FEATURE_FLAG,
} from '../../../shared/reflections.js';

function appAs(userId: number | null, role = 'participant') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = (userId === null
      ? {}
      : { userId, userRole: role, username: 'someone' }) as unknown as typeof req.session;
    next();
  });
  app.use(progressRoutes());
  return app;
}

const SENTINEL = 'LEAK_SENTINEL';

/** A source as the db layer returns it today. */
function cleanSource() {
  return {
    sessions: [
      {
        session_date: new Date('2026-11-10T18:00:00Z'),
        topics: ['exam stress', 'trouble sleeping'],
        techniques: ['box breathing'],
        checkin_topic: 'finals week',
        checkin_goal: 'feel less wound up',
        worksheets_completed: 1,
        text_withheld: false,
      },
      {
        // Safety events on record: reflective text must be withheld.
        session_date: new Date('2026-11-03T18:00:00Z'),
        topics: ['a very hard night'],
        techniques: ['grounding'],
        checkin_topic: 'rough week',
        checkin_goal: 'get through it',
        worksheets_completed: 0,
        text_withheld: true,
      },
      {
        // No insights row and no check-in: nothing to show.
        session_date: new Date('2026-10-27T18:00:00Z'),
        topics: null,
        techniques: null,
        checkin_topic: null,
        checkin_goal: null,
        worksheets_completed: 0,
        text_withheld: false,
      },
    ],
    mood: [
      { date: new Date('2026-11-10T17:55:00Z'), source: 'checkin', mood: 6 },
      { date: new Date('2026-11-03T17:55:00Z'), source: 'log_mood', mood: 3 },
    ],
    worksheets: { completed: 1, in_progress: 2 },
    session_count: 3,
    last_session_at: new Date('2026-11-10T18:00:00Z'),
    weekly_sessions: [
      { week_start: new Date('2026-11-02T00:00:00Z'), sessions: 1 },
      { week_start: new Date('2026-11-09T00:00:00Z'), sessions: 1 },
    ],
  };
}

/** The same source after a careless `SELECT *`: every forbidden column is
 *  present at every level, each carrying the sentinel. */
function poisonedSource() {
  const poison: Record<string, unknown> = {};
  for (const key of REFLECTION_FORBIDDEN_KEYS) poison[key] = `${SENTINEL}:${key}`;
  // Realistic shapes for the fields named in the hard constraints.
  Object.assign(poison, {
    summary: {
      headline: `${SENTINEL} participant disclosed suicidal ideation`,
      mood_trajectory: `${SENTINEL} seemed flat throughout`,
      follow_up: `${SENTINEL} reassess risk`,
      safety: `${SENTINEL} high-severity crisis flag`,
      techniques_helped: [`${SENTINEL} grounding`],
    },
    soap_note: { subjective: SENTINEL, objective: SENTINEL, assessment: SENTINEL, plan: SENTINEL },
    affect_curve: [{ turn: 1, valence: -0.9, arousal: 0.8, label: SENTINEL }],
    crisis_flagged: true,
    crisis_severity: `${SENTINEL} high`,
    crisis_risk_score: 87,
    crisis_events: [{ event_type: `${SENTINEL} flagged`, severity: 'high', risk_score: 87 }],
    acoustic_features: { f0_median_hz: 181.5, note: SENTINEL },
    eval_scores: { empathy: 4, note: SENTINEL },
    session_id: `${SENTINEL}-session`,
    user_id: 7,
  });
  const base = cleanSource();
  return {
    ...poison,
    ...base,
    sessions: base.sessions.map((s) => ({ ...poison, ...s })),
    mood: base.mood.map((m) => ({ ...poison, ...m })),
    worksheets: { ...poison, ...base.worksheets },
    weekly_sessions: base.weekly_sessions.map((w) => ({ ...poison, ...w })),
  };
}

/** Every object key anywhere in a JSON value. */
function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const el of value) collectKeys(el, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
  return into;
}

const flagOn = () => helperMocks.getSystemConfig.mockResolvedValue({ features: { [REFLECTIONS_FEATURE_FLAG]: true } });

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getOwnReflectionSource.mockResolvedValue(cleanSource());
  helperMocks.getSystemConfig.mockResolvedValue({ features: {} });
});

describe('feature flag (default OFF)', () => {
  it('uses the documented flag name', () => {
    expect(REFLECTIONS_FEATURE_FLAG).toBe('participant_reflections_enabled');
  });

  it.each([
    ['there is no features row', {}],
    ['the flag is absent', { features: { voice_enabled: true } }],
    ['the flag is false', { features: { participant_reflections_enabled: false } }],
    ['the flag is the string "true"', { features: { participant_reflections_enabled: 'true' } }],
    ['the flag is 1', { features: { participant_reflections_enabled: 1 } }],
    ['features is null', { features: null }],
  ])('404s and reads nothing when %s', async (_name, config) => {
    helperMocks.getSystemConfig.mockResolvedValue(config);
    const res = await request(appAs(7)).get('/api/me/reflections');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(dbMocks.getOwnReflectionSource).not.toHaveBeenCalled();
  });

  it('serves the payload only when the flag is literally true', async () => {
    flagOn();
    const res = await request(appAs(7)).get('/api/me/reflections');
    expect(res.status).toBe(200);
    expect(dbMocks.getOwnReflectionSource).toHaveBeenCalledTimes(1);
  });
});

describe('auth and ownership', () => {
  it('requires a session even with the flag on, and reads nothing without one', async () => {
    flagOn();
    const res = await request(appAs(null)).get('/api/me/reflections');
    expect(res.status).toBe(401);
    expect(dbMocks.getOwnReflectionSource).not.toHaveBeenCalled();
  });

  it('resolves the user from the session only (query, header and body are ignored)', async () => {
    flagOn();
    const res = await request(appAs(7))
      .get('/api/me/reflections?userId=999&user_id=999&session_id=someone-elses')
      .set('X-User-Id', '999')
      .send({ userId: 999, user_id: 999 });
    expect(res.status).toBe(200);
    expect(dbMocks.getOwnReflectionSource).toHaveBeenCalledTimes(1);
    expect(dbMocks.getOwnReflectionSource).toHaveBeenCalledWith(7);
  });

  it('has no path variant that names a user or a session', async () => {
    flagOn();
    for (const path of ['/api/me/reflections/999', '/api/me/reflections/sessions/abc']) {
      const res = await request(appAs(7)).get(path);
      expect(res.status).toBe(404);
    }
    expect(dbMocks.getOwnReflectionSource).not.toHaveBeenCalled();
  });
});

describe('allow-list projection', () => {
  it('returns exactly the documented shape', async () => {
    flagOn();
    const res = await request(appAs(7)).get('/api/me/reflections');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['continuity', 'mood', 'sessions', 'worksheets']);
    expect(res.body.sessions[0]).toEqual({
      date: '2026-11-10T18:00:00.000Z',
      topics: ['exam stress', 'trouble sleeping'],
      techniques: ['box breathing'],
      checkin: { topic: 'finals week', goal: 'feel less wound up' },
      worksheets_completed: 1,
    });
    expect(res.body.mood).toEqual([
      { date: '2026-11-10T17:55:00.000Z', source: 'checkin', mood: 6 },
      { date: '2026-11-03T17:55:00.000Z', source: 'log_mood', mood: 3 },
    ]);
    expect(res.body.worksheets).toEqual({ completed: 1, in_progress: 2 });
    expect(res.body.continuity).toEqual({
      session_count: 3,
      last_session_at: '2026-11-10T18:00:00.000Z',
      weekly_sessions: [
        { week_start: '2026-11-02T00:00:00.000Z', sessions: 1 },
        { week_start: '2026-11-09T00:00:00.000Z', sessions: 1 },
      ],
    });
  });

  it('FAILS if a forbidden field reaches the response, even from a poisoned db layer', async () => {
    flagOn();
    dbMocks.getOwnReflectionSource.mockResolvedValue(poisonedSource());
    const res = await request(appAs(7)).get('/api/me/reflections');
    expect(res.status).toBe(200);

    const keys = collectKeys(res.body);
    const forbiddenPresent = REFLECTION_FORBIDDEN_KEYS.filter((k) => keys.has(k));
    expect(forbiddenPresent).toEqual([]);

    const notAllowed = [...keys].filter((k) => !REFLECTION_ALLOWED_KEYS.includes(k));
    expect(notAllowed).toEqual([]);

    // No forbidden VALUE either, whatever key it might hide under.
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);

    // The poisoned response is identical to the clean one.
    dbMocks.getOwnReflectionSource.mockResolvedValue(cleanSource());
    const clean = await request(appAs(7)).get('/api/me/reflections');
    expect(res.body).toEqual(clean.body);
  });

  it('the allow-list and the forbidden list never overlap', () => {
    expect(REFLECTION_ALLOWED_KEYS.filter((k) => REFLECTION_FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });
});

describe('sessions with a safety event', () => {
  it('show neutral facts only and look exactly like a session with no notes', async () => {
    flagOn();
    const res = await request(appAs(7)).get('/api/me/reflections');
    const [, crisis, empty] = res.body.sessions;
    expect(crisis).toEqual({
      date: '2026-11-03T18:00:00.000Z',
      topics: [],
      techniques: [],
      checkin: null,
      worksheets_completed: 0,
    });
    // Same keys, same empty values: nothing marks the session as withheld.
    expect(Object.keys(crisis).sort()).toEqual(Object.keys(empty).sort());
    expect({ ...crisis, date: null }).toEqual({ ...empty, date: null });
    expect(JSON.stringify(res.body)).not.toContain('a very hard night');
    expect(JSON.stringify(res.body)).not.toContain('get through it');
  });
});

describe('failure handling', () => {
  it('returns 500 without leaking the error when the read fails', async () => {
    flagOn();
    dbMocks.getOwnReflectionSource.mockRejectedValue(new Error('relation session_insights exploded'));
    const res = await request(appAs(7)).get('/api/me/reflections');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch reflections' });
  });
});
