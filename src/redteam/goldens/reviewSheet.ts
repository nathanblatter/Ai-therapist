// Human review sheets for the goldens: one CSV per set, one line per row,
// with blank "agree" and "correction" columns for the PI or the clinical
// consultant. Regenerating keeps whatever a reviewer already typed in those two
// columns (matched by id), so the sheet can be filled in place and rebuilt
// after rows are added. The JSONL stays the source of truth: a correction is
// applied to the row, and the row's reviewedBy / reviewedAt are set, by
// whoever edits the data (docs/redteam.md "Goldens").
import fs from 'node:fs';
import path from 'node:path';
import { acceptableBands, type DetectorRow, type GoldenTurn, type ReplyRow, type TextCheck } from './schema.js';
import { GOLDENS_DIR } from './load.js';

export const REVIEW_DIR = path.join(GOLDENS_DIR, 'review');
export const DETECTOR_SHEET = path.join(REVIEW_DIR, 'detector-review.csv');
export const REPLY_SHEET = path.join(REVIEW_DIR, 'reply-review.csv');

const REVIEWER_COLUMNS = ['agree (yes/no)', 'correction or comment'] as const;

export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function renderHistory(turns: GoldenTurn[]): string {
  return turns.map((t) => `${t.role === 'user' ? 'Participant' : 'Assistant'}: ${t.text}`).join('\n');
}

function renderChecks(checks: TextCheck[]): string {
  return checks
    .map(
      (c) =>
        `${c.phrase !== undefined ? `"${c.phrase}"` : `/${c.regex}/`} (${c.why}` +
        `${c.scope === 'asserted' ? '; counts only when asserted, not after a negation or refusal' : ''})`,
    )
    .join('\n');
}

/** Reviewer columns already filled in an existing sheet, by row id. */
function existingReviews(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!fs.existsSync(file)) return out;
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!header) return out;
  const idAt = header.indexOf('id');
  const cols = REVIEWER_COLUMNS.map((c) => header.indexOf(c));
  if (idAt < 0 || cols.some((c) => c < 0)) return out;
  for (const r of rows) {
    const id = r[idAt];
    if (id)
      out.set(
        id,
        cols.map((c) => r[c] ?? ''),
      );
  }
  return out;
}

function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function buildDetectorSheet(rows: DetectorRow[], previous = new Map<string, string[]>()): string {
  const header = [
    'id',
    'category',
    'modality',
    'earlier turns (history)',
    'participant says (input)',
    'expected band',
    'also acceptable',
    'page staff?',
    'why this label (rationale)',
    'catalogue',
    'known gap',
    'reviewed by',
    'reviewed at',
    ...REVIEWER_COLUMNS,
  ];
  return toCsv(
    header,
    rows.map((r) => [
      r.id,
      r.category,
      r.inputVia === 'checkin' ? `${r.modality} (check-in form)` : r.modality,
      [
        ...(r.checkin ? [`Check-in form: ${[r.checkin.topic, r.checkin.goal].filter(Boolean).join(' / ')}`] : []),
        ...(r.history.length > 0 ? [renderHistory(r.history)] : []),
      ].join('\n'),
      r.input,
      r.expected.band,
      acceptableBands(r).length > 1 ? acceptableBands(r).join(' / ') : '',
      r.expected.page,
      r.rationale,
      r.catalogueIds.join(' '),
      r.knownGap ?? '',
      r.reviewedBy ?? '',
      r.reviewedAt ?? '',
      ...(previous.get(r.id) ?? REVIEWER_COLUMNS.map(() => '')),
    ]),
  );
}

export function buildReplySheet(rows: ReplyRow[], previous = new Map<string, string[]>()): string {
  const header = [
    'id',
    'category',
    'earlier turns (history)',
    'participant says (input)',
    'what a good reply does',
    'reply must include',
    'reply must not include',
    'yes/no questions (expected answer)',
    'why (rationale)',
    'catalogue',
    'known gap',
    'reviewed by',
    'reviewed at',
    ...REVIEWER_COLUMNS,
  ];
  return toCsv(
    header,
    rows.map((r) => [
      r.id,
      r.category,
      renderHistory(r.history),
      r.input,
      r.expectedBehaviour + (r.expectSessionEnded ? ' The session ends on this turn.' : ''),
      renderChecks(r.mustInclude),
      renderChecks(r.mustNotInclude),
      r.criteria.map((c) => `${c.question} (${c.expect})`).join('\n'),
      r.rationale,
      r.catalogueIds.join(' '),
      r.knownGap ?? '',
      r.reviewedBy ?? '',
      r.reviewedAt ?? '',
      ...(previous.get(r.id) ?? REVIEWER_COLUMNS.map(() => '')),
    ]),
  );
}

/** Rebuild both sheets in place, keeping reviewer input. Returns the paths. */
export function writeReviewSheets(detector: DetectorRow[], reply: ReplyRow[]): string[] {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  fs.writeFileSync(DETECTOR_SHEET, buildDetectorSheet(detector, existingReviews(DETECTOR_SHEET)));
  fs.writeFileSync(REPLY_SHEET, buildReplySheet(reply, existingReviews(REPLY_SHEET)));
  return [DETECTOR_SHEET, REPLY_SHEET];
}

/** The sheet as it would be regenerated now (for the up-to-date test). */
export function expectedSheets(detector: DetectorRow[], reply: ReplyRow[]): Record<string, string> {
  return {
    [DETECTOR_SHEET]: buildDetectorSheet(detector, existingReviews(DETECTOR_SHEET)),
    [REPLY_SHEET]: buildReplySheet(reply, existingReviews(REPLY_SHEET)),
  };
}
