// Projection rules for the participant reflections surface (ai-therapist-204).
import { describe, it, expect } from 'vitest';
import { isReflectionsEnabled, projectReflectionSession, projectReflections } from './participantReflections.js';
import type { OwnReflectionSessionRow } from '../db/index.js';

const row = (over: Partial<OwnReflectionSessionRow> = {}): OwnReflectionSessionRow => ({
  session_date: new Date('2026-11-10T18:00:00Z'),
  topics: ['exam stress'],
  techniques: ['box breathing'],
  checkin_topic: 'finals',
  checkin_goal: 'calm down',
  worksheets_completed: 2,
  text_withheld: false,
  ...over,
});

const NEUTRAL = { topics: [], techniques: [], checkin: null };

describe('isReflectionsEnabled', () => {
  it('is true only for a literal true flag', () => {
    expect(isReflectionsEnabled({ features: { participant_reflections_enabled: true } })).toBe(true);
    for (const config of [
      undefined,
      null,
      {},
      { features: null },
      { features: 'participant_reflections_enabled' },
      { features: {} },
      { features: { participant_reflections_enabled: false } },
      { features: { participant_reflections_enabled: 'true' } },
      { features: { participant_reflections_enabled: 1 } },
    ]) {
      expect(isReflectionsEnabled(config as never)).toBe(false);
    }
  });
});

describe('projectReflectionSession', () => {
  it('passes safe phrases and the participant own check-in words through', () => {
    expect(projectReflectionSession(row())).toEqual({
      date: new Date('2026-11-10T18:00:00Z'),
      topics: ['exam stress'],
      techniques: ['box breathing'],
      checkin: { topic: 'finals', goal: 'calm down' },
      worksheets_completed: 2,
    });
  });

  it('withholds all reflective text when the session has a safety event, keeping date and counts', () => {
    expect(projectReflectionSession(row({ text_withheld: true }))).toEqual({
      date: new Date('2026-11-10T18:00:00Z'),
      ...NEUTRAL,
      worksheets_completed: 2,
    });
  });

  it('fails closed when the withheld flag is missing or malformed', () => {
    for (const bad of [undefined, null, 'false', 0]) {
      const out = projectReflectionSession(row({ text_withheld: bad as never }));
      expect(out).toMatchObject(NEUTRAL);
    }
  });

  it.each([
    ['risk language in a topic', { topics: ['work stress', 'suicidal thoughts'] }],
    ['self-harm in a topic', { topics: ['urges to self harm'] }],
    ['a safety-plan technique', { techniques: ['safety planning'] }],
    ['a crisis line in techniques', { techniques: ['calling the 988 lifeline'] }],
    ['diagnostic language', { topics: ['generalized anxiety disorder symptoms'] }],
    ['a diagnosis word', { topics: ['possible ADHD diagnosis'] }],
    ['risk language in the check-in', { checkin_topic: 'I want to die' }],
    ['a term past the display cap', { topics: [`${'x'.repeat(120)} overdose`] }],
  ])('withholds the whole session on %s', (_name, over) => {
    expect(projectReflectionSession(row(over))).toMatchObject(NEUTRAL);
  });

  it('keeps everyday feeling words', () => {
    const topics = ['anxiety about exams', 'feeling sad after a breakup', 'stress at work', 'grief'];
    expect(projectReflectionSession(row({ topics })).topics).toEqual(topics);
  });

  it('drops a single phrase written in the staff voice, keeping the rest', () => {
    const out = projectReflectionSession(
      row({ topics: ["participant's conflict with a roommate", 'exam stress', 'Client avoids conflict'] }),
    );
    expect(out.topics).toEqual(['exam stress']);
  });

  it('tolerates malformed JSONB and caps counts and lengths', () => {
    const out = projectReflectionSession(
      row({
        topics: ['a', 'b', 'B', 'c', 'd', 'e', 42, null, '   ', { nested: 'x' }],
        techniques: 'not an array',
        checkin_topic: `  ${'long '.repeat(80)}  `,
        checkin_goal: '   ',
      }),
    );
    expect(out.topics).toEqual(['a', 'b', 'c', 'd']);
    expect(out.techniques).toEqual([]);
    expect(out.checkin?.topic?.length).toBeLessThanOrEqual(200);
    expect(out.checkin?.goal).toBeNull();
  });

  it('returns a null check-in when there are no check-in words', () => {
    expect(projectReflectionSession(row({ checkin_topic: null, checkin_goal: '' })).checkin).toBeNull();
  });
});

describe('projectReflections', () => {
  it('keeps only self-reported mood sources and named fields', () => {
    const out = projectReflections({
      sessions: [],
      mood: [
        { date: new Date('2026-11-10T00:00:00Z'), source: 'checkin', mood: 6 },
        { date: new Date('2026-11-09T00:00:00Z'), source: 'affect_curve' as never, mood: 2 },
        { date: new Date('2026-11-08T00:00:00Z'), source: 'log_mood', mood: Number.NaN },
      ],
      worksheets: { completed: 0, in_progress: 0 },
      session_count: 0,
      last_session_at: null,
      weekly_sessions: [],
    });
    expect(out.mood).toEqual([{ date: new Date('2026-11-10T00:00:00Z'), source: 'checkin', mood: 6 }]);
    expect(out.continuity).toEqual({ session_count: 0, last_session_at: null, weekly_sessions: [] });
  });
});
