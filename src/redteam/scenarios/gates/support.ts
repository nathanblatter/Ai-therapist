// Shared plumbing for the judge-free gate and data-access scenarios
// (docs/eval-scenario-catalogue.md A2 GATE-*, A13 STAFF-10).
//
// Every scenario in this family runs on the `http` pipeline: no persona, no
// model, no judge. It seeds its own accounts (fixed usernames, reserved
// userids for participants) and rows, drives the real Express routes through
// the in-process supertest agent, and records each response under a stable
// key for the final assertions.
//
// Rules every probe here keeps, so the family stays model-free even on a run
// with OPENAI_API_KEY set:
//   - No probe ever ends a session through a route (POST /api/chat/end,
//     admin end, wind-down): every end path starts redaction, naming and
//     insights jobs, which call a model. A session a probe had to create is
//     closed directly in the disposable database instead.
//   - The positive control for "the gates let this caller through" is
//     POST /api/live/session with NO SDP offer: every gate runs first, and a
//     caller who passes them all gets 400 "An SDP offer is required" before
//     anything is created or any vendor is called.
//   - Each scenario sends its requests from its own documentation-range or
//     well-known US address in X-Forwarded-For (`trust proxy` is 1), so its
//     calls land in their own rate-limit bucket and never spend the shared
//     127.0.0.1 budget the chat scenarios rely on.
//
// Server modules are imported dynamically inside functions only: the
// scenario registry is imported statically by cli.ts, before its env guards
// run, and by offline vitest suites that must not open a database pool.
import bcrypt from 'bcrypt';
import type { Agent, HarnessClient } from '../../harnessClient.js';
import type { AssertionSpec, DbLike, HttpProbeRecord, HttpStep } from '../../types.js';

export const GATE_PASSWORD = 'redteam-Passw0rd!';

/** A US address (Google DNS) and two that must be refused: a UK address from
 *  geoip-lite's own test fixtures and a private address with no geolocation. */
export const US_IP = '8.8.8.8';
export const UK_IP = '81.2.69.142';
export const UNKNOWN_GEO_IP = '10.11.12.13';

/** The organization the clinical-pilot staff fixtures live in. */
export const PILOT_ORG_SLUG = 'redteam-gates-pilot';
const IRB_STUDY_SLUG = 'irb-study';

export interface GateAccount {
  username: string;
  role: 'participant' | 'researcher' | 'therapist' | 'caseworker';
  /** Participants get a reserved userid (scripts/redteam-seed-user.mjs explains
   *  why); staff take the sequence. */
  userid?: number;
  org?: 'irb-study' | 'pilot';
}

/** Seed (or reset) accounts. Idempotent: an existing row is put back to the
 *  declared role, organization and an active study status. Returns userids. */
export async function ensureGateAccounts(pool: DbLike, accounts: GateAccount[]): Promise<Record<string, number>> {
  if (accounts.some((a) => a.org === 'pilot')) {
    await pool.query(
      `INSERT INTO organizations (slug, name, kind) VALUES ($1, 'Red-team gates clinical pilot', 'practice')
       ON CONFLICT (slug) DO NOTHING`,
      [PILOT_ORG_SLUG],
    );
  }
  const hash = await bcrypt.hash(GATE_PASSWORD, 10);
  const ids: Record<string, number> = {};
  for (const a of accounts) {
    const slug = a.org === 'pilot' ? PILOT_ORG_SLUG : IRB_STUDY_SLUG;
    const params = [a.username, hash, a.role, slug];
    const { rows } = a.userid
      ? await pool.query(
          `INSERT INTO users (userid, username, password, role, organization_id)
           VALUES ($5, $1, $2, $3, (SELECT org_id FROM organizations WHERE slug = $4))
           ON CONFLICT (username) DO UPDATE
             SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, password = EXCLUDED.password,
                 study_status = 'active'
           RETURNING userid`,
          [...params, a.userid],
        )
      : await pool.query(
          `INSERT INTO users (username, password, role, organization_id)
           VALUES ($1, $2, $3, (SELECT org_id FROM organizations WHERE slug = $4))
           ON CONFLICT (username) DO UPDATE
             SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, password = EXCLUDED.password,
                 study_status = 'active'
           RETURNING userid`,
          params,
        );
    ids[a.username] = Number(rows[0].userid);
  }
  return ids;
}

/** A fresh cookie jar whose every request comes from `ip`. */
export function agentFrom(client: HarnessClient, ip: string): Agent {
  const agent = client.newAgent();
  // superagent agents carry default headers onto every request they make.
  (agent as unknown as { set: (k: string, v: string) => void }).set('X-Forwarded-For', ip);
  return agent;
}

/** Log in on a fresh agent from `ip` (the login route is exempt from the
 *  US-only filter, so this works from any address). */
export async function loginFrom(client: HarnessClient, ip: string, username: string): Promise<Agent> {
  const agent = agentFrom(client, ip);
  await client.loginStaff(agent, username, GATE_PASSWORD);
  return agent;
}

/** Log in from an address the US-only filter may refuse. The harness's usual
 *  check (/api/auth/status) is itself filtered there, so this relies on the
 *  login route answering only after its session save callback. */
export async function loginFromRefusedAddress(client: HarnessClient, ip: string, username: string): Promise<Agent> {
  const agent = agentFrom(client, ip);
  const res = await agent.post('/api/auth/login').send({ username, password: GATE_PASSWORD });
  if (res.status !== 200 || res.body?.success !== true) {
    throw new Error(`login failed for ${username} from ${ip}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

/** Accept whatever consent version is active right now. */
export async function acceptActiveConsent(agent: Agent): Promise<string> {
  const status = await agent.get('/api/consent/status');
  const version = status.body?.currentVersion;
  if (status.status !== 200 || typeof version !== 'string') {
    throw new Error(`consent status failed: ${status.status} ${JSON.stringify(status.body)}`);
  }
  const res = await agent.post('/api/consent/accept').send({ consentVersion: version });
  if (res.status !== 200) throw new Error(`consent accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  return version;
}

/** Records responses under stable keys for the assertions. */
export class ProbeRecorder {
  readonly record: HttpProbeRecord = { steps: {}, facts: {} };

  async step(key: string, req: PromiseLike<{ status: number; body: unknown }>): Promise<HttpStep> {
    const res = await req;
    const step = { status: res.status, body: res.body };
    this.record.steps[key] = step;
    return step;
  }

  fact(key: string, value: unknown): void {
    this.record.facts[key] = value;
  }
}

/** The session-start routes a participant can reach. Bodies carry no SDP and
 *  no `recovery` / `continued_from` (those are crisis continuations, which the
 *  gates deliberately let through). */
export const START_ROUTES = {
  chat: '/api/chat/start',
  live: '/api/live/session',
  grok: '/api/grok/session',
  create: '/api/sessions/create',
} as const;
export type StartRoute = keyof typeof START_ROUTES;

export function postStart(agent: Agent, route: StartRoute): PromiseLike<{ status: number; body: unknown }> {
  return agent.post(START_ROUTES[route]).send(route === 'chat' ? { language: 'en' } : {});
}

/** True when a /api/live/session response proves every gate let the caller
 *  through (the handler's own first check refused the missing SDP offer). */
export function passedAllGates(step: HttpStep | undefined): boolean {
  return step?.status === 400 && /SDP offer is required/.test(JSON.stringify(step.body ?? ''));
}

export async function countSessions(pool: DbLike, userId: number): Promise<number> {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM therapy_sessions WHERE user_id = $1`, [userId]);
  return Number(rows[0].n);
}

/**
 * Close any session a probe opened, directly in the disposable database.
 * Never through a route: every route end path starts the post-session model
 * jobs (redaction, naming, insights). Also drops the in-memory chat state.
 */
export async function closeSessionsQuietly(pool: DbLike, userIds: number[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { rows } = await pool.query(
    `UPDATE therapy_sessions SET status = 'ended', ended_at = COALESCE(ended_at, now())
      WHERE user_id = ANY($1::int[]) AND status = 'active'
      RETURNING session_id`,
    [userIds],
  );
  const ids = rows.map((r) => String(r.session_id));
  if (ids.length) {
    const { endChatSession } = await import('../../../server/services/chatTherapy.service.js');
    for (const id of ids) endChatSession(id);
  }
  return ids;
}

/** Short JSON for assertion details. */
export function show(step: HttpStep | undefined): string {
  if (!step) return 'no response recorded';
  const body = JSON.stringify(step.body ?? null);
  return `${step.status} ${body.length > 240 ? `${body.slice(0, 240)}...` : body}`;
}

/** An assertion over the probe record: `check` returns null on pass or the
 *  failure detail. A missing record (probe threw first) is a failure. */
export function probeAssert(
  id: string,
  passDetail: string,
  check: (rec: HttpProbeRecord) => string | null,
  opts: { gating?: boolean } = {},
): AssertionSpec {
  return {
    id,
    gating: opts.gating,
    run: async (ctx) => {
      if (!ctx.http) return { id, passed: false, detail: 'no http probe record', gating: opts.gating !== false };
      let failure: string | null;
      try {
        failure = check(ctx.http);
      } catch (err) {
        failure = `probe record incomplete: ${(err as Error).message}`;
      }
      return {
        id,
        passed: failure === null,
        detail: failure ?? passDetail,
        gating: opts.gating !== false,
      };
    },
  };
}

/** Run `fn` with the process wall clock moved to `target` (and still ticking).
 *  Only backwards moves are allowed: the pg session store compares expiry to
 *  Date.now(), so a forward jump would log every agent out mid-probe. Agents
 *  used under a moved clock must have logged in before it moved. `instanceof
 *  Date` keeps working for dates made before or during the move. */
export async function withClockAt<T>(target: Date, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const offset = target.getTime() - RealDate.now();
  if (offset > 0) throw new Error(`withClockAt: refusing to move the clock forward to ${target.toISOString()}`);
  const Shifted = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return args.length === 0
      ? new RealDate(RealDate.now() + offset)
      : new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(Shifted, RealDate);
  Object.defineProperty(Shifted, 'prototype', { value: RealDate.prototype });
  Object.defineProperty(Shifted, 'now', { value: () => RealDate.now() + offset });
  Object.defineProperty(Shifted, Symbol.hasInstance, { value: (x: unknown) => x instanceof RealDate });
  globalThis.Date = Shifted;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}
