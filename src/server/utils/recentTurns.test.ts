// ai-therapist-373: the in-process copy of each session's recent turns, and
// its bounds. Time is the fake clock throughout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RECENT_TURNS_END_GRACE_MS,
  RECENT_TURNS_IDLE_MS,
  RECENT_TURNS_MAX_SESSIONS,
  RECENT_TURNS_PER_SESSION,
  RECENT_TURN_MAX_CHARS,
  _resetRecentTurnsForTests,
  forgetSessionTurns,
  recentTurns,
  recentTurnsSessionCount,
  rememberSessionStart,
  rememberTurn,
  rememberedCheckin,
} from './recentTurns.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
  _resetRecentTurnsForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

const contents = (id: string) => recentTurns(id)?.turns.map((t) => `${t.role}:${t.content}`) ?? null;

describe('what is kept', () => {
  it('participant and assistant turns, in order; nothing else', () => {
    rememberTurn('s1', 'assistant', 'Are you thinking about suicide?');
    rememberTurn('s1', 'user', 'yes');
    rememberTurn('s1', 'system', 'tool echo');
    rememberTurn('s1', 'user', '   ');
    rememberTurn('s1', 'user', null);
    rememberTurn('s1', 'assistant', 'calling a tool', { messageType: 'function_call' });
    expect(contents('s1')).toEqual(['assistant:Are you thinking about suicide?', 'user:yes']);
  });

  it('a record whose key is already held is not kept twice (a re-sent batch), and gains its stored id', () => {
    const first = rememberTurn('s1', 'user', 'I want to die', { key: 'k1', at: 1000 });
    rememberTurn('s1', 'user', 'I want to die', { key: 'k1', at: 1000, messageId: 77 });
    expect(contents('s1')).toEqual(['user:I want to die']);
    expect(first?.messageId).toBe(77);
  });

  it('the same words without a key are two turns', () => {
    rememberTurn('s1', 'user', 'no');
    rememberTurn('s1', 'user', 'no');
    expect(contents('s1')).toEqual(['user:no', 'user:no']);
  });

  it('kept in time order: a browser record with an earlier time sorts before a later turn', () => {
    rememberTurn('s1', 'user', 'second', { at: Date.now() });
    rememberTurn('s1', 'assistant', 'first', { at: Date.now() - 5_000 });
    expect(contents('s1')).toEqual(['assistant:first', 'user:second']);
  });

  it('the id can be set on the returned turn once the row is stored', () => {
    const turn = rememberTurn('s1', 'user', 'hello');
    if (turn) turn.messageId = 5;
    expect(recentTurns('s1')?.turns[0].messageId).toBe(5);
  });

  it('a reader gets a copy: changing it changes nothing held', () => {
    rememberTurn('s1', 'user', 'hello');
    const copy = recentTurns('s1');
    if (copy) copy.turns[0].content = 'changed';
    expect(contents('s1')).toEqual(['user:hello']);
  });
});

describe('the session start and the check-in', () => {
  it('a session started here is complete; one seen only from its turns is not', () => {
    rememberSessionStart('started');
    rememberTurn('seen', 'user', 'hi');
    expect(recentTurns('started')?.complete).toBe(true);
    expect(recentTurns('seen')?.complete).toBe(false);
    expect(recentTurns('never')).toBeNull();
  });

  it('the check-in text is kept as the pipeline quotes it (topic, then goal)', () => {
    rememberSessionStart('s1', { topic: "  I don't really want to be alive ", goal: 'just talk' });
    expect(rememberedCheckin('s1')).toBe("I don't really want to be alive\njust talk");
    rememberSessionStart('s2', { topic: '', goal: 3 });
    expect(rememberedCheckin('s2')).toBeNull();
    rememberSessionStart('s3', null);
    expect(rememberedCheckin('s3')).toBeNull();
  });
});

describe('bounds', () => {
  it(`at most ${RECENT_TURNS_PER_SESSION} turns per session: the oldest go first`, () => {
    for (let i = 1; i <= RECENT_TURNS_PER_SESSION + 3; i++) rememberTurn('s1', 'user', `turn ${i}`);
    const held = contents('s1') ?? [];
    expect(held).toHaveLength(RECENT_TURNS_PER_SESSION);
    expect(held[0]).toBe('user:turn 4');
    expect(held.at(-1)).toBe(`user:turn ${RECENT_TURNS_PER_SESSION + 3}`);
  });

  it(`each turn keeps its last ${RECENT_TURN_MAX_CHARS} characters (the question at the end)`, () => {
    const long = `${'x'.repeat(RECENT_TURN_MAX_CHARS + 500)} Are you safe?`;
    rememberTurn('s1', 'assistant', long);
    const kept = recentTurns('s1')?.turns[0].content ?? '';
    expect(kept).toHaveLength(RECENT_TURN_MAX_CHARS);
    expect(kept.endsWith('Are you safe?')).toBe(true);
  });

  it(`at most ${RECENT_TURNS_MAX_SESSIONS} sessions: the least recently written goes first`, () => {
    for (let i = 0; i < RECENT_TURNS_MAX_SESSIONS; i++) rememberTurn(`s${i}`, 'user', 'hi');
    // s0 is written again: s1 is now the least recently written.
    rememberTurn('s0', 'user', 'again');
    rememberTurn('one-more', 'user', 'hi');
    expect(recentTurnsSessionCount()).toBe(RECENT_TURNS_MAX_SESSIONS);
    expect(recentTurns('s1')).toBeNull();
    expect(contents('s0')).toEqual(['user:hi', 'user:again']);
    expect(contents('one-more')).toEqual(['user:hi']);
  });

  it('a session idle for longer than the idle limit is dropped', () => {
    rememberSessionStart('s1');
    rememberTurn('s1', 'user', 'hi');
    vi.advanceTimersByTime(RECENT_TURNS_IDLE_MS - 1);
    expect(contents('s1')).toEqual(['user:hi']);
    vi.advanceTimersByTime(2);
    expect(recentTurns('s1')).toBeNull();
  });

  it('an idle session is dropped when another one is written (not only when read)', () => {
    rememberTurn('old', 'user', 'hi');
    vi.advanceTimersByTime(RECENT_TURNS_IDLE_MS + 1);
    rememberTurn('new', 'user', 'hi');
    expect(recentTurnsSessionCount()).toBe(1);
  });

  it('a turn written to an idle session starts it afresh (not complete, nothing old)', () => {
    rememberSessionStart('s1');
    rememberTurn('s1', 'user', 'old');
    vi.advanceTimersByTime(RECENT_TURNS_IDLE_MS + 1);
    rememberTurn('s1', 'user', 'new');
    expect(contents('s1')).toEqual(['user:new']);
    expect(recentTurns('s1')?.complete).toBe(false);
  });

  it('an ended session is kept for the grace period (its last turn is still being scored), then dropped', () => {
    rememberSessionStart('s1');
    rememberTurn('s1', 'user', 'hi');
    forgetSessionTurns('s1');
    vi.advanceTimersByTime(RECENT_TURNS_END_GRACE_MS);
    expect(contents('s1')).toEqual(['user:hi']);
    // A second end does not move the clock on.
    forgetSessionTurns('s1');
    vi.advanceTimersByTime(1);
    expect(recentTurns('s1')).toBeNull();
  });

  it('forgetting a session this process does not hold is harmless', () => {
    expect(() => forgetSessionTurns('nobody')).not.toThrow();
    expect(recentTurnsSessionCount()).toBe(0);
  });
});
