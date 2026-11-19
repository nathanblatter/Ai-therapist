// The supertest loopback setup file (ai-therapist-279) is loaded for every
// test file via vitest.config.ts; these tests pin its behaviour.
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import request from 'supertest';

function echoApp() {
  const app = express();
  app.get('/where', (req, res) => {
    const { server } = req.socket as unknown as { server: http.Server };
    res.json({ local: req.socket.localAddress, bound: (server.address() as { address: string }).address });
  });
  app.get('/set', (_req, res) => {
    res.cookie('k', 'v').json({ ok: true });
  });
  app.get('/get', (req, res) => {
    res.json({ cookie: req.headers.cookie ?? null });
  });
  return app;
}

describe('supertest loopback binding', () => {
  it('serves request(app) from a server bound to 127.0.0.1, not the dual-stack wildcard', async () => {
    const res = await request(echoApp()).get('/where?x=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ local: '127.0.0.1', bound: '127.0.0.1' });
  });

  it('closes the server it started once the request completes', async () => {
    const server = http.createServer(echoApp());
    await request(server).get('/where');
    expect(server.listening).toBe(false);
  });

  it('leaves an already-listening server alone', async () => {
    const server = http.createServer(echoApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      expect((await request(server).get('/where')).status).toBe(200);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps agent cookies across sequential requests and handles concurrent ones', async () => {
    const agent = request.agent(echoApp());
    await agent.get('/set');
    expect((await agent.get('/get')).body.cookie).toBe('k=v');
    // Concurrent requests share the one in-flight bind (only the first starts
    // the server, exactly as without the setup file).
    const responses = await Promise.all([agent.get('/get'), agent.get('/get'), agent.get('/get')]);
    expect(responses.map((r) => r.body.cookie)).toEqual(['k=v', 'k=v', 'k=v']);
  });

  // ai-therapist-370: the request that started the server used to close it as
  // soon as it finished, under requests still using it. Concurrent ones were
  // reset (ECONNRESET, seen once in a loaded full-suite run); one created
  // alongside it and sent afterwards found no server at all.
  it('keeps the server up until the last request that shares it has finished', async () => {
    const server = http.createServer(echoApp());
    const agent = request.agent(server);
    const first = agent.get('/where');
    const second = agent.get('/where');
    expect((await first).status).toBe(200);
    expect(server.listening).toBe(true);
    expect((await second).status).toBe(200);
    expect(server.listening).toBe(false);
  });

  it('serves a burst of concurrent agent requests on one bind without resets', async () => {
    const agent = request.agent(echoApp());
    const statuses = await Promise.all(Array.from({ length: 50 }, () => agent.get('/where').then((r) => r.status)));
    expect(statuses).toEqual(Array.from({ length: 50 }, () => 200));
  });

  it('supports the expect() chain', async () => {
    await request(echoApp()).get('/where').expect(200).expect('Content-Type', /json/);
  });
});
