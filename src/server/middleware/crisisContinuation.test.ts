// Guards the gates that must NOT block a crisis continuation.
//
// Incident 2026-09-11: OpenAI's content filter terminated a voice session the
// moment a participant disclosed suicidal intent. The recovery shipped for it
// was then found to be 100% defeated for logged-in participants, because the
// terminated session's own POST /end stamps ended_at = now — so by the time the
// recovery start reached checkSessionLimits, the cooldown clock had JUST been
// reset by the very session the filter killed. With the shipped default
// (cooldown_minutes: 30) every recovery 429'd: both voice attempts and the text
// fallback. The participant sat on "I'm coming right back" forever.
//
// These tests pin the predicate that exempts a continuation. The route-level
// exemptions read it, so if this contract breaks the recovery silently dies
// again — and it dies at the worst possible moment, which is exactly why it
// needs a test rather than a comment.

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { isCrisisContinuation, requireOutsideQuietHours } from './quietHours.js';

function reqWith(body: unknown, session: Record<string, unknown> = {}): Request {
  return { body, session } as unknown as Request;
}

describe('isCrisisContinuation', () => {
  it('recognises a voice recovery start', () => {
    expect(isCrisisContinuation(reqWith({ recovery: true, sdp: 'v=0' }))).toBe(true);
  });

  it('recognises a text continuation', () => {
    expect(isCrisisContinuation(reqWith({ continued_from: 'live_abc123' }))).toBe(true);
  });

  it('does NOT treat an ordinary start as a continuation', () => {
    // The exemption skips rate limits and quiet hours, so a false positive here
    // would let anyone bypass both by posting a flag.
    expect(isCrisisContinuation(reqWith({ sdp: 'v=0' }))).toBe(false);
    expect(isCrisisContinuation(reqWith({}))).toBe(false);
  });

  it('is not satisfied by a truthy-but-wrong value', () => {
    expect(isCrisisContinuation(reqWith({ recovery: 'yes' }))).toBe(false);
    expect(isCrisisContinuation(reqWith({ recovery: 1 }))).toBe(false);
    expect(isCrisisContinuation(reqWith({ continued_from: true }))).toBe(false);
  });

  it('survives a missing body', () => {
    expect(isCrisisContinuation(reqWith(undefined))).toBe(false);
  });
});

describe('quiet hours vs a crisis continuation', () => {
  const res = () => {
    const r = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  };

  it('lets a voice recovery through even for a participant', () => {
    // 10pm-6am is precisely when someone in crisis is most likely to be alone.
    // Blocking the assistant's return overnight would make that the window
    // where we hang up and stay hung up.
    const next = vi.fn() as unknown as NextFunction;
    const r = res();
    requireOutsideQuietHours(
      reqWith({ recovery: true }, { userRole: 'participant' }), r, next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('lets a text continuation through', () => {
    const next = vi.fn() as unknown as NextFunction;
    const r = res();
    requireOutsideQuietHours(
      reqWith({ continued_from: 'live_abc' }, { userRole: 'participant' }), r, next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });
});
