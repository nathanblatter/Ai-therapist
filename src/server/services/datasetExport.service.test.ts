import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Mock the query layer so the service never touches a DB. Each fetcher returns
// controllable rows; ensurePseudonyms is a no-op spy.
const mockRows: Record<string, unknown[]> = {};
vi.mock('../db/datasetExport.queries.js', () => ({
  ensurePseudonyms: vi.fn().mockResolvedValue(undefined),
  getParticipantsExport: vi.fn(async () => mockRows.participants ?? []),
  getSessionsExport: vi.fn(async () => mockRows.sessions ?? []),
  getScreenersExport: vi.fn(async () => mockRows.screeners ?? []),
  getMoodsExport: vi.fn(async () => mockRows.moods ?? []),
  getFeedbackExport: vi.fn(async () => mockRows.feedback ?? []),
  getEvalsExport: vi.fn(async () => mockRows.evals ?? []),
  getCrisisEventsExport: vi.fn(async () => mockRows.crisis ?? []),
  getTranscriptsExport: vi.fn(async () => mockRows.transcripts ?? []),
  getFeedbackCommentsExport: vi.fn(async () => mockRows.comments ?? []),
  getSemanticMetricsExport: vi.fn(async () => mockRows.semantic_metrics ?? []),
}));
vi.mock('../db/qualtricsResponses.queries.js', () => ({
  getSurveyResponsesExport: vi.fn(async () => mockRows.surveys ?? []),
  getSurveyAnswersForExport: vi.fn(async () => mockRows.surveys_scored ?? []),
}));

import {
  toCsv,
  buildDataset,
  DATASET_FILES,
  TRANSCRIPT_FILES,
  type DatasetColumn,
} from './datasetExport.service.js';
import { ensurePseudonyms } from '../db/datasetExport.queries.js';

const cols = (names: string[]): DatasetColumn[] =>
  names.map(n => ({ name: n, type: 'string', source: 'x' }));

describe('toCsv', () => {
  it('quotes cells and escapes embedded quotes', () => {
    const out = toCsv(cols(['a', 'b']), [{ a: 'he said "hi"', b: 'x,y' }]);
    expect(out).toBe('a,b\n"he said ""hi""","x,y"\n');
  });

  it('renders null/undefined as empty and booleans as true/false', () => {
    const out = toCsv(cols(['a', 'b', 'c']), [{ a: null, b: undefined, c: true }]);
    expect(out).toBe('a,b,c\n,,true\n');
  });

  it('handles newlines inside quoted cells', () => {
    const out = toCsv(cols(['a']), [{ a: 'line1\nline2' }]);
    expect(out).toBe('a\n"line1\nline2"\n');
  });

  it('JSON-encodes array/object cells (item_scores)', () => {
    const out = toCsv(cols(['item_scores']), [{ item_scores: [1, 2, 3] }]);
    expect(out).toBe('item_scores\n"[1,2,3]"\n');
  });
});

describe('codebook / CSV registry (drift guard)', () => {
  it('every registry column appears once in the CSV header, in order', () => {
    for (const spec of [...DATASET_FILES, ...TRANSCRIPT_FILES]) {
      const header = toCsv(spec.columns, []).split('\n')[0];
      expect(header).toBe(spec.columns.map(c => c.name).join(','));
    }
  });

  // Extract the "## <file>" section of a codebook and return its column-row names.
  function sectionColumns(codebook: string, file: string): string[] {
    const lines = codebook.split('\n');
    const start = lines.findIndex(l => l === `## ${file}`);
    expect(start, `section ${file}`).toBeGreaterThanOrEqual(0);
    const names: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break; // next section
      const m = lines[i].match(/^\| (\S+) \|/);
      if (m && m[1] !== 'column') names.push(m[1]);
    }
    return names;
  }

  it('each codebook file-section lists exactly its CSV columns, in order (no drift)', async () => {
    const result = await buildDataset('2026-08-31T23:59:59Z', { includeTranscripts: true, generatedAt: 'fixed' });
    const mainBook = result.main.find(f => f.name === 'codebook.md')!.content;
    for (const spec of DATASET_FILES) {
      expect(sectionColumns(mainBook, spec.file), spec.file).toEqual(spec.columns.map(c => c.name));
    }
    const tBook = result.transcripts!.find(f => f.name === 'codebook.md')!.content;
    for (const spec of TRANSCRIPT_FILES) {
      expect(sectionColumns(tBook, spec.file), spec.file).toEqual(spec.columns.map(c => c.name));
    }
  });
});

describe('buildDataset', () => {
  it('assigns pseudonyms before selecting rows and includes all 10 default CSVs + codebook', async () => {
    const result = await buildDataset('2026-08-31T23:59:59Z', { generatedAt: 'fixed' });
    expect(ensurePseudonyms).toHaveBeenCalledWith('2026-08-31T23:59:59Z');
    const names = result.main.map(f => f.name).sort();
    expect(names).toEqual([
      'codebook.md', 'crisis_events.csv', 'evals.csv', 'feedback.csv',
      'moods.csv', 'participants.csv', 'screeners.csv', 'semantic_metrics.csv',
      'sessions.csv', 'surveys.csv', 'surveys_scored.csv',
    ]);
    expect(result.transcripts).toBeNull();
  });

  it('omits transcripts unless includeTranscripts is set', async () => {
    const off = await buildDataset('2026-08-31T23:59:59Z', { generatedAt: 'fixed' });
    expect(off.transcripts).toBeNull();
    const on = await buildDataset('2026-08-31T23:59:59Z', { includeTranscripts: true, generatedAt: 'fixed' });
    expect(on.transcripts!.map(f => f.name).sort()).toEqual(['codebook.md', 'feedback_comments.csv', 'transcripts.csv']);
  });

  it('is deterministic: identical mocked data + asOf + generatedAt => identical strings', async () => {
    mockRows.sessions = [
      { session_pseudo_id: 'S0001', participant_id: 'P001', is_anonymous: false, status: 'ended' },
      { session_pseudo_id: 'S0002', participant_id: '', is_anonymous: true, status: 'active' },
    ];
    const a = await buildDataset('2026-08-31T23:59:59Z', { generatedAt: 'fixed' });
    const b = await buildDataset('2026-08-31T23:59:59Z', { generatedAt: 'fixed' });
    expect(a.main.map(f => f.content)).toEqual(b.main.map(f => f.content));
    mockRows.sessions = [];
  });

  it('renders an anonymous session with empty participant_id', async () => {
    mockRows.sessions = [{ session_pseudo_id: 'S0002', participant_id: '', is_anonymous: true }];
    const result = await buildDataset('2026-08-31T23:59:59Z', { generatedAt: 'fixed' });
    const sessions = result.main.find(f => f.name === 'sessions.csv')!.content;
    const line = sessions.split('\n')[1];
    // session_pseudo_id, participant_id (empty string), is_anonymous, ...
    expect(line.startsWith('"S0002","",true')).toBe(true);
    mockRows.sessions = [];
  });
});

describe('PII exclusion (query source guard)', () => {
  const queriesSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/datasetExport.queries.ts'),
    'utf8'
  );

  it('never selects raw message content (only content_redacted)', () => {
    expect(/\bm\.content\b(?!_redacted)/.test(queriesSrc)).toBe(false);
    expect(queriesSrc.includes('content_redacted')).toBe(true);
  });

  it('never selects usernames, session_name, session_goal, or the recording object key', () => {
    expect(queriesSrc).not.toMatch(/\bu\.username\b/);
    expect(queriesSrc).not.toMatch(/\bsession_name\b/);
    expect(queriesSrc).not.toMatch(/\bsession_goal\b/);
    // had_recording is a boolean derived from the key; the key itself is never selected as a column.
    expect(queriesSrc).not.toMatch(/AS recording_object_key/);
  });

  it('excludes demo traffic in every query', () => {
    const occurrences = (queriesSrc.match(/is_demo IS NOT TRUE/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(8);
  });
});
