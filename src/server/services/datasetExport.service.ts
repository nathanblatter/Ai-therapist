// De-identified research dataset export (ai-therapist-96). Shared by the CLI
// (scripts/exportDataset.ts) and the admin route (routes/admin/export.routes).
//
// One registry (DATASET_FILES / TRANSCRIPT_FILES) is the single source of truth
// for BOTH the CSV column order and the generated codebook, so data and
// documentation cannot drift (drift-guarded in datasetExport.service.test.ts).
//
// Nothing here ever emits raw PII: the queries join through research_pseudonyms
// and select only pseudonyms + non-identifying aggregates. The mapping table is
// never exported. Transcript/feedback-comment free text is opt-in only.
import archiver from 'archiver';
import type { Writable } from 'node:stream';
import { execSync } from 'node:child_process';
import { SCALES } from '../utils/scales.js';
import {
  ensurePseudonyms,
  getParticipantsExport,
  getSessionsExport,
  getScreenersExport,
  getMoodsExport,
  getFeedbackExport,
  getEvalsExport,
  getCrisisEventsExport,
  getTranscriptsExport,
  getFeedbackCommentsExport,
  type DatasetRow,
} from '../db/datasetExport.queries.js';

export interface DatasetColumn {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'timestamp' | 'json';
  source: string;
  values?: string;
  notes?: string;
}

export interface DatasetFileSpec {
  file: string;
  description: string;
  columns: DatasetColumn[];
  fetch: (asOf: string) => Promise<DatasetRow[]>;
}

export interface BuiltFile {
  name: string;
  content: string;
}

export interface BuildOptions {
  includeTranscripts?: boolean;
  /** Overridable so tests (and the determinism guarantee) can pin the header timestamp. */
  generatedAt?: string;
}

export interface BuildResult {
  asOf: string;
  generatedAt: string;
  gitSha: string;
  /** Default bundle: the seven de-identified CSVs + codebook.md. */
  main: BuiltFile[];
  /** Present only when includeTranscripts: transcripts.csv, feedback_comments.csv + codebook.md. */
  transcripts: BuiltFile[] | null;
  rowCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// CSV serialization: header row from the registry column order; every non-null
// cell is quoted with "" escaping; JSON cells are stringified; booleans render
// as true/false; null/undefined render as an empty (unquoted) field.
// ---------------------------------------------------------------------------
export function toCsv(columns: DatasetColumn[], rows: DatasetRow[]): string {
  const header = columns.map(c => c.name);
  const lines = [header.join(',')];
  for (const row of rows) {
    const cells = columns.map(col => {
      const value = row[col.name];
      if (value === null || value === undefined) return '';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
      return `"${String(value).replace(/"/g, '""')}"`;
    });
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Registry — default (de-identified) bundle.
// ---------------------------------------------------------------------------
export const DATASET_FILES: DatasetFileSpec[] = [
  {
    file: 'participants.csv',
    description: 'One row per pseudonymized participant (logged-in participant-role users with >=1 in-scope session).',
    fetch: getParticipantsExport,
    columns: [
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', values: 'P001, P002, ...' },
      { name: 'enrolled_month', type: 'string', source: 'users.created_at', values: 'YYYY-MM', notes: 'Month precision only, to reduce re-identifiability.' },
      { name: 'memory_enabled', type: 'bool', source: 'users.memory_enabled' },
      { name: 'consent_version_first', type: 'string', source: 'participant_consents.consent_version', notes: 'Earliest by accepted_at.' },
      { name: 'consent_version_last', type: 'string', source: 'participant_consents.consent_version', notes: 'Latest by accepted_at.' },
      { name: 'n_sessions', type: 'int', source: 'therapy_sessions', notes: 'Non-demo sessions with created_at <= as_of.' },
      { name: 'n_sessions_ended', type: 'int', source: "therapy_sessions.status = 'ended'" },
      { name: 'total_session_minutes', type: 'float', source: 'SUM(ended_at - created_at)/60', notes: 'Rounded to 1 decimal.' },
      { name: 'first_session_at', type: 'timestamp', source: 'MIN(therapy_sessions.created_at)' },
      { name: 'last_session_at', type: 'timestamp', source: 'MAX(therapy_sessions.created_at)' },
      { name: 'phq2_first', type: 'int', source: 'scale_responses(scale=phq2).score', values: '0-6', notes: 'Earliest; empty if no PHQ-2 response.' },
      { name: 'phq2_last', type: 'int', source: 'scale_responses(scale=phq2).score', values: '0-6', notes: 'Latest; empty if no PHQ-2 response.' },
      { name: 'phq2_delta', type: 'int', source: 'phq2_last - phq2_first', notes: 'Empty if fewer than 2 PHQ-2 responses.' },
      { name: 'gad2_first', type: 'int', source: 'scale_responses(scale=gad2).score', values: '0-6', notes: 'Earliest; empty if no GAD-2 response.' },
      { name: 'gad2_last', type: 'int', source: 'scale_responses(scale=gad2).score', values: '0-6', notes: 'Latest; empty if no GAD-2 response.' },
      { name: 'gad2_delta', type: 'int', source: 'gad2_last - gad2_first', notes: 'Empty if fewer than 2 GAD-2 responses.' },
      { name: 'n_crisis_events', type: 'int', source: 'crisis_events (via sessions + thread-origin via client_user_id)' },
      { name: 'any_crisis_flagged', type: 'bool', source: 'therapy_sessions.crisis_flagged' },
    ],
  },
  {
    file: 'sessions.csv',
    description: 'One row per non-demo session with created_at <= as_of (anonymous sessions included).',
    fetch: getSessionsExport,
    columns: [
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms', values: 'S0001, S0002, ...' },
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', notes: 'Empty for anonymous sessions.' },
      { name: 'is_anonymous', type: 'bool', source: 'therapy_sessions.user_id IS NULL' },
      { name: 'started_at', type: 'timestamp', source: 'therapy_sessions.created_at' },
      { name: 'ended_at', type: 'timestamp', source: 'therapy_sessions.ended_at' },
      { name: 'duration_minutes', type: 'float', source: 'ended_at - created_at', notes: 'Rounded to 1 decimal; empty if not ended.' },
      { name: 'status', type: 'string', source: 'therapy_sessions.status', values: 'active, ended, archived' },
      { name: 'ended_by', type: 'string', source: 'therapy_sessions.ended_by' },
      { name: 'session_type', type: 'string', source: 'therapy_sessions.session_type', values: 'realtime, chat' },
      { name: 'modality_condition', type: 'string', source: 'session_configurations.modality', values: 'cbt, act, mi, supportive' },
      { name: 'proactive_offering', type: 'string', source: 'session_configurations.proactive_offering', values: "true, false, '' (not evaluated)" },
      { name: 'theme', type: 'string', source: 'session_configurations.theme', values: 'default, sage, ocean, dusk, dark' },
      { name: 'language', type: 'string', source: 'session_configurations.language' },
      { name: 'voice', type: 'string', source: 'session_configurations.voice' },
      { name: 'ai_model', type: 'string', source: 'session_configurations.ai_model', notes: 'Resolved model snapshot at /token time.' },
      { name: 'transcription_model', type: 'string', source: 'session_configurations.transcription_model' },
      { name: 'temperature', type: 'float', source: 'session_configurations.temperature' },
      { name: 'checkin_mood', type: 'int', source: "therapy_sessions.checkin->>'mood'", values: '1-10' },
      { name: 'had_recording', type: 'bool', source: 'therapy_sessions.recording_object_key IS NOT NULL', notes: 'The object key itself is never exported.' },
      { name: 'recording_duration_s', type: 'float', source: 'recording_duration_ms/1000', notes: 'Rounded to 1 decimal.' },
      { name: 'n_messages', type: 'int', source: 'messages' },
      { name: 'n_user_messages', type: 'int', source: "messages.role = 'user'" },
      { name: 'n_assistant_messages', type: 'int', source: "messages.role = 'assistant'" },
      { name: 'n_tool_invocations', type: 'int', source: 'tool_invocations' },
      { name: 'crisis_flagged', type: 'bool', source: 'therapy_sessions.crisis_flagged' },
      { name: 'crisis_severity', type: 'string', source: 'therapy_sessions.crisis_severity', values: 'low, medium, high' },
      { name: 'crisis_max_risk_score', type: 'int', source: 'MAX(crisis_events.risk_score)', values: '0-100' },
      { name: 'n_crisis_events', type: 'int', source: 'crisis_events' },
      { name: 'n_crisis_events_auto', type: 'int', source: "crisis_events.trigger_method = 'auto'" },
      { name: 'n_crisis_events_manual', type: 'int', source: "crisis_events.trigger_method = 'manual'" },
      { name: 'n_risk_check_steps', type: 'int', source: 'risk_check_steps' },
      { name: 'llm_tokens_in', type: 'int', source: 'SUM(session_llm_usage.tokens_in)' },
      { name: 'llm_tokens_out', type: 'int', source: 'SUM(session_llm_usage.tokens_out)' },
    ],
  },
  {
    file: 'screeners.csv',
    description: 'One row per PHQ-2/GAD-2 administration (scale_responses) over in-scope sessions.',
    fetch: getScreenersExport,
    columns: [
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', notes: 'Empty for anonymous sessions.' },
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'scale', type: 'string', source: 'scale_responses.scale', values: 'phq2, gad2' },
      { name: 'item_scores', type: 'json', source: 'scale_responses.answers', notes: 'JSON array of per-item integer scores (0-3 each).' },
      { name: 'score', type: 'int', source: 'scale_responses.score', values: '0-6' },
      { name: 'screen_positive', type: 'bool', source: 'score >= 3', notes: 'Conventional screen-positive cutoff.' },
      { name: 'administered_at', type: 'timestamp', source: 'scale_responses.created_at' },
      { name: 'occasion_index', type: 'int', source: 'ROW_NUMBER() per participant+scale by created_at', notes: 'Anonymous responses are not linked across sessions.' },
    ],
  },
  {
    file: 'moods.csv',
    description: 'Union of the two mood signals: pre-session check-in mood and the log_mood tool.',
    fetch: getMoodsExport,
    columns: [
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', notes: 'Empty for anonymous sessions.' },
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'source', type: 'string', source: "checkin | log_mood", values: 'checkin, log_mood' },
      { name: 'mood', type: 'int', source: "checkin->>'mood' or log_mood arguments->>'score'", values: '1-10' },
      { name: 'recorded_at', type: 'timestamp', source: 'therapy_sessions.created_at or tool_invocations.created_at' },
    ],
  },
  {
    file: 'feedback.csv',
    description: 'One row per post-session feedback submission (numeric ratings only; free-text comment presence flagged, comment excluded).',
    fetch: getFeedbackExport,
    columns: [
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', notes: 'Empty for anonymous sessions.' },
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'helpfulness_rating', type: 'int', source: 'session_feedback.helpfulness_rating', values: '1-5' },
      { name: 'ease_rating', type: 'int', source: 'session_feedback.ease_rating', values: '1-5' },
      { name: 'would_return_rating', type: 'int', source: 'session_feedback.would_return_rating', values: '1-5' },
      { name: 'has_comments', type: 'bool', source: 'session_feedback.comments IS NOT NULL', notes: 'Comment text is participant-authored and only in the opt-in transcript artifact.' },
      { name: 'submitted_at', type: 'timestamp', source: 'session_feedback.created_at' },
    ],
  },
  {
    file: 'evals.csv',
    description: 'One row per automated session evaluation (LLM-judge rubric scores; rationales excluded as they quote transcript text).',
    fetch: getEvalsExport,
    columns: [
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'prompt_version', type: 'string', source: 'session_evals.prompt_version' },
      { name: 'judge_model', type: 'string', source: 'session_evals.judge_model' },
      { name: 'safety_protocol_score', type: 'int', source: "session_evals.rubric->'safety_protocol'->>'score'", values: '1-5' },
      { name: 'empathy_score', type: 'int', source: "session_evals.rubric->'empathy'->>'score'", values: '1-5' },
      { name: 'modality_fidelity_score', type: 'int', source: "session_evals.rubric->'modality_fidelity'->>'score'", values: '1-5' },
      { name: 'disclaimer_compliance_score', type: 'int', source: "session_evals.rubric->'disclaimer_compliance'->>'score'", values: '1-5' },
      { name: 'non_directiveness_score', type: 'int', source: "session_evals.rubric->'non_directiveness'->>'score'", values: '1-5' },
      { name: 'clinical_claims_score', type: 'int', source: "session_evals.rubric->'clinical_claims'->>'score'", values: '1-5' },
      { name: 'evaluated_at', type: 'timestamp', source: 'session_evals.created_at' },
    ],
  },
  {
    file: 'crisis_events.csv',
    description: 'One row per crisis event, both session-origin and thread-origin (message-scan) rows (no notes/risk_factors/intervention_details JSON, which can quote content).',
    fetch: getCrisisEventsExport,
    columns: [
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', notes: 'Via session owner, or crisis_events.client_user_id for thread-origin rows; empty when no pseudonym (e.g. anonymous session).' },
      { name: 'thread_origin', type: 'bool', source: 'crisis_events.session_id IS NULL', notes: "Message-scan events (origin='thread_message'); session_pseudo_id empty. Included in participants.csv n_crisis_events; excluded from sessions.csv per-session counts." },
      { name: 'event_type', type: 'string', source: 'crisis_events.event_type' },
      { name: 'severity', type: 'string', source: 'crisis_events.severity', values: 'low, medium, high' },
      { name: 'risk_score', type: 'int', source: 'crisis_events.risk_score', values: '0-100' },
      { name: 'trigger_method', type: 'string', source: 'crisis_events.trigger_method', values: 'auto, manual, system' },
      { name: 'occurred_at', type: 'timestamp', source: 'crisis_events.created_at' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Registry — opt-in transcript artifact (redacted text only).
// ---------------------------------------------------------------------------
export const TRANSCRIPT_FILES: DatasetFileSpec[] = [
  {
    file: 'transcripts.csv',
    description: 'REDACTED turn text only (content_redacted). Original content is NEVER exported. Rows pending redaction export empty text with redaction_pending=true.',
    fetch: getTranscriptsExport,
    columns: [
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'turn_index', type: 'int', source: 'ROW_NUMBER() per session by created_at' },
      { name: 'role', type: 'string', source: 'messages.role', values: 'user, assistant' },
      { name: 'message_type', type: 'string', source: 'messages.message_type' },
      { name: 'content_redacted', type: 'string', source: 'messages.content_redacted', notes: 'Redacted text only; empty when redaction has not run.' },
      { name: 'redaction_pending', type: 'bool', source: 'messages.content_redacted IS NULL' },
      { name: 'created_at', type: 'timestamp', source: 'messages.created_at' },
    ],
  },
  {
    file: 'feedback_comments.csv',
    description: 'WARNING: participant-authored free text, exported verbatim (no content_redacted equivalent exists for feedback comments). Handle as identifiable data.',
    fetch: getFeedbackCommentsExport,
    columns: [
      { name: 'participant_id', type: 'string', source: 'research_pseudonyms', notes: 'Empty for anonymous sessions.' },
      { name: 'session_pseudo_id', type: 'string', source: 'research_pseudonyms' },
      { name: 'comments', type: 'string', source: 'session_feedback.comments', notes: 'Verbatim participant text.' },
      { name: 'submitted_at', type: 'timestamp', source: 'session_feedback.created_at' },
    ],
  },
];

function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Codebook renderer — driven by the SAME registry that builds the CSVs.
// ---------------------------------------------------------------------------
function renderFileSection(spec: DatasetFileSpec, rowCount: number): string {
  const lines: string[] = [];
  lines.push(`## ${spec.file}`);
  lines.push('');
  lines.push(spec.description);
  lines.push('');
  lines.push(`Rows: ${rowCount}`);
  lines.push('');
  lines.push('| column | type | source | values | notes |');
  lines.push('|---|---|---|---|---|');
  for (const c of spec.columns) {
    lines.push(`| ${c.name} | ${c.type} | ${c.source} | ${c.values ?? ''} | ${c.notes ?? ''} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderCodebook(
  title: string,
  specs: DatasetFileSpec[],
  rowCounts: Record<string, number>,
  meta: { asOf: string; generatedAt: string; gitSha: string },
  extraNotes: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- generated_at: ${meta.generatedAt}`);
  lines.push(`- as_of (inclusion cutoff, created_at <= as_of): ${meta.asOf}`);
  lines.push(`- git_sha: ${meta.gitSha}`);
  lines.push('');
  lines.push('## Provenance & de-identification');
  lines.push('');
  lines.push('- Pseudonyms (participant_id P###, session_pseudo_id S####) come from a mapping table');
  lines.push('  (research_pseudonyms) that is NEVER included in any export. Re-identification requires');
  lines.push('  database access. Pseudonyms are assigned once and are stable across exports.');
  lines.push('- Demo traffic is excluded everywhere (therapy_sessions.is_demo IS NOT TRUE; demo-role users omitted).');
  lines.push('- Sandbox data is excluded everywhere: sandbox-owned sessions carry is_demo=TRUE, and users.is_sandbox');
  lines.push('  / sandbox organizations are additionally filtered from user enumeration and pseudonym assignment.');
  lines.push('- Anonymous participants (user_id IS NULL) cannot be linked across sessions: the att_pid');
  lines.push('  browser cookie is deliberately not persisted server-side. Screener deltas and');
  lines.push('  sessions-per-participant therefore under-count anonymous traffic.');
  lines.push('- All timestamps are ISO-8601 UTC. Given the same as_of and unchanged source rows, every CSV is byte-identical across runs.');
  lines.push('');
  lines.push('## Screening instruments (PHQ-2 / GAD-2)');
  lines.push('');
  lines.push('PHQ-2 and GAD-2 are brief, public-domain SCREENERS (Kroenke, Spitzer, Williams), NOT diagnoses.');
  for (const key of Object.keys(SCALES)) {
    const s = SCALES[key];
    lines.push(`- ${s.name}: ${s.items.length} items, each 0-3 ("not at all" … "nearly every day"), score = item sum (0-${s.max_score}); screen-positive cutoff >= ${s.cutoff}.`);
  }
  lines.push('');
  for (const note of extraNotes) {
    lines.push(note);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  for (const spec of specs) {
    lines.push(renderFileSection(spec, rowCounts[spec.file] ?? 0));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build the in-memory dataset (CSVs + codebook). Assigns pseudonyms first.
// ---------------------------------------------------------------------------
export async function buildDataset(asOf: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const sha = gitSha();

  await ensurePseudonyms(asOf);

  const rowCounts: Record<string, number> = {};
  const main: BuiltFile[] = [];
  for (const spec of DATASET_FILES) {
    const rows = await spec.fetch(asOf);
    rowCounts[spec.file] = rows.length;
    main.push({ name: spec.file, content: toCsv(spec.columns, rows) });
  }
  main.push({
    name: 'codebook.md',
    content: renderCodebook('AI-Therapist de-identified research dataset', DATASET_FILES, rowCounts,
      { asOf, generatedAt, gitSha: sha },
      ['## Exclusions', '',
        'These fields are intentionally NOT exported (they are LLM-generated from, or quote, content):',
        'session_name, checkin topic/goal, session_goal, instructions, recording_object_key, usernames,',
        'message content, eval rationales/overall_comments, crisis notes/risk_factors/intervention JSON,',
        'and the research_pseudonyms mapping itself.']),
  });

  let transcripts: BuiltFile[] | null = null;
  if (opts.includeTranscripts) {
    transcripts = [];
    for (const spec of TRANSCRIPT_FILES) {
      const rows = await spec.fetch(asOf);
      rowCounts[spec.file] = rows.length;
      transcripts.push({ name: spec.file, content: toCsv(spec.columns, rows) });
    }
    transcripts.push({
      name: 'codebook.md',
      content: renderCodebook('AI-Therapist OPT-IN transcript artifact', TRANSCRIPT_FILES, rowCounts,
        { asOf, generatedAt, gitSha: sha },
        ['## Sensitivity warning', '',
          'transcripts.csv contains REDACTED text only (content_redacted). feedback_comments.csv contains',
          'VERBATIM participant free text with no redaction applied — treat it as identifiable data and',
          'store/share accordingly.']),
    });
  }

  return { asOf, generatedAt, gitSha: sha, main, transcripts, rowCounts };
}

// ---------------------------------------------------------------------------
// Zip helpers. A fixed entry date (derived from as_of) keeps the archive
// byte-stable for a given as_of + content.
// ---------------------------------------------------------------------------
function archiveDate(asOf: string): Date {
  const d = new Date(asOf);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * Stream a zip of the built dataset to `out`. Main bundle at the archive root;
 * the opt-in transcript files (when present) nested under transcripts-<asOf>/.
 * Resolves when the archive has been fully written.
 */
export function streamDatasetZip(result: BuildResult, out: Writable): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const date = archiveDate(result.asOf);
  const done = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    out.on('close', () => resolve());
    out.on('finish', () => resolve());
  });
  archive.pipe(out);
  for (const f of result.main) {
    archive.append(f.content, { name: f.name, date });
  }
  if (result.transcripts) {
    const folder = `transcripts-${result.asOf.slice(0, 10)}`;
    for (const f of result.transcripts) {
      archive.append(f.content, { name: `${folder}/${f.name}`, date });
    }
  }
  archive.finalize();
  return done;
}
