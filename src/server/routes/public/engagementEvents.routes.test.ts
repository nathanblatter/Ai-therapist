// Route coverage for the Phase 2 engagement-telemetry beacon: the flag
// gates (default off — the IRB constraint), kind allowlist, batch handling,
// session/user attribution, and insert-failure swallowing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { insertEngagementEventsMock, getSystemConfigMock } = vi.hoisted(() => ({
  insertEngagementEventsMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  insertEngagementEvents: insertEngagementEventsMock,
  // clientEvents.routes.ts (imported for cleanSessionId/capDetail) also
  // pulls from db/index; stub its import so the module graph resolves.
  insertClientEvent: vi.fn(),
}));

vi.mock('../../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
}));

import engagementEventsRoutes, {
  INTERACTION_TIMING_KINDS,
  ENGAGEMENT_EVENT_KINDS,
  MAX_EVENTS_PER_BATCH,
} from './engagementEvents.routes.js';

function makeApp(sessionUserId: number | null = null) {
  const app = express();
  // No app-level express.json(): the route mounts its own parser with a 16kb
  // limit (index.ts skips the global parser for this path too).
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session =
      sessionUserId ? { userId: sessionUserId } : {};
    next();
  });
  app.use(engagementEventsRoutes());
  return app;
}

function withFlags(flags: Record<string, unknown>) {
  getSystemConfigMock.mockResolvedValue({ features: flags });
}

beforeEach(() => {
  vi.clearAllMocks();
  insertEngagementEventsMock.mockResolvedValue(undefined);
  withFlags({});
});

describe('POST /api/engagement-events', () => {
  it('drops everything with 204 while both flags are off (the default)', async () => {
    const res = await request(makeApp())
      .post('/api/engagement-events')
      .send({ events: [{ kind: 'turn_timing' }, { kind: 'tool_open' }] });
    expect(res.status).toBe(204);
    expect(insertEngagementEventsMock).not.toHaveBeenCalled();
  });

  it('accepts every allowlisted kind when its flag is on', async () => {
    withFlags({ telemetry_interaction_timing: true, telemetry_engagement_events: true });
    const events = [...INTERACTION_TIMING_KINDS, ...ENGAGEMENT_EVENT_KINDS].map(kind => ({ kind }));
    const res = await request(makeApp()).post('/api/engagement-events').send({ events });
    expect(res.status).toBe(204);
    expect(insertEngagementEventsMock).toHaveBeenCalledTimes(1);
    expect(insertEngagementEventsMock.mock.calls[0][0]).toHaveLength(events.length);
  });

  it('gates each stream independently (timing off, engagement on)', async () => {
    withFlags({ telemetry_engagement_events: true });
    await request(makeApp())
      .post('/api/engagement-events')
      .send({ events: [{ kind: 'turn_timing' }, { kind: 'scroll_back' }] });
    const inserted = insertEngagementEventsMock.mock.calls[0][0];
    expect(inserted).toHaveLength(1);
    expect(inserted[0].kind).toBe('scroll_back');
  });

  it('silently skips unknown kinds instead of rejecting the batch', async () => {
    withFlags({ telemetry_engagement_events: true });
    const res = await request(makeApp())
      .post('/api/engagement-events')
      .send({ events: [{ kind: 'made_up' }, { kind: 'tool_open' }] });
    expect(res.status).toBe(204);
    expect(insertEngagementEventsMock.mock.calls[0][0]).toHaveLength(1);
  });

  it('attaches session userId and cleans sessionIds', async () => {
    withFlags({ telemetry_engagement_events: true });
    await request(makeApp(7))
      .post('/api/engagement-events')
      .send({ events: [
        { kind: 'tool_open', sessionId: 'sess_abc123', detail: { tool: 'journal' } },
        { kind: 'tool_close', sessionId: 'not a session id' },
      ] });
    const inserted = insertEngagementEventsMock.mock.calls[0][0];
    expect(inserted[0]).toMatchObject({ userId: 7, sessionId: 'sess_abc123', detail: { tool: 'journal' } });
    expect(inserted[1]).toMatchObject({ userId: 7, sessionId: null });
  });

  it('caps a batch at MAX_EVENTS_PER_BATCH', async () => {
    withFlags({ telemetry_engagement_events: true });
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 20 }, () => ({ kind: 'scroll_back' }));
    await request(makeApp()).post('/api/engagement-events').send({ events });
    expect(insertEngagementEventsMock.mock.calls[0][0]).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  it('returns 204 on a malformed body (no events array)', async () => {
    withFlags({ telemetry_engagement_events: true });
    const res = await request(makeApp()).post('/api/engagement-events').send({ nope: true });
    expect(res.status).toBe(204);
    expect(insertEngagementEventsMock).not.toHaveBeenCalled();
  });

  it('still returns 204 when the insert fails (beacons are fire-and-forget)', async () => {
    withFlags({ telemetry_engagement_events: true });
    insertEngagementEventsMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp())
      .post('/api/engagement-events')
      .send({ events: [{ kind: 'tool_open' }] });
    expect(res.status).toBe(204);
  });

  it('still returns 204 when config lookup fails', async () => {
    getSystemConfigMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp())
      .post('/api/engagement-events')
      .send({ events: [{ kind: 'tool_open' }] });
    expect(res.status).toBe(204);
    expect(insertEngagementEventsMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized body pre-parse with 413 (route-local 16kb json limit)', async () => {
    withFlags({ telemetry_engagement_events: true });
    const res = await request(makeApp())
      .post('/api/engagement-events')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ events: [{ kind: 'tool_open', detail: { blob: 'z'.repeat(20_000) } }] }));
    expect(res.status).toBe(413);
    expect(insertEngagementEventsMock).not.toHaveBeenCalled();
  });
});
