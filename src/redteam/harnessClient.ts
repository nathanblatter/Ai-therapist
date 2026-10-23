// In-process HTTP driver + socket-emission capture + DB reads (spec §5, D3).
//
// We import the real Express app and Socket.io server, drive them with
// supertest (so no port is needed), and monkey-patch io.to().emit to capture
// crisis emissions — the harness and the routes share the same global.io, so a
// `session:crisis-detected` emitted by /logs/batch lands in our buffer.
import request from 'supertest';
import { CookieAccessInfo } from 'cookiejar';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as IOServer } from 'socket.io';
import type { CapturedEmission } from './types.js';

/** supertest agent type (cookie jar persists across calls). */
export type Agent = ReturnType<typeof request.agent>;

export class HarnessClient {
  readonly emissions: CapturedEmission[] = [];
  private patched = false;
  /** Set by listen(): the real server's origin, for paths supertest cannot
   *  drive (the Grok voice WebSocket upgrade). Null for HTTP-only suites. */
  baseUrl: string | null = null;

  constructor(
    private readonly app: Express,
    private readonly io: IOServer,
    private readonly consentVersion: string,
    private readonly participant = { username: 'redteam_participant', password: 'redteam-Passw0rd!' },
  ) {}

  /** Patch io.to().emit ONCE to also record every emission into our buffer. */
  patchEmissions(): void {
    if (this.patched) return;
    this.patched = true;
    const buf = this.emissions;
    const origTo = this.io.to.bind(this.io);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.io as any).to = (room: string) => {
      const op = origTo(room as never);
      const origEmit = op.emit.bind(op);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (op as any).emit = (event: string, ...args: unknown[]) => {
        buf.push({ room: String(room), event, payload: args[0], ts: new Date() });
        return origEmit(event as never, ...(args as never[]));
      };
      return op;
    };
  }

  newAgent(): Agent {
    return request.agent(this.app);
  }

  /**
   * Bind the real HTTP server to an ephemeral loopback port. supertest spins
   * up a throwaway listener per request, which is fine for HTTP but a
   * WebSocket upgrade needs a listener that stays up — and the Grok proxy's
   * upgrade handler is attached to THIS httpServer. Only the voice suite
   * needs it; HTTP suites keep running port-free.
   */
  async listen(httpServer: HttpServer): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.off('error', reject); resolve(); });
    });
    const addr = httpServer.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  /** The agent's cookie jar as a `Cookie:` header value, so a raw WebSocket
   *  (outside supertest) carries the same express-session as the agent's HTTP
   *  calls. supertest stores cookies against 127.0.0.1, the same host the
   *  listener binds, so the session cookie is a valid match either way. */
  cookieHeader(agent: Agent): string {
    const jar = (agent as unknown as { jar: { getCookies: (a: unknown) => { toValueString: () => string } } }).jar;
    return jar.getCookies(CookieAccessInfo.All).toValueString();
  }

  /** Log in the dedicated participant so the agent's session carries a numeric
   *  user_id (required by /api/chat/start — anonymous cookie-only sessions 500).
   *
   *  The login route persists req.session.userId with a fire-and-forget
   *  req.session.save(): the HTTP response can return BEFORE the pg-backed
   *  session store has committed the userId. If the very next request
   *  (acceptConsent) loads the session before that write lands, it reads a
   *  session without userId and its own save clobbers login's write — so
   *  /api/chat/start then falls back to req.sessionID (a string) and 500s on the
   *  integer user_id column. Poll /api/auth/status until the store reflects the
   *  login before doing anything else on this agent, closing the race. */
  async loginParticipant(agent: Agent): Promise<void> {
    const res = await agent.post('/api/auth/login').send(this.participant);
    if (res.status !== 200 || res.body?.success !== true) {
      throw new Error(`participant login failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await agent.get('/api/auth/status');
      if (status.status === 200 && status.body?.authenticated === true && typeof status.body?.user?.userid === 'number') {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`participant login did not persist to the session store within 10s (last status: ${JSON.stringify(status.body)})`);
      }
      await sleep(100);
    }
  }

  /** Accept the CURRENT consent version on this agent's cookie (spec R8). */
  async acceptConsent(agent: Agent): Promise<void> {
    const res = await agent.post('/api/consent/accept').send({ consentVersion: this.consentVersion });
    if (res.status !== 200) throw new Error(`consent accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // ---- chat pipeline ----

  /** Start a chat session. `opening` is the server-authored first assistant
   *  turn (utils/openingLine.ts) — callers must put it at the head of the
   *  transcript so disclaimer assertions see what the participant sees. */
  async startChat(agent: Agent): Promise<{ sessionId: string; opening: string | null }> {
    const res = await agent.post('/api/chat/start').send({ language: 'en' });
    if (res.status !== 200 || !res.body?.sessionId) {
      throw new Error(`chat start failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
      sessionId: res.body.sessionId as string,
      opening: typeof res.body.opening === 'string' && res.body.opening ? (res.body.opening as string) : null,
    };
  }

  /** Send a chat turn and surface the reply plus the new `sessionEnded` flag
   *  (set by the eligibility gate) and the echoed session id, so DB-backed
   *  assertions can bind to the same session. Throws on any non-200 (a normal
   *  turn must succeed); use chatMessageRaw when a rejection is expected. */
  async chatMessage(
    agent: Agent,
    sessionId: string,
    message: string,
  ): Promise<{ response: string; sessionEnded: boolean; sessionId: string }> {
    const res = await agent.post('/api/chat/message').send({ sessionId, message });
    if (res.status !== 200 || typeof res.body?.response !== 'string') {
      throw new Error(`chat message failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
      response: res.body.response as string,
      sessionEnded: res.body.sessionEnded === true,
      sessionId: (res.body.sessionId as string) ?? sessionId,
    };
  }

  /** Send a chat turn WITHOUT throwing on a non-200, returning the raw status +
   *  body. Used by beats that expect the message to be rejected (e.g. the
   *  eligibility gate already ended the session → 400 "not active"). */
  async chatMessageRaw(
    agent: Agent,
    sessionId: string,
    message: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await agent.post('/api/chat/message').send({ sessionId, message });
    return { status: res.status, body: res.body };
  }

  async endChat(agent: Agent, sessionId: string): Promise<void> {
    await agent.post('/api/chat/end').send({ sessionId });
  }

  // ---- realtime-text pipeline (/logs/batch) ----

  async postParticipantTurn(agent: Agent, sessionId: string, text: string): Promise<void> {
    await this.postBatch(agent, sessionId, 'user', text);
  }

  /** Fixed, safe assistant stub so the judge sees a two-sided transcript
   *  (spec §3.4). Never scored — logs.routes gates on role==='user'. */
  async postAssistantStub(agent: Agent, sessionId: string, text: string): Promise<void> {
    await this.postBatch(agent, sessionId, 'assistant', text, { redteam_stub: true });
  }

  /** A REAL assistant reply (voice pipeline): logged like the browser logs the
   *  model's transcript, with no stub marker, so the judge scores it. */
  async postAssistantTurn(agent: Agent, sessionId: string, text: string): Promise<void> {
    await this.postBatch(agent, sessionId, 'assistant', text);
  }

  private async postBatch(
    agent: Agent,
    sessionId: string,
    role: 'user' | 'assistant',
    message: string,
    extras?: Record<string, unknown>,
  ): Promise<void> {
    const before = this.emissions.length;
    const res = await agent.post('/logs/batch').send({
      records: [{ timestamp: new Date().toISOString(), sessionId, role, type: 'text', message, extras: extras ?? null }],
    });
    if (res.status !== 200) throw new Error(`/logs/batch failed: ${res.status} ${res.text}`);
    await this.waitForBatchProcessed(sessionId, before);
  }

  /**
   * /logs/batch acks immediately and runs crisis detection + emissions in a
   * setImmediate callback. That callback ENDS by emitting `session:activity` for
   * the session, so once we see a fresh one we know crisis flag/intervention/
   * emission writes for this batch have all completed.
   */
  private async waitForBatchProcessed(sessionId: string, sinceIndex: number, timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const done = this.emissions
        .slice(sinceIndex)
        .some(e => e.event === 'session:activity' && this.emissionMatchesSession(e, sessionId));
      if (done) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for /logs/batch processing of session ${sessionId}`);
  }

  private emissionMatchesSession(e: CapturedEmission, sessionId: string): boolean {
    if (e.room === 'admin-broadcast') {
      const p = e.payload as { sessionId?: string } | undefined;
      return p?.sessionId === sessionId;
    }
    return e.room === `session:${sessionId}` || e.room.includes(sessionId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
