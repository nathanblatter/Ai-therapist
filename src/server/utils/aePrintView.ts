// Standalone, self-contained HTML for printing/exporting an IRB adverse-event
// report (ai-therapist-95). No client JS, inline CSS, @media print rules —
// browser "Print → Save as PDF" satisfies the PDF-export requirement. This is a
// plain Express HTML response, so it sidesteps the admin SSR/Vite pipeline.
import type { AdverseEventRow } from '../db/index.js';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(d: Date | string | null): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function renderAdverseEventPrintHtml(r: AdverseEventRow): string {
  const timeline = Array.isArray(r.timeline) ? r.timeline : [];
  const actions = Array.isArray(r.actions_taken) ? r.actions_taken : [];

  const timelineRows = timeline.length
    ? timeline.map(t => `<tr><td>${esc(fmt(t.at))}</td><td>${esc(t.kind)}</td><td>${esc(t.detail)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No timeline entries.</td></tr>';

  const actionRows = actions.length
    ? actions.map(a => `<tr><td>${esc(fmt(a.at))}</td><td>${esc(a.action)}</td><td>${esc(a.by ?? '—')}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No actions recorded.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Adverse Event Report #${esc(r.report_id)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 2rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  .status { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; text-transform: uppercase; }
  .status.draft { background: #fef3c7; color: #92400e; }
  .status.submitted { background: #dbeafe; color: #1e40af; }
  .status.closed { background: #e5e7eb; color: #374151; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; font-size: .9rem; margin-top: .75rem; }
  .meta dt { font-weight: 600; color: #555; }
  .meta dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .4rem .5rem; border: 1px solid #ddd; vertical-align: top; }
  th { background: #f7f7f7; }
  .excerpt { white-space: pre-wrap; border: 1px solid #ddd; border-radius: 6px; padding: .75rem; background: #fafafa; font-size: .85rem; }
  .summary { white-space: pre-wrap; }
  .muted { color: #888; }
  footer { margin-top: 2rem; font-size: .75rem; color: #888; border-top: 1px solid #eee; padding-top: .5rem; }
  @media print { body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style>
</head>
<body>
  <h1>Adverse Event Report #${esc(r.report_id)}</h1>
  <span class="status ${esc(r.status)}">${esc(r.status)}</span>

  <dl class="meta">
    <dt>Participant</dt><dd>${esc(r.participant_ref ?? '—')}</dd>
    <dt>Session</dt><dd>${esc(r.session_ref)}</dd>
    <dt>Severity</dt><dd>${esc(r.severity)}</dd>
    <dt>Trigger</dt><dd>${esc(r.trigger_source)}</dd>
    <dt>Occurred at</dt><dd>${esc(fmt(r.occurred_at))}</dd>
    <dt>Reporting due</dt><dd>${esc(fmt(r.due_at))}</dd>
    <dt>Reporter (sign-off)</dt><dd>${esc(r.submitted_by ?? '— (not yet submitted)')}</dd>
    <dt>Signed off at</dt><dd>${esc(fmt(r.submitted_at))}</dd>
    <dt>Closed by</dt><dd>${esc(r.closed_by ?? '—')}</dd>
    <dt>Created by</dt><dd>${esc(r.created_by)}</dd>
  </dl>

  <h2>Summary</h2>
  <p class="summary">${esc(r.summary) || '<span class="muted">No summary.</span>'}</p>

  <h2>Timeline</h2>
  <table><thead><tr><th>When</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${timelineRows}</tbody></table>

  <h2>Actions taken</h2>
  <table><thead><tr><th>When</th><th>Action</th><th>By</th></tr></thead><tbody>${actionRows}</tbody></table>

  <h2>Transcript excerpt (redacted)</h2>
  <div class="excerpt">${esc(r.transcript_excerpt) || '<span class="muted">No excerpt captured.</span>'}</div>

  <footer>Generated ${esc(fmt(new Date()))}. Redacted excerpt only — contains no raw PHI. IRB regulatory record.</footer>
</body>
</html>`;
}
