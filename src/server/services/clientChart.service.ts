// Clinician chart bundle (ai-therapist-199 item 3): the therapist-side
// counterpart of the participant's own /api/me/export. One zip per client
// with the clinical record as flat CSVs plus the latest safety plan as JSON
// and a README naming who exported what, when, and under which scope.
//
// Role rule (docs/data-access-boundary.md sections 1-4): therapists see raw
// content for their caseload clients, so their bundle carries note content,
// the safety plan and crisis/intervention free text. Researchers are
// org-scoped and never get verbatim participant content: their bundle keeps
// the note ledger (signer, time, hash) without content, omits the safety
// plan, and blanks the crisis free-text columns. Caseworkers never reach
// this service (the route is requireRole('therapist','researcher')).
//
// The shaping helpers are pure and exported for unit tests; buildClientChart
// fans out the reads through the db barrel.
import archiver from 'archiver';
import type { Writable } from 'node:stream';
import { toCsv, type BuiltFile, type DatasetColumn } from './datasetExport.service.js';
import {
  getClientSignedNotes,
  getClientScreeners,
  getClientSessionSummaries,
  getClientCrisisEvents,
  getClientInterventionActions,
  getUserLatestSafetyPlan,
  listAssignmentsForClient,
  listEscalations,
  type CareNoteRow,
  type ClientScreenerRow,
  type ClientSessionSummaryRow,
  type ClientCrisisEventRow,
  type ClientInterventionRow,
  type PracticeAssignmentListRow,
  type EscalationRow,
  type SafetyPlan,
} from '../db/index.js';

export type ChartViewerRole = 'therapist' | 'researcher';

export interface ChartClient {
  userid: number;
  username: string;
}

export interface ChartExporter {
  userId: number;
  username: string;
  role: ChartViewerRole;
}

export interface BuildChartOptions {
  /** Researcher organization; scopes escalations. Ignored for therapists. */
  orgId?: number | null;
  /** Overridable so tests can pin the README timestamp. */
  generatedAt?: string;
}

export interface ClientChart {
  client: ChartClient;
  exporter: ChartExporter;
  generatedAt: string;
  /** 'full' (therapist, verbatim content) or 'summary' (researcher). */
  scope: 'full' | 'summary';
  files: BuiltFile[];
  /** Archive entry names, in zip order. */
  manifest: string[];
  rowCounts: Record<string, number>;
}

type Row = Record<string, unknown>;
type EscalationListRow = EscalationRow & { client_username: string | null; assigned_username: string | null };

/** Whether the viewer may receive verbatim participant content. */
export function chartScopeFor(role: ChartViewerRole): 'full' | 'summary' {
  return role === 'therapist' ? 'full' : 'summary';
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function joinList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => String(v)).join('; ');
}

/** CSV with the given header order, reusing the dataset serializer rules. */
export function rowsToCsv(headers: string[], rows: Row[]): string {
  const columns: DatasetColumn[] = headers.map((name) => ({ name, type: 'string', source: 'client_chart' }));
  return toCsv(columns, rows);
}

// ---------------------------------------------------------------------------
// Shaping helpers (pure).
// ---------------------------------------------------------------------------

export const NOTES_HEADERS = [
  'note_id',
  'note_type',
  'case_note_kind',
  'status',
  'session_id',
  'author_name',
  'author_role',
  'signed_at',
  'sign_hash',
  'amends_note_id',
  'shared_with_care_team',
  'seed_source',
  'created_at',
  'updated_at',
  'content',
];

/** Signed/amended notes ledger. Content is included only for a full-scope viewer. */
export function notesRows(notes: CareNoteRow[], scope: 'full' | 'summary'): Row[] {
  return notes.map((n) => ({
    note_id: n.note_id,
    note_type: n.note_type,
    case_note_kind: n.case_note_kind,
    status: n.status,
    session_id: n.session_id,
    author_name: n.author_name,
    author_role: n.author_role,
    signed_at: iso(n.signed_at),
    sign_hash: n.sign_hash,
    amends_note_id: n.amends_note_id,
    shared_with_care_team: n.shared_with_care_team,
    seed_source: n.seed_source,
    created_at: iso(n.created_at),
    updated_at: iso(n.updated_at),
    content: scope === 'full' ? n.content : null,
  }));
}

export const SCREENERS_HEADERS = ['session_id', 'scale', 'score', 'answers', 'created_at'];

export function screenerRows(screeners: ClientScreenerRow[]): Row[] {
  return screeners.map((s) => ({
    session_id: s.session_id,
    scale: s.scale,
    score: s.score,
    answers: s.answers ?? null,
    created_at: iso(s.created_at),
  }));
}

export const SESSION_SUMMARY_HEADERS = [
  'session_id',
  'session_name',
  'started_at',
  'ended_at',
  'duration_minutes',
  'session_type',
  'modality',
  'risk_band',
  'crisis_flagged',
  'headline',
  'topics',
  'mood_trajectory',
  'techniques_discussed',
  'techniques_helped',
  'follow_up',
  'safety',
];

/** One row per ended session; summary fields only (no SOAP note). */
export function sessionSummaryRows(sessions: ClientSessionSummaryRow[]): Row[] {
  return sessions.map((s) => {
    const summary = s.summary ?? {};
    return {
      session_id: s.session_id,
      session_name: s.session_name,
      started_at: iso(s.started_at),
      ended_at: iso(s.ended_at),
      duration_minutes: s.duration_minutes,
      session_type: s.session_type,
      modality: s.modality,
      risk_band: s.crisis_severity ?? 'none',
      crisis_flagged: Boolean(s.crisis_flagged),
      headline: summary.headline ?? null,
      topics: joinList(summary.topics),
      mood_trajectory: summary.mood_trajectory ?? null,
      techniques_discussed: joinList(summary.techniques_discussed),
      techniques_helped: joinList(summary.techniques_helped),
      follow_up: summary.follow_up ?? null,
      safety: summary.safety ?? null,
    };
  });
}

export const CRISIS_HISTORY_HEADERS = [
  'kind',
  'id',
  'occurred_at',
  'session_id',
  'origin',
  'type',
  'severity',
  'previous_severity',
  'risk_score',
  'previous_risk_score',
  'actor',
  'trigger_method',
  'risk_factors',
  'outcome',
  'notes',
];

/**
 * Events and interventions interleaved chronologically. The free-text
 * columns (notes, outcome) may quote the participant, so they are blanked
 * unless the viewer has full scope.
 */
export function crisisHistoryRows(
  events: ClientCrisisEventRow[],
  interventions: ClientInterventionRow[],
  scope: 'full' | 'summary',
): Row[] {
  const verbatim = scope === 'full';
  const rows: (Row & { _t: number })[] = [];
  for (const e of events) {
    rows.push({
      _t: new Date(e.created_at).getTime(),
      kind: 'event',
      id: e.event_id,
      occurred_at: iso(e.created_at),
      session_id: e.session_id,
      origin: e.origin,
      type: e.event_type,
      severity: e.severity,
      previous_severity: e.previous_severity,
      risk_score: e.risk_score,
      previous_risk_score: e.previous_risk_score,
      actor: e.triggered_by,
      trigger_method: e.trigger_method,
      risk_factors: joinList(e.risk_factors),
      outcome: null,
      notes: verbatim ? e.notes : null,
    });
  }
  for (const a of interventions) {
    rows.push({
      _t: new Date(a.performed_at).getTime(),
      kind: 'intervention',
      id: a.action_id,
      occurred_at: iso(a.performed_at),
      session_id: a.session_id,
      origin: 'session',
      type: a.action_type,
      severity: null,
      previous_severity: null,
      risk_score: a.risk_score,
      previous_risk_score: null,
      actor: a.performed_by,
      trigger_method: null,
      risk_factors: null,
      outcome: verbatim ? a.outcome : null,
      notes: verbatim ? a.notes : null,
    });
  }
  rows.sort((a, b) => a._t - b._t || String(a.kind).localeCompare(String(b.kind)) || Number(a.id) - Number(b.id));
  return rows.map(({ _t: _ignored, ...row }) => row);
}

export const ASSIGNMENTS_HEADERS = [
  'id',
  'session_id',
  'title',
  'description',
  'kind',
  'suggested_frequency',
  'status',
  'source',
  'authored_by',
  'assigned_at',
  'completed_at',
  'completion_note',
  'cancelled_at',
  'cancelled_by',
  'cancel_reason',
  'reissued_from',
];

export function assignmentRows(assignments: PracticeAssignmentListRow[]): Row[] {
  return assignments.map((a) => ({
    id: a.id,
    session_id: a.session_id,
    title: a.title,
    description: a.description,
    kind: a.kind,
    suggested_frequency: a.suggested_frequency,
    status: a.status,
    source: a.source,
    authored_by: a.authored_by_username,
    assigned_at: iso(a.assigned_at),
    completed_at: iso(a.completed_at),
    completion_note: a.completion_note,
    cancelled_at: iso(a.cancelled_at),
    cancelled_by: a.cancelled_by_username,
    cancel_reason: a.cancel_reason,
    reissued_from: a.reissued_from,
  }));
}

export const ESCALATIONS_HEADERS = [
  'escalation_id',
  'status',
  'urgency',
  'reason',
  'raised_by_role',
  'assigned_to',
  'crisis_event_id',
  'session_id',
  'note_id',
  'created_at',
  'acknowledged_at',
  'resolved_at',
  'resolution_note',
];

export function escalationRows(escalations: EscalationListRow[]): Row[] {
  return escalations.map((e) => ({
    escalation_id: e.escalation_id,
    status: e.status,
    urgency: e.urgency,
    reason: e.reason,
    raised_by_role: e.raised_by_role,
    assigned_to: e.assigned_username,
    crisis_event_id: e.crisis_event_id,
    session_id: e.session_id,
    note_id: e.note_id,
    created_at: iso(e.created_at),
    acknowledged_at: iso(e.acknowledged_at),
    resolved_at: iso(e.resolved_at),
    resolution_note: e.resolution_note,
  }));
}

export interface ReadmeInput {
  client: ChartClient;
  exporter: ChartExporter;
  generatedAt: string;
  scope: 'full' | 'summary';
  files: { name: string; rows: number | null }[];
  omitted: string[];
}

export function buildChartReadme(input: ReadmeInput): string {
  const lines = [
    'AI Therapist - client chart bundle',
    '',
    `Client reference: ${input.client.username} (id ${input.client.userid})`,
    `Exported by: ${input.exporter.username} (id ${input.exporter.userId}, role ${input.exporter.role})`,
    `Generated at: ${input.generatedAt}`,
    `Scope: ${
      input.scope === 'full'
        ? 'full - treating-clinician view; includes signed note content, the safety plan and crisis free text'
        : 'summary - organization-scoped research view; note ledger without content, no safety plan, crisis free text blanked'
    }`,
    '',
    'Files:',
    ...input.files.map((f) => `  ${f.name}${f.rows === null ? '' : ` (${f.rows} rows)`}`),
  ];
  if (input.omitted.length > 0) {
    lines.push('', 'Not included at this scope:', ...input.omitted.map((name) => `  ${name}`));
  }
  lines.push(
    '',
    'This export is recorded in the data access log (action: export, kind: client_chart).',
    "It contains only this client's record. Handle as protected health information.",
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build + stream.
// ---------------------------------------------------------------------------

export async function buildClientChart(
  client: ChartClient,
  exporter: ChartExporter,
  opts: BuildChartOptions = {},
): Promise<ClientChart> {
  const scope = chartScopeFor(exporter.role);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const clientId = client.userid;

  const [notes, screeners, sessions, safetyPlan, events, interventions, assignments, escalations] = await Promise.all([
    getClientSignedNotes(clientId),
    getClientScreeners(clientId),
    getClientSessionSummaries(clientId),
    scope === 'full' ? getUserLatestSafetyPlan(clientId) : Promise.resolve(null),
    getClientCrisisEvents(clientId),
    getClientInterventionActions(clientId),
    listAssignmentsForClient(clientId, 1000),
    listEscalations({
      clientId,
      orgId: exporter.role === 'researcher' ? (opts.orgId ?? null) : null,
      limit: 1000,
    }),
  ]);

  const csvFiles: { name: string; rows: Row[]; headers: string[] }[] = [
    { name: 'notes.csv', headers: NOTES_HEADERS, rows: notesRows(notes, scope) },
    { name: 'screeners.csv', headers: SCREENERS_HEADERS, rows: screenerRows(screeners) },
    { name: 'session_summaries.csv', headers: SESSION_SUMMARY_HEADERS, rows: sessionSummaryRows(sessions) },
    {
      name: 'crisis_history.csv',
      headers: CRISIS_HISTORY_HEADERS,
      rows: crisisHistoryRows(events, interventions, scope),
    },
    { name: 'assignments.csv', headers: ASSIGNMENTS_HEADERS, rows: assignmentRows(assignments) },
    { name: 'escalations.csv', headers: ESCALATIONS_HEADERS, rows: escalationRows(escalations as EscalationListRow[]) },
  ];

  const files: BuiltFile[] = [];
  const rowCounts: Record<string, number> = {};
  const readmeFiles: ReadmeInput['files'] = [];
  const omitted: string[] = [];

  for (const f of csvFiles) {
    files.push({ name: f.name, content: rowsToCsv(f.headers, f.rows) });
    rowCounts[f.name] = f.rows.length;
    readmeFiles.push({ name: f.name, rows: f.rows.length });
  }

  if (scope === 'full') {
    const plan: { plan: SafetyPlan; created_at: string | null; session_id: string | null } | null = safetyPlan
      ? { plan: safetyPlan.plan, created_at: iso(safetyPlan.created_at), session_id: safetyPlan.session_id }
      : null;
    files.push({
      name: 'safety_plan.json',
      content: JSON.stringify({ exported_at: generatedAt, safety_plan: plan }, null, 2) + '\n',
    });
    rowCounts['safety_plan.json'] = plan ? 1 : 0;
    readmeFiles.push({ name: 'safety_plan.json', rows: null });
  } else {
    omitted.push('safety_plan.json (participant free text; treating clinician only)');
    omitted.push('notes.csv content column (note ledger only at this scope)');
  }

  readmeFiles.push({ name: 'README.txt', rows: null });
  files.push({
    name: 'README.txt',
    content: buildChartReadme({ client, exporter, generatedAt, scope, files: readmeFiles, omitted }),
  });

  return {
    client,
    exporter,
    generatedAt,
    scope,
    files,
    manifest: files.map((f) => f.name),
    rowCounts,
  };
}

/** Download filename: client reference + date, with the reference made path-safe. */
export function chartZipFilename(client: ChartClient, generatedAt: string): string {
  const ref = client.username.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || `user-${client.userid}`;
  return `client-${ref}-chart-${generatedAt.slice(0, 10)}.zip`;
}

/** Stream the bundle as a zip to `out`; resolves once fully written. */
export function streamChartZip(chart: ClientChart, out: Writable): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const date = new Date(chart.generatedAt);
  const done = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    out.on('close', () => resolve());
    out.on('finish', () => resolve());
  });
  archive.pipe(out);
  for (const f of chart.files) {
    archive.append(f.content, { name: f.name, date: isNaN(date.getTime()) ? new Date(0) : date });
  }
  archive.finalize();
  return done;
}
