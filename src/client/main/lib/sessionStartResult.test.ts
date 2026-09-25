import { describe, it, expect } from 'vitest';
import {
  SESSION_START_OK,
  classifySessionStartRefusal,
  describeSessionStartRefusal,
  sessionStartRefused,
  type SessionStartRefusal,
} from './sessionStartResult';

describe('classifySessionStartRefusal', () => {
  it('classifies a rate limit regardless of body', () => {
    expect(classifySessionStartRefusal(429, null)).toBe('rate_limited');
    expect(classifySessionStartRefusal(429, { message: 'slow down' })).toBe('rate_limited');
  });

  it('classifies the 403 sub-cases by error code', () => {
    expect(classifySessionStartRefusal(403, { error: 'quiet_hours' })).toBe('quiet_hours');
    expect(classifySessionStartRefusal(403, { error: 'study_status' })).toBe('study_status');
    expect(classifySessionStartRefusal(403, { error: 'identifier_blocked' })).toBe('identifier_blocked');
  });

  it('classifies a rolled-back voice backend', () => {
    expect(classifySessionStartRefusal(409, { error: 'live_not_active' })).toBe('live_not_active');
  });

  it('returns null for statuses that are transport failures, not refusals', () => {
    // 503 monitoring_unavailable and 500s throw in the caller instead; the
    // recovery path treats a throw as an immediate failover too.
    expect(classifySessionStartRefusal(503, { error: 'monitoring_unavailable' })).toBeNull();
    expect(classifySessionStartRefusal(500, null)).toBeNull();
    expect(classifySessionStartRefusal(502, null)).toBeNull();
  });

  it('returns null for an unrecognised 403 or 409 body', () => {
    expect(classifySessionStartRefusal(403, { error: 'something_new' })).toBeNull();
    expect(classifySessionStartRefusal(403, null)).toBeNull();
    expect(classifySessionStartRefusal(409, { error: 'something_new' })).toBeNull();
    expect(classifySessionStartRefusal(409, null)).toBeNull();
  });
});

describe('SessionStartResult', () => {
  it('marks success so callers wait for session.started', () => {
    expect(SESSION_START_OK.ok).toBe(true);
  });

  it('carries the refusal so a caller can fail over immediately', () => {
    const result = sessionStartRefused('live_not_active');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('live_not_active');
  });

  it('describes every refusal without leaking an empty message', () => {
    const refusals: SessionStartRefusal[] = [
      'rate_limited',
      'quiet_hours',
      'study_status',
      'identifier_blocked',
      'live_not_active',
      'session_exists',
    ];
    for (const refusal of refusals) {
      expect(describeSessionStartRefusal(refusal)).toMatch(/^Server refused the session start: .+/);
    }
  });
});
