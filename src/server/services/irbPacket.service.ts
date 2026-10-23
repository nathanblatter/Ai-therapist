// IRB continuing-review packet (ai-therapist-107). Composes the counts and
// record projections from db/irbPacket.queries.ts into one structured object,
// and renders it three ways: JSON (the object itself), a self-contained
// printable HTML document, and a zip (JSON + CSV attachments + README).
//
// Rules that every renderer honours:
//   - counts only, except adverse events and protocol deviations, which the
//     IRB needs as records; those rows carry NO participant identifier, NO
//     session id and NO verbatim transcript text;
//   - nothing the packet emits names a user: usernames, emails and raw user
//     ids are never selected, and free-text lines are scrubbed defensively;
//   - the "incidents" section is empty by default and must be written by hand
//     (data-security incidents are not something the database can enumerate).
import archiver from 'archiver';
import type { Writable } from 'node:stream';
import { gitSha } from '../utils/gitSha.js';
import { toCsv, type DatasetColumn } from './datasetExport.service.js';
import { getStudyProtocol } from '../db/studyOps.queries.js';
import { getSystemConfigByKey } from '../db/config.queries.js';
import { getIrbStudyOrgId, getOrganizationById } from '../db/organizations.queries.js';
import {
  getIrbEnrollmentCounts,
  getIrbArmCounts,
  getIrbSessionCounts,
  getIrbSafetyCounts,
  getIrbAdverseEvents,
  getIrbDeviations,
  getIrbConsentVersions,
  getIrbMonitoringCounts,
  getIrbDataAccessCounts,
  type IrbWindow,
  type IrbEnrollmentCounts,
  type IrbArmCount,
  type IrbSessionCounts,
  type IrbSafetyCounts,
  type IrbConsentVersion,
  type IrbMonitoringCounts,
  type IrbDataAccessCount,
} from '../db/irbPacket.queries.js';

export interface BuildIrbPacketInput {
  /** ISO timestamps; from <= to. */
  from: string;
  to: string;
  /** The caller's organization (routes resolve it via orgIdFor). */
  orgId: number;
  /** Overridable for deterministic tests. */
  generatedAt?: string;
}

export interface IrbPacketAdverseEvent {
  report_id: number;
  occurred_at: string;
  severity: string;
  category: string;
  trigger_source: string;
  status: string;
  /** De-identified one-line summary (scrubbed of ids/emails). */
  summary: string;
  submitted_at: string | null;
  closed_at: string | null;
  /** Human-readable resolution state derived from status + last action. */
  resolution: string;
}

export interface IrbPacketDeviation {
  deviation_id: number;
  occurred_at: string;
  source: string;
  category: string;
  severity: string;
  status: string;
  description: string;
  resolved_at: string | null;
}

export interface IrbPacket {
  meta: {
    generated_at: string;
    git_sha: string;
    period: { from: string; to: string };
    organization: { id: number; name: string | null; is_irb_study_org: boolean };
    /** The packet is a snapshot: these are the sources, by section. */
    sources: Record<string, string>;
  };
  study: {
    protocol_id: string | null;
    principal_investigator: string | null;
    study_title: string | null;
    deployment_mode: string;
    enrollment_target: number;
    expected_sessions_per_participant: number;
    study_start: string | null;
    study_end: string | null;
  };
  enrollment: IrbEnrollmentCounts & {
    target: number;
    arms: IrbArmCount[];
  };
  sessions: IrbSessionCounts;
  safety: IrbSafetyCounts;
  adverse_events: {
    total: number;
    by_severity: Record<string, number>;
    by_status: Record<string, number>;
    by_category: Record<string, number>;
    records: IrbPacketAdverseEvent[];
  };
  deviations: {
    total: number;
    by_severity: Record<string, number>;
    by_status: Record<string, number>;
    by_category: Record<string, number>;
    records: IrbPacketDeviation[];
  };
  consent: {
    versions: (Omit<IrbConsentVersion, 'effective_at' | 'superseded_at'> & {
      effective_at: string;
      superseded_at: string | null;
      in_force_at_end: boolean;
    })[];
  };
  monitoring: Omit<IrbMonitoringCounts, 'harness_runs'> & {
    harness_runs: (Omit<IrbMonitoringCounts['harness_runs'][number], 'last_run_at'> & { last_run_at: string | null })[];
  };
  data_access: {
    counts: IrbDataAccessCount[];
    total: number;
  };
  incidents: {
    /** Always empty from the generator: data-security incidents are hand-written. */
    records: never[];
    note: string;
  };
}

export const INCIDENTS_NOTE =
  'No automated source exists for data-security incidents. Fill this section by hand from the ' +
  'on-call log and the security mailbox: date, what happened, data involved, participants ' +
  'affected (count only), containment, and whether the IRB was notified within the reporting window. ' +
  'Write "None during this period" explicitly if that is the case.';

const SOURCES: Record<string, string> = {
  study: 'system_config.study_protocol + deployment_mode',
  enrollment: 'therapy_sessions x users (non-demo, non-sandbox, org-scoped); users.study_status',
  arms: 'session_configurations.proactive_offering / ai_model per in-window session',
  sessions: 'therapy_sessions (created_at in window) x session_configurations.modality',
  safety: 'crisis_events, therapy_sessions.crisis_*, intervention_actions, escalations',
  adverse_events: 'adverse_event_reports (occurred_at in window, org-scoped)',
  deviations: 'protocol_deviations (occurred_at in window; study-global)',
  consent: 'consent_documents in force during window; participant_consents acceptances',
  monitoring: 'eval_drift_alerts; harness_runs (dry runs excluded)',
  data_access: 'data_access_log by action x actor role (actor or participant in org)',
  incidents: 'none - hand-written',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Belt-and-braces scrub of free text that reaches the IRB: internal
 *  participant ids and anything email-shaped are replaced, never emitted. */
export function scrubIdentifiers(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(participant|user|userid|user_id)\s*#?\s*\d+\b/gi, '$1 [id]');
}

function tally<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function resolutionOf(r: { status: string; closed_at: Date | null; submitted_at: Date | null; last_action: string | null }): string {
  if (r.status === 'closed') return `closed${r.last_action ? ` (last action: ${r.last_action})` : ''}`;
  if (r.status === 'submitted') return 'submitted to IRB, awaiting closure';
  return 'draft - not yet submitted';
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildIrbPacket(input: BuildIrbPacketInput): Promise<IrbPacket> {
  const [protocol, protocolRow, modeRow, irbOrgId, org] = await Promise.all([
    getStudyProtocol(),
    getSystemConfigByKey('study_protocol'),
    getSystemConfigByKey('deployment_mode'),
    getIrbStudyOrgId(),
    getOrganizationById(input.orgId),
  ]);
  const ids = (protocolRow?.config_value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const isIrbOrg = irbOrgId !== null && irbOrgId === input.orgId;
  const w: IrbWindow = { from: input.from, to: input.to, orgId: input.orgId, includeUnattributed: isIrbOrg };

  const [enrollment, arms, sessions, safety, aes, deviations, consentVersions, monitoring, dataAccess] =
    await Promise.all([
      getIrbEnrollmentCounts(w, protocol.expected_sessions_per_participant),
      getIrbArmCounts(w),
      getIrbSessionCounts(w),
      getIrbSafetyCounts(w),
      getIrbAdverseEvents(w),
      getIrbDeviations(w),
      getIrbConsentVersions(w),
      getIrbMonitoringCounts(w),
      getIrbDataAccessCounts(w),
    ]);

  const aeRecords: IrbPacketAdverseEvent[] = aes.map(r => ({
    report_id: r.report_id,
    occurred_at: iso(r.occurred_at) ?? '',
    severity: r.severity,
    category: r.category,
    trigger_source: r.trigger_source,
    status: r.status,
    summary: scrubIdentifiers(r.summary),
    submitted_at: iso(r.submitted_at),
    closed_at: iso(r.closed_at),
    resolution: resolutionOf(r),
  }));
  const devRecords: IrbPacketDeviation[] = deviations.map(r => ({
    deviation_id: r.deviation_id,
    occurred_at: iso(r.occurred_at) ?? '',
    source: r.source,
    category: r.category,
    severity: r.severity,
    status: r.status,
    description: scrubIdentifiers(r.description),
    resolved_at: iso(r.resolved_at),
  }));
  const toMs = new Date(input.to).getTime();

  return {
    meta: {
      generated_at: input.generatedAt ?? new Date().toISOString(),
      git_sha: gitSha(),
      period: { from: input.from, to: input.to },
      organization: { id: input.orgId, name: org?.name ?? null, is_irb_study_org: isIrbOrg },
      sources: SOURCES,
    },
    study: {
      protocol_id: str(ids.protocol_id),
      principal_investigator: str(ids.principal_investigator),
      study_title: str(ids.study_title),
      deployment_mode: (modeRow?.config_value as { mode?: string } | null)?.mode ?? 'research',
      enrollment_target: protocol.enrollment_target,
      expected_sessions_per_participant: protocol.expected_sessions_per_participant,
      study_start: protocol.study_start,
      study_end: protocol.study_end,
    },
    enrollment: { ...enrollment, target: protocol.enrollment_target, arms },
    sessions,
    safety,
    adverse_events: {
      total: aeRecords.length,
      by_severity: tally(aeRecords, r => r.severity),
      by_status: tally(aeRecords, r => r.status),
      by_category: tally(aeRecords, r => r.category),
      records: aeRecords,
    },
    deviations: {
      total: devRecords.length,
      by_severity: tally(devRecords, r => r.severity),
      by_status: tally(devRecords, r => r.status),
      by_category: tally(devRecords, r => r.category),
      records: devRecords,
    },
    consent: {
      versions: consentVersions.map(v => {
        const sup = iso(v.superseded_at);
        return {
          version: v.version,
          audience: v.audience,
          effective_at: iso(v.effective_at) ?? '',
          superseded_at: sup,
          in_force_at_end: sup === null || new Date(sup).getTime() > toMs,
          acceptances_in_window: v.acceptances_in_window,
          acceptances_total: v.acceptances_total,
        };
      }),
    },
    monitoring: {
      drift_alerts: monitoring.drift_alerts,
      harness_runs: monitoring.harness_runs.map(h => ({ ...h, last_run_at: iso(h.last_run_at) })),
    },
    data_access: {
      counts: dataAccess,
      total: dataAccess.reduce((a, c) => a + c.n, 0),
    },
    incidents: { records: [], note: INCIDENTS_NOTE },
  };
}

// ---------------------------------------------------------------------------
// CSV attachments + zip
// ---------------------------------------------------------------------------

export interface IrbPacketFile {
  name: string;
  content: string;
}

const col = (name: string, type: DatasetColumn['type'] = 'string'): DatasetColumn => ({ name, type, source: 'irb_packet' });

const AE_COLUMNS = [
  col('report_id', 'int'), col('occurred_at', 'timestamp'), col('severity'), col('category'),
  col('trigger_source'), col('status'), col('summary'), col('submitted_at', 'timestamp'),
  col('closed_at', 'timestamp'), col('resolution'),
];
const DEVIATION_COLUMNS = [
  col('deviation_id', 'int'), col('occurred_at', 'timestamp'), col('source'), col('category'),
  col('severity'), col('status'), col('description'), col('resolved_at', 'timestamp'),
];
const CONSENT_COLUMNS = [
  col('version'), col('audience'), col('effective_at', 'timestamp'), col('superseded_at', 'timestamp'),
  col('in_force_at_end', 'bool'), col('acceptances_in_window', 'int'), col('acceptances_total', 'int'),
];

function renderReadme(p: IrbPacket): string {
  const lines = [
    '# IRB continuing-review packet',
    '',
    `Protocol: ${p.study.protocol_id ?? '(not set - fill by hand)'}`,
    `Principal investigator: ${p.study.principal_investigator ?? '(not set - fill by hand)'}`,
    `Period: ${p.meta.period.from} to ${p.meta.period.to}`,
    `Generated: ${p.meta.generated_at} (build ${p.meta.git_sha})`,
    '',
    '## Files',
    '',
    '- packet.json - every section as structured data (counts; adverse events and deviations as records).',
    '- adverse_events.csv - one row per adverse-event report that occurred in the period. De-identified: no participant reference, session id or transcript excerpt.',
    '- deviations.csv - one row per protocol deviation that occurred in the period.',
    '- consent_versions.csv - consent document versions in force at any point in the period, with acceptance counts.',
    '',
    '## Sources',
    '',
    ...Object.entries(p.meta.sources).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Must be written by hand',
    '',
    '- Incidents: ' + p.incidents.note,
    '- Narrative: progress summary, any changes to the protocol, personnel or consent since the last review, and the PI attestation.',
    '',
    'Generation of this packet is recorded in data_access_log (action export, kind irb_packet).',
    '',
  ];
  return lines.join('\n');
}

export function buildIrbPacketFiles(p: IrbPacket): IrbPacketFile[] {
  return [
    { name: 'packet.json', content: JSON.stringify(p, null, 2) + '\n' },
    { name: 'adverse_events.csv', content: toCsv(AE_COLUMNS, p.adverse_events.records as unknown as Record<string, unknown>[]) },
    { name: 'deviations.csv', content: toCsv(DEVIATION_COLUMNS, p.deviations.records as unknown as Record<string, unknown>[]) },
    { name: 'consent_versions.csv', content: toCsv(CONSENT_COLUMNS, p.consent.versions as unknown as Record<string, unknown>[]) },
    { name: 'README.md', content: renderReadme(p) },
  ];
}

/** Stream the packet zip to `out`; resolves once fully written. */
export function streamIrbPacketZip(p: IrbPacket, out: Writable): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const date = new Date(p.meta.generated_at);
  const done = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    out.on('close', () => resolve());
    out.on('finish', () => resolve());
  });
  archive.pipe(out);
  for (const f of buildIrbPacketFiles(p)) {
    archive.append(f.content, { name: f.name, date: Number.isNaN(date.getTime()) ? new Date(0) : date });
  }
  archive.finalize();
  return done;
}

// ---------------------------------------------------------------------------
// Printable HTML (self-contained: inline CSS, no scripts, no external assets)
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(d: string | null | undefined): string {
  if (!d) return '-';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '-' : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function day(d: string | null | undefined): string {
  if (!d) return '-';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '-' : date.toISOString().slice(0, 10);
}

function table(headers: string[], rows: unknown[][], emptyText = 'None in this period.'): string {
  const head = `<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">${esc(emptyText)}</td></tr>`;
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function kv(pairs: [string, unknown][]): string {
  return `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '-')}</dd>`).join('')}</dl>`;
}

function tallyRows(t: Record<string, number>): unknown[][] {
  return Object.entries(t).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]);
}

function pct(x: number | null): string {
  return x == null ? '-' : `${(x * 100).toFixed(1)}%`;
}

export function renderIrbPacketHtml(p: IrbPacket): string {
  const notSet = '(not set - fill by hand)';
  const armsBy = (dim: IrbArmCount['dimension']) => p.enrollment.arms.filter(a => a.dimension === dim);

  const sections: string[] = [];

  sections.push(`<section><h2>1. Study</h2>${kv([
    ['Protocol', p.study.protocol_id ?? notSet],
    ['Principal investigator', p.study.principal_investigator ?? notSet],
    ['Study title', p.study.study_title ?? notSet],
    ['Deployment mode', p.study.deployment_mode],
    ['Enrollment target', p.study.enrollment_target],
    ['Expected sessions per participant', p.study.expected_sessions_per_participant],
    ['Protocol study window', `${day(p.study.study_start)} to ${day(p.study.study_end)}`],
    ['Organization', `${p.meta.organization.name ?? p.meta.organization.id}${p.meta.organization.is_irb_study_org ? ' (IRB study org; anonymous sessions included)' : ''}`],
  ])}</section>`);

  const e = p.enrollment;
  sections.push(`<section><h2>2. Enrollment</h2>${kv([
    ['Newly enrolled in period', e.enrolled_in_window],
    ['Enrolled to date (cumulative)', `${e.enrolled_to_date} of ${e.target}`],
    ['Active', e.active],
    ['Completed (reached expected sessions)', e.completed],
    ['Paused', `${e.paused} (${e.paused_in_window} in period)`],
    ['Withdrawn', `${e.withdrawn} (${e.withdrawn_in_window} in period)`],
    ['Anonymous (unenrolled) sessions in period', e.anonymous_sessions_in_window],
  ])}
  <h3>Arm balance (in-period sessions)</h3>
  ${table(['proactive_offering', 'sessions', 'participants'], armsBy('proactive_offering').map(a => [a.value, a.sessions, a.participants]), 'No arm data in this period.')}
  ${armsBy('ai_model').length ? `<h3>Model condition</h3>${table(['ai_model', 'sessions', 'participants'], armsBy('ai_model').map(a => [a.value, a.sessions, a.participants]))}` : ''}
  </section>`);

  const s = p.sessions;
  sections.push(`<section><h2>3. Sessions</h2>${kv([
    ['Sessions started in period', s.total],
    ['Sessions ended', s.ended],
    ['Mean duration (minutes, ended sessions)', s.mean_duration_minutes ?? '-'],
  ])}
  <div class="cols">
    <div><h3>By session type</h3>${table(['type', 'n'], s.by_session_type.map(x => [x.value, x.n]))}</div>
    <div><h3>By modality</h3>${table(['modality', 'n'], s.by_modality.map(x => [x.value, x.n]))}</div>
  </div></section>`);

  const sf = p.safety;
  sections.push(`<section><h2>4. Safety monitoring</h2>
  <h3>Crisis events (by type and severity)</h3>
  ${table(['event_type', 'severity', 'n'], sf.crisis_events.map(x => [x.event_type, x.severity, x.n]))}
  <h3>Flagged sessions and outcomes</h3>${kv([
    ['Sessions flagged in period', sf.flagged_sessions.total],
    ['Unflagged after review', sf.flagged_sessions.unflagged_before_end],
    ['Still flagged', sf.flagged_sessions.still_flagged_at_end],
    ['With an adverse-event report', sf.flagged_sessions.with_adverse_event_report],
    ['On-call pages sent', sf.pages_sent],
  ])}
  <div class="cols">
    <div><h3>Interventions by type</h3>${table(['action_type', 'n'], sf.interventions.map(x => [x.action_type, x.n]))}</div>
    <div><h3>Care-team escalations</h3>${table(['status', 'urgency', 'n'], sf.escalations.map(x => [x.status, x.urgency, x.n]))}</div>
  </div></section>`);

  const ae = p.adverse_events;
  sections.push(`<section><h2>5. Adverse events</h2>
  <div class="cols three">
    <div><h3>By severity</h3>${table(['severity', 'n'], tallyRows(ae.by_severity))}</div>
    <div><h3>By status</h3>${table(['status', 'n'], tallyRows(ae.by_status))}</div>
    <div><h3>By category</h3>${table(['category', 'n'], tallyRows(ae.by_category))}</div>
  </div>
  <h3>Register (${ae.total})</h3>
  <p class="muted small">De-identified: no participant reference, session id or transcript text. Full reports are in the adverse-event register.</p>
  ${table(['#', 'occurred', 'severity', 'category', 'trigger', 'status', 'summary', 'resolution', 'closed'],
    ae.records.map(r => [r.report_id, fmt(r.occurred_at), r.severity, r.category, r.trigger_source, r.status, r.summary, r.resolution, fmt(r.closed_at)]))}
  </section>`);

  const dv = p.deviations;
  sections.push(`<section><h2>6. Protocol deviations</h2>
  <div class="cols three">
    <div><h3>By severity</h3>${table(['severity', 'n'], tallyRows(dv.by_severity))}</div>
    <div><h3>By status</h3>${table(['status', 'n'], tallyRows(dv.by_status))}</div>
    <div><h3>By category</h3>${table(['category', 'n'], tallyRows(dv.by_category))}</div>
  </div>
  <h3>Register (${dv.total})</h3>
  ${table(['#', 'occurred', 'source', 'category', 'severity', 'status', 'description', 'resolved'],
    dv.records.map(r => [r.deviation_id, fmt(r.occurred_at), r.source, r.category, r.severity, r.status, r.description, fmt(r.resolved_at)]))}
  </section>`);

  sections.push(`<section><h2>7. Consent</h2>
  <p class="small">Versions in force at any point in the period. Acceptances are by participants in scope.</p>
  ${table(['version', 'audience', 'effective', 'superseded', 'in force at period end', 'acceptances in period', 'acceptances total'],
    p.consent.versions.map(v => [v.version, v.audience, fmt(v.effective_at), fmt(v.superseded_at), v.in_force_at_end ? 'yes' : 'no', v.acceptances_in_window, v.acceptances_total]),
    'No consent document in force in this period.')}
  </section>`);

  const m = p.monitoring;
  sections.push(`<section><h2>8. Quality monitoring</h2>
  <h3>Eval drift alerts</h3>${kv([
    ['Opened in period', m.drift_alerts.opened_in_window],
    ['Acknowledged in period', m.drift_alerts.acknowledged_in_window],
    ['Open at period end', m.drift_alerts.open_at_end],
    ['Paged on-call', m.drift_alerts.paged_in_window],
  ])}
  <h3>Red-team / simulation harness runs</h3>
  ${table(['suite', 'runs', 'scenarios', 'passed', 'pass rate', 'last run'],
    m.harness_runs.map(h => [h.suite, h.runs, h.scenarios, h.passed, pct(h.pass_rate), fmt(h.last_run_at)]), 'No harness runs in this period.')}
  </section>`);

  const da = p.data_access;
  sections.push(`<section><h2>9. Data access</h2>
  <p class="small">Who viewed participant data, by action and role (counts from the append-only access log). Total: ${esc(da.total)}.</p>
  ${table(['action', 'role', 'n'], da.counts.map(x => [x.action, x.role, x.n]), 'No logged access in this period.')}
  </section>`);

  sections.push(`<section><h2>10. Data-security incidents</h2>
  <div class="fill">
    <p><strong>To be completed by hand.</strong> ${esc(p.incidents.note)}</p>
    <div class="lines"><div></div><div></div><div></div><div></div></div>
  </div></section>`);

  sections.push(`<section><h2>11. Narrative and attestation</h2>
  <div class="fill">
    <p><strong>To be completed by hand.</strong> Progress since the last review, changes to protocol, personnel or consent, and the PI attestation.</p>
    <div class="lines"><div></div><div></div><div></div><div></div><div></div><div></div></div>
    <p class="sig">PI signature: ______________________________ &nbsp; Date: ______________</p>
  </div></section>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>IRB continuing review packet ${esc(p.study.protocol_id ?? '')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; line-height: 1.45; font-size: 14px; }
  header { border-bottom: 2px solid #111; padding-bottom: .75rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 1.75rem 0 .5rem; border-bottom: 1px solid #ccc; padding-bottom: .25rem; }
  h3 { font-size: .95rem; margin: 1rem 0 .35rem; color: #333; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1.25rem; margin: .25rem 0 .5rem; }
  .kv dt { font-weight: 600; color: #444; }
  .kv dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-bottom: .5rem; }
  th, td { text-align: left; padding: .3rem .45rem; border: 1px solid #ccc; vertical-align: top; }
  th { background: #f2f2f2; font-weight: 600; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .cols.three { grid-template-columns: 1fr 1fr 1fr; }
  .muted { color: #777; }
  .small { font-size: .8rem; }
  .fill { border: 1px dashed #999; padding: .75rem 1rem; background: #fafafa; }
  .lines div { border-bottom: 1px solid #bbb; height: 1.6rem; }
  .sig { margin-top: 1.25rem; }
  footer { margin-top: 2rem; font-size: .75rem; color: #777; border-top: 1px solid #ddd; padding-top: .5rem; }
  .toolbar { margin-bottom: 1rem; }
  .toolbar button { font: inherit; padding: .4rem .9rem; border: 1px solid #333; background: #fff; border-radius: 4px; cursor: pointer; }
  @media print {
    body { margin: 0; max-width: none; font-size: 12px; }
    .toolbar { display: none; }
    section { break-inside: auto; }
    h2 { break-after: avoid; }
    tr { break-inside: avoid; }
    .cols { display: block; }
  }
</style>
</head>
<body>
<header>
  <h1>IRB continuing review packet</h1>
  ${kv([
    ['Protocol', p.study.protocol_id ?? notSet],
    ['Principal investigator', p.study.principal_investigator ?? notSet],
    ['Reporting period', `${day(p.meta.period.from)} to ${day(p.meta.period.to)}`],
    ['Generated', `${fmt(p.meta.generated_at)} (build ${p.meta.git_sha})`],
  ])}
</header>
<div class="toolbar"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
${sections.join('\n')}
<footer>Generated from the AI Therapist study database. Counts exclude demo and sandbox traffic. Generation is recorded in the data-access log. Sources per section are listed in packet.json (meta.sources).</footer>
</body>
</html>
`;
}
