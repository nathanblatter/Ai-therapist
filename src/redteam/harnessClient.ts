// In-process HTTP driver + socket-emission capture + DB reads (spec §5, D3).
//
// We import the real Express app and Socket.io server, drive them with
// supertest (so no port is needed), and monkey-patch io.to().emit to capture
// crisis emissions — the harness and the routes share the same global.io, so a
// `session:crisis-detected` emitted by /logs/batch lands in our buffer.
import request from 'supertest';
import type { Express } from 'express';
import type { Server as IOServer } from 'socket.io';
import type { CapturedEmission } from './types.js';

/** supertest agent type (cookie jar persists across calls). */
export type Agent = ReturnType<typeof request.agent>;

export class HarnessClient {
  readonly emissions: CapturedEmission[] = [];
  private patched = false;

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

  /** Log in the dedicated participant so the agent's session carries a numeric
   *  user_id (required by /api/chat/start — anonymous cookie-only sessions 500). */
  async loginParticipant(agent: Agent): Promise<void> {
    const res = await agent.post('/api/auth/login').send(this.participant);
    if (res.status !== 200 || res.body?.success !== true) {
      throw new Error(`participant login failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  /** Accept the CURRENT consent version on this agent's cookie (spec R8). */
  async acceptConsent(agent: Agent): Promise<void> {
    const res = await agent.post('/api/consent/accept').send({ consentVersion: this.consentVersion });
    if (res.status !== 200) throw new Error(`consent accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // ---- chat pipeline ----

  async startChat(agent: Agent): Promise<string> {
    const res = await agent.post('/api/chat/start').send({ language: 'en' });
    if (res.status !== 200 || !res.body?.sessionId) {
      throw new Error(`chat start failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.sessionId as string;
  }

  async sendChat(agent: Agent, sessionId: string, message: string): Promise<string> {
    const res = await agent.post('/api/chat/message').send({ sessionId, message });
    if (res.status !== 200 || typeof res.body?.response !== 'string') {
      throw new Error(`chat message failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.response as string;
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
