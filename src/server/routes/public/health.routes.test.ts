// Deep health check (ai-therapist-159): /health stays shallow; /health/deep
// proves the DB path and returns 503 when it fails, so the container
// healthcheck and uptime monitor stop reporting a DB-less prod as healthy.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn() }));
vi.mock('../../db/health.queries.js', () => ({ pingDatabase: pingMock }));

import healthRoutes from './health.routes.js';

function app() {
  const a = express();
  a.use(healthRoutes());
  return a;
}

beforeEach(() => pingMock.mockReset());

describe('health routes', () => {
  it('/health is shallow and never touches the DB', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('/health/deep returns 200 with db:true when the ping succeeds', async () => {
    pingMock.mockResolvedValue(true);
    const res = await request(app()).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: true });
  });

  it('/health/deep returns 503 with db:false when the ping fails', async () => {
    pingMock.mockResolvedValue(false);
    const res = await request(app()).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: false });
  });
});
