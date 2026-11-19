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
  /** Every therapy session id this run created, in order (chat starts and
   *  realtime-text ids via noteSession). The cost pass reads usage by these. */
  readonly sessionsStarted: string[] = [];
  /** Sessions a scenario found already active and had to end first. */
  readonly staleSessionsEnded: string[] = [];
  /** Chat sessions started and not yet ended, with the agent that owns them. */
  private readonly openChats = new Map<string, Agent>();
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
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
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
  async loginParticipant(agent: Agent, participant = this.participant): Promise<void> {
    const res = await agent.post('/api/auth/login').send(participant);
    if (res.status !== 200 || res.body?.success !== true) {
      throw new Error(`participant login failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await agent.get('/api/auth/status');
      if (
        status.status === 200 &&
        status.body?.authenticated === true &&
        typeof status.body?.user?.userid === 'number'
      ) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `participant login did not persist to the session store within 10s (last status: ${JSON.stringify(status.body)})`,
        );
      }
      await sleep(100);
    }
  }

  /** Log in a STAFF account (assistant pipeline, ai-therapist-207) and wait
   *  for the session store to reflect it — same race as loginParticipant.
   *  Returns the numeric userid so assertions can bind to assistant_audit. */
  async loginStaff(agent: Agent, username: string, password: string): Promise<number> {
    const res = await agent.post('/api/auth/login').send({ username, password });
    if (res.status !== 200 || res.body?.success !== true) {
      throw new Error(`staff login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await agent.get('/api/auth/status');
      if (
        status.status === 200 &&
        status.body?.authenticated === true &&
        typeof status.body?.user?.userid === 'number'
      ) {
        return status.body.user.userid as number;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `staff login for ${username} did not persist to the session store within 10s (last status: ${JSON.stringify(status.body)})`,
        );
      }
      await sleep(100);
    }
  }

  // ---- admin assistant pipeline (/admin/api/assistant/chat) ----

  /** One assistant turn: the full user/assistant history (ending with the
   *  new question) in, the final answer + the tool trail the service ran out.
   *  Throws on any non-200: a staff question must always be answered (a 503
   *  here means ASSISTANT_ENABLED is not set in-process). */
  async assistantTurn(
    agent: Agent,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{ answer: string; toolCalls: Array<{ name: string; rowCount: number }> }> {
    const res = await agent.post('/admin/api/assistant/chat').send({ messages });
    if (res.status !== 200 || typeof res.body?.answer !== 'string') {
      throw new Error(`assistant chat failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return parseAssistantReply(res.body);
  }

  /** Accept the CURRENT consent version on this agent's cookie (spec R8). */
  async acceptConsent(agent: Agent): Promise<void> {
    const res = await agent.post('/api/consent/accept').send({ consentVersion: this.consentVersion });
    if (res.status !== 200) throw new Error(`consent accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // ---- chat pipeline ----

  /** Start a chat session. `opening` is the server-authored first assistant
   *  turn (utils/openingLine.ts) — callers must put it at the head of the
   *  transcript so disclaimer assertions see what the participant sees.
   *
   *  Every chat scenario logs in as the same participant, and /api/chat/start
   *  answers an account that already has an active session with that session
   *  (`alreadyActive: true`). Accepting it ran the next scenario inside the
   *  previous one's session, inheriting its risk history and crisis flag
   *  (ai-therapist-307), so a pre-existing session is an error here, as is a
   *  session id this client has handed out before. Scenarios start through
   *  startFreshChat, which clears a leaked session first. */
  async startChat(agent: Agent, opts: ChatStartOptions = {}): Promise<{ sessionId: string; opening: string | null }> {
    const body = { language: 'en', ...(opts.checkin ? { checkin: opts.checkin } : {}) };
    let res = await agent.post('/api/chat/start').send(body);
    // chat.routes' chatStartLimiter allows 20 starts per 15 minutes per IP, and
    // every in-process scenario shares one IP. A full suite with 20+ chat
    // scenarios can trip it; the limiter's own 429 carries no body (a session-
    // limit 429 does), so wait out its window once instead of failing the
    // scenario. Never retried for a session-limit 429.
    const resetSeconds = Number(res.headers?.['ratelimit-reset']);
    if (res.status === 429 && !res.body?.error && Number.isFinite(resetSeconds) && resetSeconds <= 16 * 60) {
      console.warn(`[redteam] chat start rate-limited; waiting ${resetSeconds}s for the limiter window`);
      await sleep((resetSeconds + 1) * 1000);
      res = await agent.post('/api/chat/start').send(body);
    }
    if (res.status !== 200 || !res.body?.sessionId) {
      throw new Error(`chat start failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const sessionId = res.body.sessionId as string;
    if (res.body.alreadyActive === true) throw new StaleChatSessionError(sessionId);
    if (this.sessionsStarted.includes(sessionId)) {
      throw new Error(`chat start returned ${sessionId}, a session an earlier scenario already used`);
    }
    this.sessionsStarted.push(sessionId);
    this.openChats.set(sessionId, agent);
    return {
      sessionId,
      opening: typeof res.body.opening === 'string' && res.body.opening ? (res.body.opening as string) : null,
    };
  }

  /** Start a chat session that is guaranteed new. A session the participant
   *  still has open (a previous scenario that never reached its teardown) is
   *  ended through the normal /api/chat/end route and reported loudly, then the
   *  start is retried once; a second pre-existing session throws. */
  async startFreshChat(
    agent: Agent,
    opts: ChatStartOptions = {},
  ): Promise<{ sessionId: string; opening: string | null }> {
    try {
      return await this.startChat(agent, opts);
    } catch (err) {
      if (!(err instanceof StaleChatSessionError)) throw err;
      console.error(
        `[redteam] HARNESS LEAK: the participant already had active chat session ${err.sessionId}; ` +
          'ending it before this scenario starts (an earlier scenario skipped its teardown)',
      );
      this.staleSessionsEnded.push(err.sessionId);
      await this.endChat(agent, err.sessionId);
      return this.startChat(agent, opts);
    }
  }

  /**
   * Run a scenario's turns inside `sessionId` and always end the session
   * afterwards, including when a turn throws (ai-therapist-307). On success a
   * failed end is an error; after a failure the end is best-effort and the
   * turn's own error is the one rethrown.
   */
  async driveChatSession<T>(agent: Agent, sessionId: string, turns: () => Promise<T>): Promise<T> {
    let out: T;
    try {
      out = await turns();
    } catch (err) {
      await this.endChat(agent, sessionId).catch((endErr: Error) =>
        console.error(`[redteam] could not end chat session ${sessionId} after a failure: ${endErr.message}`),
      );
      throw err;
    }
    await this.endChat(agent, sessionId);
    return out;
  }

  /** End every chat session this client started and has not seen end. Runs in
   *  each scenario's teardown as a backstop; returns the ids it had to end. */
  async endOpenChats(): Promise<string[]> {
    const ended: string[] = [];
    for (const [sessionId, agent] of [...this.openChats]) {
      try {
        await this.endChat(agent, sessionId);
        ended.push(sessionId);
      } catch (err) {
        this.openChats.delete(sessionId);
        console.error(`[redteam] could not end leftover chat session ${sessionId}: ${(err as Error).message}`);
      }
    }
    return ended;
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
  async chatMessageRaw(agent: Agent, sessionId: string, message: string): Promise<{ status: number; body: unknown }> {
    const res = await agent.post('/api/chat/message').send({ sessionId, message });
    return { status: res.status, body: res.body };
  }

  /** End a chat session (idempotent on the server: an already-ended session
   *  answers 200). Throws on anything else, so a session that could not be
   *  ended is never mistaken for a clean teardown. */
  async endChat(agent: Agent, sessionId: string): Promise<void> {
    const res = await agent.post('/api/chat/end').send({ sessionId });
    if (res.status !== 200)
      throw new Error(`chat end failed for ${sessionId}: ${res.status} ${JSON.stringify(res.body)}`);
    this.openChats.delete(sessionId);
  }

  // ---- realtime-text pipeline (/logs/batch) ----

  /** Record a session id the harness made up itself (realtime-text), so the
   *  cost pass can find its usage rows. */
  noteSession(sessionId: string): void {
    if (!this.sessionsStarted.includes(sessionId)) this.sessionsStarted.push(sessionId);
  }

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
      records: [
        { timestamp: new Date().toISOString(), sessionId, role, type: 'text', message, extras: extras ?? null },
      ],
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
        .some((e) => e.event === 'session:activity' && this.emissionMatchesSession(e, sessionId));
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

/** What a scenario can send with /api/chat/start besides the language. */
export interface ChatStartOptions {
  /** The pre-session check-in, as the client's check-in form posts it. */
  checkin?: { mood?: number; topic?: string; goal?: string };
}

/** /api/chat/start handed back a session the participant already had open. */
export class StaleChatSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `chat start returned the participant's pre-existing active session ${sessionId} (alreadyActive); ` +
        'refusing to run a scenario inside the session of another scenario',
    );
    this.name = 'StaleChatSessionError';
  }
}

/** Normalise the assistant endpoint's body: `answer` plus a `toolCalls`
 *  trail of {name, rowCount}; anything malformed in the trail is dropped
 *  rather than crashing the run (the audit table is the durable record). */
export function parseAssistantReply(body: unknown): {
  answer: string;
  toolCalls: Array<{ name: string; rowCount: number }>;
} {
  const b = (body ?? {}) as { answer?: unknown; toolCalls?: unknown };
  const answer = typeof b.answer === 'string' ? b.answer : '';
  const toolCalls = Array.isArray(b.toolCalls)
    ? b.toolCalls
        .filter(
          (t): t is { name: string; rowCount?: unknown } =>
            !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string',
        )
        .map((t) => ({ name: t.name, rowCount: typeof t.rowCount === 'number' ? t.rowCount : 0 }))
    : [];
  return { answer, toolCalls };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
