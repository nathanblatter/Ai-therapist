// Getting a care note OUT of the system (ai-therapist-199 items 1 and 2):
// plain-text rendering for the clipboard and a standalone printable HTML
// document for window.print (the browser's "Save as PDF" covers PDF, so no
// PDF library). Pure functions, unit-tested in noteExport.test.ts.
import type { CareNoteRow } from '../../../../server/db/careNotes.queries';

export const SOAP_ORDER = ['subjective', 'objective', 'assessment', 'plan'] as const;
export const CASE_ORDER = ['narrative', 'contact_method', 'referral_to', 'outcome'] as const;

export interface NoteExportContext {
  /** How the clinician refers to the client (username / client reference). */
  clientLabel?: string | null;
  /** ISO timestamp of the session the note documents, when known. */
  sessionDate?: string | null;
}

export function fieldLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function noteTitle(note: CareNoteRow): string {
  if (note.note_type === 'progress') return 'Progress note (SOAP)';
  const kind = note.case_note_kind ? ` - ${note.case_note_kind.replace(/_/g, ' ')}` : '';
  return `Case note${kind}`;
}

export function signatureState(note: CareNoteRow): string {
  if (note.status === 'signed') return 'Signed';
  if (note.status === 'amended') return 'Signed, superseded by amendment';
  return 'Draft - unsigned';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function noteSections(note: CareNoteRow): Array<{ key: string; label: string; text: string }> {
  const order: readonly string[] = note.note_type === 'progress' ? SOAP_ORDER : CASE_ORDER;
  const out: Array<{ key: string; label: string; text: string }> = [];
  for (const key of order) {
    const value = note.content[key];
    if (typeof value === 'string' && value.trim()) out.push({ key, label: fieldLabel(key), text: value });
  }
  return out;
}

/** Header lines shared by the clipboard and print renderings. */
export function noteHeaderLines(note: CareNoteRow, ctx: NoteExportContext = {}): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  lines.push(['Client', ctx.clientLabel?.trim() || `#${note.client_id}`]);
  if (note.session_id) {
    lines.push(['Session', ctx.sessionDate ? `${fmtDate(ctx.sessionDate)} (${note.session_id})` : note.session_id]);
  }
  lines.push(['Clinician', `${note.author_name} (${note.author_role})`]);
  lines.push(['Note date', fmtDate(note.created_at)]);
  lines.push([
    'Signature',
    note.signed_at ? `${signatureState(note)} ${fmtDate(note.signed_at)}` : signatureState(note),
  ]);
  if (note.sign_hash) lines.push(['Signature hash', note.sign_hash]);
  if (note.amends_note_id != null) lines.push(['Amends', `note #${note.amends_note_id}`]);
  if (note.seed_source === 'ai_soap') {
    lines.push([
      'Provenance',
      `Drafted by AI${note.seed_model ? ` (${note.seed_model})` : ''}, edited and signed by the clinician`,
    ]);
  }
  return lines;
}

/** Plain text for the clipboard: headers, then each section under its label. */
export function noteToPlainText(note: CareNoteRow, ctx: NoteExportContext = {}): string {
  const parts: string[] = [noteTitle(note).toUpperCase(), ''];
  for (const [k, v] of noteHeaderLines(note, ctx)) parts.push(`${k}: ${v}`);
  parts.push('');
  for (const s of noteSections(note)) {
    parts.push(s.label.toUpperCase());
    parts.push(s.text.trim());
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Standalone printable document: header block + sections, no app chrome. */
export function noteToPrintableHtml(note: CareNoteRow, ctx: NoteExportContext = {}): string {
  const header = noteHeaderLines(note, ctx)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  const sections = noteSections(note)
    .map((s) => `<section><h2>${escapeHtml(s.label)}</h2><p>${escapeHtml(s.text.trim())}</p></section>`)
    .join('');
  const body = sections || `<p class="empty">This note has no content.</p>`;
  const draftBanner =
    note.status === 'draft' ? `<div class="banner">DRAFT - not signed. Not a record of care until signed.</div>` : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(noteTitle(note))} - ${escapeHtml(ctx.clientLabel?.trim() || `client #${note.client_id}`)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  table.meta { border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
  table.meta th { text-align: left; color: #6b7280; font-weight: 600; padding: 2px 16px 2px 0; vertical-align: top; white-space: nowrap; }
  table.meta td { padding: 2px 0; word-break: break-all; }
  h2 { font-size: 14px; margin: 20px 0 4px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  p { white-space: pre-wrap; margin: 4px 0 0; font-size: 14px; }
  .banner { border: 1px solid #b45309; color: #92400e; padding: 8px 12px; font-size: 13px; margin-bottom: 16px; }
  .empty { color: #6b7280; }
  .footer { margin-top: 40px; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  @media print { body { margin: 0; max-width: none; } .no-print { display: none; } }
</style>
</head>
<body>
  <h1>${escapeHtml(noteTitle(note))}</h1>
  ${draftBanner}
  <table class="meta">${header}</table>
  ${body}
  <div class="footer">Printed ${escapeHtml(new Date().toLocaleString())}. Contains protected health information; handle per your clinic's record policy.</div>
</body>
</html>`;
}

/** Open the printable document in a new tab and invoke print; fall back to
 *  downloading the HTML when the popup is blocked. */
export function printNote(note: CareNoteRow, ctx: NoteExportContext = {}): void {
  const html = noteToPrintableHtml(note, ctx);
  const win = window.open('', '_blank');
  if (!win) {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `note-${note.note_id}.html`;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

/** Copy with the async clipboard API, falling back to a hidden textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
