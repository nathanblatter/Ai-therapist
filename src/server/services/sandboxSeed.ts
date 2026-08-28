// Synchronous, deterministic sandbox caseload seeding (caseworker portal,
// docs/caseworker-portal.md section 7). Called from POST /join-sandbox/:token
// after the per-account kind='sandbox' org and the owner account exist.
//
// Guarantees:
//   - NO LLM calls, ever. All content comes from sandboxSeed.fixtures.ts
//     template pools selected by a mulberry32 PRNG seeded from the invite's
//     token_hash (reproducible per account).
//   - Single transaction: either the whole caseload exists or none of it.
//     The owner user + org are created by the caller, which compensates
//     (delete seeded users -> delete owner -> delete org -> release invite)
//     if anything after the seed throws.
//   - Every seeded user row has is_sandbox=TRUE; every seeded session has
//     is_demo=TRUE (so the ~20 existing export/analytics exclusions apply
//     with zero query changes).
//   - Seeded messages always carry content_redacted (identical to content —
//     scripts contain no PHI) so the redaction-gap sweep never re-runs the
//     LLM redactor over sandbox transcripts.
//
// Direct SQL via the pg pool is deliberate here (service-layer precedent:
// contentWipe/dataRetention): the seed backdates created_at across a dozen
// tables, which the db/ query modules rightly do not support.
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { pool } from '../config/db.js';
import { computeSignHash } from '../db/careNotes.queries.js';
import { createLogger } from '../utils/logger.js';
import {
  SANDBOX_PERSONAS,
  CRISIS_PERSONA_HANDLE,
  BRAND_NEW_PERSONA_HANDLE,
  RISK_FACTOR_POOLS,
  SESSION_NAME_POOL,
  CHECKIN_TOPIC_POOL,
  CHECKIN_GOAL_POOL,
  type SandboxPersona,
} from './sandboxSeed.fixtures.js';

const log = createLogger('sandboxSeed');

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG, plenty for fixture selection. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit seed from a sha256-hex token hash (first 8 hex chars). */
export function seedFromTokenHash(tokenHash: string): number {
  const n = Number.parseInt(tokenHash.slice(0, 8), 16);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

type Rng = () => number;

function randInt(rng: Rng, [min, max]: [number, number]): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Linear interpolation start->end across `steps`, with ±1 rng jitter. */
function arcValue(rng: Rng, start: number, end: number, i: number, steps: number, lo: number, hi: number): number {
  const base = steps <= 1 ? end : start + ((end - start) * i) / (steps - 1);
  const jitter = Math.floor(rng() * 3) - 1;
  return clamp(Math.round(base + jitter), lo, hi);
}

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export interface SeedSandboxInput {
  ownerId: number;
  ownerUsername: string;
  ownerRole: 'therapist' | 'caseworker';
  orgId: number;
  /** sandbox_invites.token_hash — the determinism seed */
  tokenHash: string;
}

export interface SeedSandboxResult {
  clientIds: number[];
  counterpartId: number;
  /** every user the seed created (compensating cleanup on a later throw) */
  seededUserIds: number[];
  sessionCount: number;
  rowCount: number;
  escalationId: number;
}

/**
 * Seed a complete synthetic caseload (6-9 fake clients, ~450 rows) into the
 * given sandbox org, in one transaction. Throws (after ROLLBACK) on failure;
 * the caller owns compensation for the pre-existing owner/org rows.
 */
export async function seedSandboxCaseload(input: SeedSandboxInput): Promise<SeedSandboxResult> {
  const rng = mulberry32(seedFromTokenHash(input.tokenHash));
  // One bcrypt hash of an unknown random password, shared by all fake
  // accounts: they are never logged into, and hashing 8 passwords at cost 10
  // would eat most of the signup latency budget.
  const noLoginHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);

  const client = await pool.connect();
  let rowCount = 0;
  const q = async (text: string, params: unknown[] = []) => {
    const res = await client.query(text, params);
    rowCount += res.rowCount ?? 0;
    return res;
  };

  try {
    await client.query('BEGIN');

    // --- pick personas: crisis + brand-new always, plus 4-7 others --------
    const mandatory = SANDBOX_PERSONAS.filter(
      (p) => p.handle === CRISIS_PERSONA_HANDLE || p.handle === BRAND_NEW_PERSONA_HANDLE
    );
    const rest = shuffle(
      rng,
      SANDBOX_PERSONAS.filter((p) => !mandatory.includes(p))
    );
    const personas = [...mandatory, ...rest.slice(0, randInt(rng, [4, 7]))];

    // --- counterpart care-team member (opposite role) ---------------------
    const counterpartRole = input.ownerRole === 'therapist' ? 'caseworker' : 'therapist';
    const counterpartName =
      counterpartRole === 'therapist' ? `sbx_dr_reyes_${input.orgId}` : `sbx_cw_ellis_${input.orgId}`;
    const counterpartRes = await q(
      `INSERT INTO users (username, password, role, organization_id, is_sandbox, created_at)
       VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING userid`,
      [counterpartName, noLoginHash, counterpartRole, input.orgId, new Date(Date.now() - 80 * DAY_MS)]
    );
    const counterpartId: number = counterpartRes.rows[0].userid;

    const clientIds: number[] = [];
    let sessionCount = 0;
    let crisisClientId: number | null = null;
    let crisisEventId: number | null = null;
    let crisisSessionId: string | null = null;

    for (const [ci, persona] of personas.entries()) {
      const ids = await seedClient(q, rng, input, persona, ci, noLoginHash);
      clientIds.push(ids.clientId);
      sessionCount += ids.sessionCount;
      if (persona.crisis) {
        crisisClientId = ids.clientId;
        crisisEventId = ids.openCrisisEventId;
        crisisSessionId = ids.latestSessionId;
        // Counterpart joins the crisis client's care team so cross-role
        // escalation is demoable.
        await q(
          `INSERT INTO therapist_clients (therapist_id, client_id, assigned_by, member_role)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [counterpartId, ids.clientId, input.ownerId, counterpartRole]
        );
      }
    }

    if (crisisClientId === null) {
      throw new Error('sandbox seed invariant: crisis persona missing');
    }

    // --- one open escalation so the queue is never empty ------------------
    // Therapist owner: the fake caseworker raises it to the owner.
    // Caseworker owner: the owner raises it to the fake therapist (populates
    // the caseworker's "my escalations" surface).
    const raisedBy = input.ownerRole === 'therapist' ? counterpartId : input.ownerId;
    const raisedByRole = 'caseworker'; // either the counterpart or the owner — always the caseworker side
    const assignedTo = input.ownerRole === 'therapist' ? input.ownerId : counterpartId;
    const escalationRes = await q(
      `INSERT INTO escalations
         (org_id, client_id, raised_by, raised_by_role, assigned_to, reason, urgency,
          crisis_event_id, session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'urgent', $7, $8, $9, $9)
       RETURNING escalation_id`,
      [
        input.orgId,
        crisisClientId,
        raisedBy,
        raisedByRole,
        assignedTo,
        'Client disclosed passive ideation during a check-in; requesting a clinical follow-up call this week.',
        crisisEventId,
        crisisSessionId,
        new Date(Date.now() - 1 * DAY_MS),
      ]
    );
    const escalationId: number = escalationRes.rows[0].escalation_id;
    await q(
      `INSERT INTO escalation_events (escalation_id, event_type, actor_user_id, actor_username, detail, created_at)
       VALUES ($1, 'created', $2, $3, $4, $5)`,
      [
        escalationId,
        raisedBy,
        input.ownerRole === 'therapist' ? counterpartName : input.ownerUsername,
        JSON.stringify({ urgency: 'urgent' }),
        new Date(Date.now() - 1 * DAY_MS),
      ]
    );

    // --- work items: queue is populated for the owner on day one ----------
    // Pool crisis item (visible to the whole care team) + the inbound
    // escalation for its assignee. Transcript-free by construction.
    if (crisisEventId !== null) {
      await q(
        `INSERT INTO work_items
           (org_id, client_id, assignee_id, assignee_role, item_type, severity, title,
            detail, source_table, source_id, is_sandbox, created_at)
         VALUES ($1, $2, NULL, NULL, 'crisis_flag', 'urgent', $3, $4, 'crisis_events', $5, TRUE, $6)
         ON CONFLICT DO NOTHING`,
        [
          input.orgId,
          crisisClientId,
          'Crisis flag: recent session flagged medium severity',
          JSON.stringify({ severity: 'medium', origin: 'session' }),
          String(crisisEventId),
          new Date(Date.now() - 2 * DAY_MS),
        ]
      );
    }
    await q(
      `INSERT INTO work_items
         (org_id, client_id, assignee_id, assignee_role, item_type, severity, title,
          detail, source_table, source_id, is_sandbox, created_at)
       VALUES ($1, $2, $3, $4, 'escalation_inbound', 'urgent', $5, $6, 'escalations', $7, TRUE, $8)
       ON CONFLICT DO NOTHING`,
      [
        input.orgId,
        crisisClientId,
        assignedTo,
        'therapist', // the assignee is always the therapist side of the pair
        'Escalation: clinical follow-up requested',
        JSON.stringify({ urgency: 'urgent' }),
        String(escalationId),
        new Date(Date.now() - 1 * DAY_MS),
      ]
    );

    await client.query('COMMIT');
    log.info(
      { orgId: input.orgId, clients: clientIds.length, sessions: sessionCount, rows: rowCount },
      'sandbox caseload seeded'
    );
    return {
      clientIds,
      counterpartId,
      seededUserIds: [...clientIds, counterpartId],
      sessionCount,
      rowCount,
      escalationId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Per-client seeding
// ---------------------------------------------------------------------------

type Q = (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;

interface SeedClientResult {
  clientId: number;
  sessionCount: number;
  latestSessionId: string;
  openCrisisEventId: number | null;
}

async function seedClient(
  q: Q,
  rng: Rng,
  input: SeedSandboxInput,
  persona: SandboxPersona,
  clientIndex: number,
  noLoginHash: string
): Promise<SeedClientResult> {
  const weeks = randInt(rng, persona.weeks);
  const sessionsN = randInt(rng, persona.sessions);
  const username = `sbx_${persona.handle}_${input.orgId}`;

  const userRes = await q(
    `INSERT INTO users (username, password, role, organization_id, is_sandbox, created_at)
     VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING userid`,
    [username, noLoginHash, 'participant', input.orgId, new Date(Date.now() - (weeks * 7 + 3) * DAY_MS)]
  );
  const clientId = userRes.rows[0].userid as number;

  await q(
    `INSERT INTO therapist_clients (therapist_id, client_id, assigned_by, member_role)
     VALUES ($1, $2, $1, $3) ON CONFLICT DO NOTHING`,
    [input.ownerId, clientId, input.ownerRole]
  );

  // --- sessions spread over the history window ---------------------------
  const spanDays = weeks * 7;
  const sessionIds: string[] = [];
  const sessionDates: Date[] = [];
  for (let i = 0; i < sessionsN; i++) {
    const daysAgo =
      sessionsN === 1
        ? 2
        : Math.round(spanDays - (i * spanDays) / sessionsN - rng() * 2) + 1;
    const startedAt = new Date(Date.now() - daysAgo * DAY_MS + (9 + Math.floor(rng() * 9)) * 3600_000);
    const durationMin = 25 + Math.floor(rng() * 25);
    const endedAt = new Date(startedAt.getTime() + durationMin * 60_000);
    const sessionId = `sbx-${input.orgId}-${clientIndex}-${i}`;
    const mood = arcValue(rng, persona.mood.start, persona.mood.end, i, sessionsN, 1, 10);
    const name = i === 0 ? 'First session — intake and goals' : pick(rng, SESSION_NAME_POOL);
    await q(
      `INSERT INTO therapy_sessions
         (session_id, user_id, session_name, status, session_type, is_demo, checkin,
          created_at, updated_at, ended_at, ended_by)
       VALUES ($1, $2, $3, 'ended', $4, TRUE, $5, $6, $7, $7, 'user')`,
      [
        sessionId,
        clientId,
        name,
        rng() < 0.5 ? 'chat' : 'realtime',
        JSON.stringify({ mood, topic: pick(rng, CHECKIN_TOPIC_POOL), goal: pick(rng, CHECKIN_GOAL_POOL) }),
        startedAt,
        endedAt,
      ]
    );
    sessionIds.push(sessionId);
    sessionDates.push(startedAt);
  }

  // --- AI SOAP drafts + summaries for every session ----------------------
  for (let i = 0; i < sessionsN; i++) {
    const reviewed = rng() < 0.5 && i < sessionsN - 1; // newest stays draft
    await q(
      `INSERT INTO session_insights
         (session_id, user_id, summary, soap_note, soap_status, soap_reviewed_by,
          soap_reviewed_at, model, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'sandbox-fixture', $8, $8)`,
      [
        sessionIds[i],
        clientId,
        JSON.stringify({
          headline: pick(rng, persona.headlines),
          topics: shuffle(rng, persona.topics).slice(0, 3),
          mood_trajectory: persona.moodArc,
          techniques_discussed: shuffle(rng, persona.techniques).slice(0, 2),
          follow_up: pick(rng, persona.followUps),
        }),
        JSON.stringify({
          subjective: pick(rng, persona.soap.subjective),
          objective: pick(rng, persona.soap.objective),
          assessment: pick(rng, persona.soap.assessment),
          plan: pick(rng, persona.soap.plan),
        }),
        reviewed ? 'reviewed' : 'draft',
        reviewed ? input.ownerUsername : null,
        reviewed ? new Date(sessionDates[i].getTime() + DAY_MS) : null,
        new Date(sessionDates[i].getTime() + 45 * 60_000),
      ]
    );
  }

  // --- showcase transcripts on the two most recent sessions --------------
  // Every other session deliberately has NO transcript (SessionDetail shows
  // the synthetic empty-state card).
  const showcaseCount = Math.min(2, sessionsN);
  for (let s = 0; s < showcaseCount; s++) {
    const sessionIdx = sessionsN - showcaseCount + s;
    const turns = persona.showcase[s];
    for (const [t, turn] of turns.entries()) {
      await q(
        `INSERT INTO messages (session_id, role, message_type, content, content_redacted, created_at)
         VALUES ($1, $2, 'text', $3, $3, $4)`,
        [
          sessionIds[sessionIdx],
          turn.role,
          turn.text,
          new Date(sessionDates[sessionIdx].getTime() + (t + 1) * 90_000),
        ]
      );
    }
  }

  // --- screener trajectories (PHQ-2 / GAD-2, the product's scales) -------
  for (let i = 0; i < sessionsN; i++) {
    for (const scale of ['phq2', 'gad2'] as const) {
      if (rng() < 0.25 && i !== 0 && i !== sessionsN - 1) continue; // sparse middles
      const target = persona[scale];
      const score = arcValue(rng, target.start, target.end, i, sessionsN, 0, 6);
      const a = Math.min(3, score);
      await q(
        `INSERT INTO scale_responses (session_id, scale, answers, score, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          sessionIds[i],
          scale,
          JSON.stringify({ item1: a, item2: score - a }),
          score,
          new Date(sessionDates[i].getTime() + 5 * 60_000),
        ]
      );
    }
  }

  // --- risk history: quiet baseline everywhere, arc on the crisis client --
  let openCrisisEventId: number | null = null;
  for (let i = 0; i < sessionsN; i++) {
    const isCrisisArcSession = persona.crisis === true && i === sessionsN - showcaseCount;
    if (isCrisisArcSession) {
      const arc: Array<[number, string | null, keyof typeof RISK_FACTOR_POOLS, number]> = [
        [12, null, 'quiet', 4],
        [46, 'medium', 'passive', 9],
        [82, 'high', 'active', 14],
        [38, 'medium', 'deescalating', 24],
      ];
      for (const [score, severity, factorKey, minute] of arc) {
        await q(
          `INSERT INTO risk_score_history (session_id, risk_score, severity, score_factors, calculated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            sessionIds[i],
            score,
            severity,
            JSON.stringify(RISK_FACTOR_POOLS[factorKey]),
            new Date(sessionDates[i].getTime() + minute * 60_000),
          ]
        );
      }
    } else if (rng() < 0.7) {
      await q(
        `INSERT INTO risk_score_history (session_id, risk_score, severity, score_factors, calculated_at)
         VALUES ($1, $2, NULL, $3, $4)`,
        [
          sessionIds[i],
          3 + Math.floor(rng() * 12),
          JSON.stringify(RISK_FACTOR_POOLS.quiet),
          new Date(sessionDates[i].getTime() + 10 * 60_000),
        ]
      );
    }
  }

  // --- crisis events + interventions (crisis persona only) ---------------
  if (persona.crisis && sessionsN >= 2) {
    const crisisIdx = sessionsN - showcaseCount; // the anniversary session
    const crisisSession = sessionIds[crisisIdx];
    const base = sessionDates[crisisIdx].getTime();
    // Resolved arc: flagged -> severity change -> de-escalation -> unflagged.
    await q(
      `INSERT INTO crisis_events (session_id, event_type, severity, risk_score, triggered_by, trigger_method, risk_factors, created_at)
       VALUES ($1, 'flagged', 'medium', 46, 'system', 'auto', $2, $3)`,
      [crisisSession, JSON.stringify(RISK_FACTOR_POOLS.passive), new Date(base + 9 * 60_000)]
    );
    await q(
      `INSERT INTO crisis_events (session_id, event_type, severity, previous_severity, risk_score, previous_risk_score, triggered_by, trigger_method, risk_factors, created_at)
       VALUES ($1, 'severity_changed', 'high', 'medium', 82, 46, 'system', 'auto', $2, $3)`,
      [crisisSession, JSON.stringify(RISK_FACTOR_POOLS.active), new Date(base + 14 * 60_000)]
    );
    await q(
      `INSERT INTO crisis_events (session_id, event_type, severity, previous_severity, risk_score, previous_risk_score, triggered_by, trigger_method, notes, created_at)
       VALUES ($1, 'unflagged', 'low', 'high', 20, 82, $2, 'manual', 'Safety plan built in session; sister engaged; care team notified. Monitoring continues.', $3)`,
      [crisisSession, input.ownerUsername, new Date(base + 40 * 60_000)]
    );
    await q(
      `INSERT INTO intervention_actions (session_id, action_type, risk_score, action_details, performed_by, performed_at, outcome)
       VALUES ($1, 'medium_risk_alert', 46, $2, 'system', $3, 'care_team_notified')`,
      [crisisSession, JSON.stringify({ note: 'Care team notified of passive ideation disclosure.' }), new Date(base + 10 * 60_000)]
    );
    await q(
      `INSERT INTO intervention_actions (session_id, action_type, risk_score, action_details, performed_by, performed_at, outcome)
       VALUES ($1, 'clinical_review', 82, $2, 'system', $3, 'safety_plan_created')`,
      [crisisSession, JSON.stringify({ note: 'Safety plan co-built in session; 988 shared.' }), new Date(base + 16 * 60_000)]
    );

    // Recent UNRESOLVED flag on the latest session: the open item the queue
    // and crisis views demo against.
    const latestIdx = sessionsN - 1;
    const latestBase = sessionDates[latestIdx].getTime();
    const openRes = await q(
      `INSERT INTO crisis_events (session_id, event_type, severity, risk_score, triggered_by, trigger_method, risk_factors, notes, created_at)
       VALUES ($1, 'flagged', 'medium', 42, 'system', 'auto', $2, 'Sleep disruption persists post-anniversary; monitoring.', $3)
       RETURNING event_id`,
      [sessionIds[latestIdx], JSON.stringify(RISK_FACTOR_POOLS.passive), new Date(latestBase + 12 * 60_000)]
    );
    openCrisisEventId = openRes.rows[0].event_id as number;
    await q(
      `UPDATE therapy_sessions
       SET crisis_flagged = TRUE, crisis_severity = 'medium', crisis_risk_score = 42,
           crisis_flagged_at = $2, crisis_flagged_by = 'system'
       WHERE session_id = $1`,
      [sessionIds[latestIdx], new Date(latestBase + 12 * 60_000)]
    );

    // Safety plan from the crisis session.
    if (persona.safetyPlan) {
      await q(
        `INSERT INTO safety_plans (session_id, user_id, plan, created_at)
         VALUES ($1, $2, $3, $4)`,
        [crisisSession, clientId, JSON.stringify(persona.safetyPlan), new Date(base + 20 * 60_000)]
      );
    }
  }

  // --- practice assignments + one completed worksheet --------------------
  for (const practice of persona.practice) {
    const assignedIdx = Math.max(0, sessionsN - 2);
    const completed = rng() < 0.6 && sessionsN > 1;
    await q(
      `INSERT INTO practice_assignments
         (user_id, session_id, title, description, kind, suggested_frequency, status, assigned_at, completed_at, completion_note)
       VALUES ($1, $2, $3, $4, $5, 'daily', $6, $7, $8, $9)`,
      [
        clientId,
        sessionIds[assignedIdx],
        practice.title,
        practice.description,
        practice.kind,
        completed ? 'completed' : 'assigned',
        new Date(sessionDates[assignedIdx].getTime() + 50 * 60_000),
        completed ? new Date(sessionDates[assignedIdx].getTime() + 3 * DAY_MS) : null,
        completed ? 'Done most days. Easier than expected.' : null,
      ]
    );
    if (practice.kind === 'worksheet') {
      await q(
        `INSERT INTO worksheet_instances
           (session_id, template_title, title, intro, sections, responses, status, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $8)`,
        [
          sessionIds[assignedIdx],
          practice.title,
          practice.title,
          practice.description,
          JSON.stringify([
            { type: 'textarea', label: 'Situation' },
            { type: 'textarea', label: 'What actually happened' },
          ]),
          JSON.stringify({
            Situation: `Worried about ${persona.topics[0]} before it happened.`,
            'What actually happened': 'It went fine. Writing it down helped me see the pattern.',
          }),
          new Date(sessionDates[assignedIdx].getTime() + 50 * 60_000),
          new Date(sessionDates[assignedIdx].getTime() + 2 * DAY_MS),
        ]
      );
    }
  }

  // --- notes in the inviter's role voice ---------------------------------
  // Therapist owner: signed progress (SOAP) notes + one AI-seeded draft.
  // Caseworker owner: signed case notes from the persona's case-note pool.
  if (input.ownerRole === 'therapist') {
    const noteIdx = Math.max(0, sessionsN - 2);
    await insertNote(q, {
      orgId: input.orgId,
      clientId,
      authorId: input.ownerId,
      authorName: input.ownerUsername,
      authorRole: 'therapist',
      noteType: 'progress',
      caseNoteKind: null,
      sessionId: sessionIds[noteIdx],
      seedSource: null,
      content: {
        subjective: pick(rng, persona.soap.subjective),
        objective: pick(rng, persona.soap.objective),
        assessment: pick(rng, persona.soap.assessment),
        plan: pick(rng, persona.soap.plan),
      },
      signed: true,
      at: new Date(sessionDates[noteIdx].getTime() + 2 * 3600_000),
    });
    if (sessionsN >= 2 && rng() < 0.5) {
      // A draft seeded from the AI SOAP, awaiting signature (demo for the
      // sign flow + note_awaiting_signature queue item semantics).
      await insertNote(q, {
        orgId: input.orgId,
        clientId,
        authorId: input.ownerId,
        authorName: input.ownerUsername,
        authorRole: 'therapist',
        noteType: 'progress',
        caseNoteKind: null,
        sessionId: sessionIds[sessionsN - 1],
        seedSource: 'ai_soap',
        content: {
          subjective: pick(rng, persona.soap.subjective),
          objective: pick(rng, persona.soap.objective),
          assessment: pick(rng, persona.soap.assessment),
          plan: pick(rng, persona.soap.plan),
        },
        signed: false,
        at: new Date(sessionDates[sessionsN - 1].getTime() + 90 * 60_000),
      });
    }
  } else {
    for (const [n, narrative] of persona.caseNotes.entries()) {
      const kinds = ['contact', 'safety_check', 'coordination', 'referral'] as const;
      await insertNote(q, {
        orgId: input.orgId,
        clientId,
        authorId: input.ownerId,
        authorName: input.ownerUsername,
        authorRole: 'caseworker',
        noteType: 'case',
        caseNoteKind: persona.crisis && n === 0 ? 'safety_check' : pick(rng, kinds),
        sessionId: null,
        seedSource: null,
        content: { narrative, contact_method: pick(rng, ['phone', 'in_app_message', 'in_person']), outcome: 'completed' },
        signed: n < persona.caseNotes.length - 1 || rng() < 0.5,
        at: new Date(Date.now() - (persona.caseNotes.length - n) * 6 * DAY_MS),
      });
    }
  }

  return {
    clientId,
    sessionCount: sessionsN,
    latestSessionId: sessionIds[sessionsN - 1],
    openCrisisEventId,
  };
}

async function insertNote(
  q: Q,
  note: {
    orgId: number;
    clientId: number;
    authorId: number;
    authorName: string;
    authorRole: 'therapist' | 'caseworker';
    noteType: 'progress' | 'case';
    caseNoteKind: string | null;
    sessionId: string | null;
    seedSource: 'ai_soap' | null;
    content: Record<string, unknown>;
    signed: boolean;
    at: Date;
  }
): Promise<void> {
  const inserted = await q(
    `INSERT INTO care_notes
       (org_id, client_id, author_id, author_name, author_role, note_type, case_note_kind,
        session_id, seed_source, seed_model, content, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $12)
     RETURNING note_id`,
    [
      note.orgId,
      note.clientId,
      note.authorId,
      note.authorName,
      note.authorRole,
      note.noteType,
      note.caseNoteKind,
      note.sessionId,
      note.seedSource,
      note.seedSource ? 'sandbox-fixture' : null,
      JSON.stringify(note.content),
      note.at,
    ]
  );
  if (!note.signed) return;
  const noteId = inserted.rows[0].note_id as number;
  const signedAt = new Date(note.at.getTime() + 30 * 60_000).toISOString();
  // Status flip with identical content is allowed by the immutability trigger.
  await q(
    `UPDATE care_notes SET status = 'signed', signed_at = $2, sign_hash = $3, updated_at = $2
     WHERE note_id = $1`,
    [
      noteId,
      signedAt,
      computeSignHash({
        note_id: noteId,
        client_id: note.clientId,
        author_id: note.authorId,
        author_name: note.authorName,
        note_type: note.noteType,
        content: note.content,
        signed_at: signedAt,
      }),
    ]
  );
}
