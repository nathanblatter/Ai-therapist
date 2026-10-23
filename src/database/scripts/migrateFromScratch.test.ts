// Plan-builder tests for migrateFromScratch.ts. No filesystem (file lists are
// handed in) and no database (the emptiness check gets a fake client).
import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERRIDES,
  MIGRATIONS_DIR,
  assertEmptyDatabase,
  buildPlan,
  discoverMigrationFiles,
  formatPlan,
  listMigrationFiles,
  parseArgs,
  splitStatements,
  type Override,
  type PlanStep,
} from './migrateFromScratch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// A directory listing shaped like the real one: unsorted, with rollbacks, a
// duplicate number, a .js migration and a stray file.
const LISTING = [
  '021_add_composite_message_index.sql',
  '003_normalize_schema_rollback.sql',
  '091_researcher_care_comms.sql',
  '010_fix_timestamp_columns.sql',
  '002_insert_initial_user.js',
  '001_create_users_table.sql',
  '091_access_audit_and_redaction_review.sql',
  '003_normalize_schema.sql',
  '069_organizations.sql',
  '021_add_composite_message_index_rollback.sql',
  'README.md',
  '036_drop_conversation_logs_table.sql',
];

const fileNames = (steps: PlanStep[]) => steps.map((s) => (s.kind === 'raw' ? `(raw) ${s.label}` : s.file));

describe('listMigrationFiles', () => {
  it('keeps forward .sql/.js files only, ordered by prefix then filename', () => {
    const files = listMigrationFiles(LISTING);
    expect(files.map((f) => f.name)).toEqual([
      '001_create_users_table.sql',
      '002_insert_initial_user.js',
      '003_normalize_schema.sql',
      '010_fix_timestamp_columns.sql',
      '021_add_composite_message_index.sql',
      '036_drop_conversation_logs_table.sql',
      '069_organizations.sql',
      '091_access_audit_and_redaction_review.sql',
      '091_researcher_care_comms.sql',
    ]);
    expect(files[1]).toEqual({ name: '002_insert_initial_user.js', number: 2, ext: 'js' });
  });
});

describe('buildPlan', () => {
  const files = listMigrationFiles(LISTING);

  it('applies the overrides: 001/021 autocommit, stub before 010, 002 deferred to the end', () => {
    const plan = buildPlan(files);
    expect(fileNames(plan)).toEqual([
      '001_create_users_table.sql',
      '003_normalize_schema.sql',
      '(raw) conversation_logs stub',
      '010_fix_timestamp_columns.sql',
      '021_add_composite_message_index.sql',
      '036_drop_conversation_logs_table.sql',
      '069_organizations.sql',
      '091_access_audit_and_redaction_review.sql',
      '091_researcher_care_comms.sql',
      '002_insert_initial_user.js',
    ]);
    const modes = Object.fromEntries(plan.filter((s) => s.kind === 'sql').map((s) => [s.file, s.mode]));
    expect(modes['001_create_users_table.sql']).toBe('autocommit');
    expect(modes['021_add_composite_message_index.sql']).toBe('autocommit');
    expect(modes['010_fix_timestamp_columns.sql']).toBe('transaction');
    expect(modes['091_researcher_care_comms.sql']).toBe('transaction');
    expect(plan[plan.length - 1].kind).toBe('js');
    const stub = plan[2];
    expect(stub.kind === 'raw' && stub.sql).toMatch(/CREATE TABLE IF NOT EXISTS conversation_logs/);
  });

  it('--to bounds the plan and skips a deferred step whose requirement is above the bound', () => {
    const plan = buildPlan(files, { to: 36 });
    expect(fileNames(plan)).toEqual([
      '001_create_users_table.sql',
      '003_normalize_schema.sql',
      '(raw) conversation_logs stub',
      '010_fix_timestamp_columns.sql',
      '021_add_composite_message_index.sql',
      '036_drop_conversation_logs_table.sql',
      '002_insert_initial_user.js',
    ]);
    const last = plan[plan.length - 1];
    expect(last.kind).toBe('skip');
    expect(last.kind === 'skip' && last.note).toMatch(/needs 069, plan stops at 036/);
  });

  it('--to at or above the requirement keeps the deferred step live', () => {
    const plan = buildPlan(files, { to: 69 });
    const last = plan[plan.length - 1];
    expect(last).toMatchObject({ kind: 'js', file: '002_insert_initial_user.js' });
  });

  it('--to below 010 produces no stub', () => {
    const plan = buildPlan(files, { to: 3 });
    expect(fileNames(plan)).toEqual([
      '001_create_users_table.sql',
      '003_normalize_schema.sql',
      '002_insert_initial_user.js',
    ]);
    expect(plan.some((s) => s.kind === 'raw')).toBe(false);
  });

  it('refuses an override that names a file which is not on disk', () => {
    const bad: Override[] = [{ file: '999_gone.sql', reason: 'renamed away', mode: 'autocommit' }];
    expect(() => buildPlan(files, { overrides: bad })).toThrow(/missing migration file 999_gone\.sql/);
  });

  it('with no overrides every sql file is transactional and js files keep their numeric slot', () => {
    const plan = buildPlan(files, { overrides: [] });
    expect(plan.every((s) => s.kind !== 'raw' && s.kind !== 'skip')).toBe(true);
    expect(plan[1]).toMatchObject({ kind: 'js', file: '002_insert_initial_user.js' });
    expect(plan.filter((s) => s.kind === 'sql').every((s) => s.mode === 'transaction')).toBe(true);
  });

  it('formatPlan lists one numbered line per step', () => {
    const text = formatPlan(buildPlan(files, { to: 36 }));
    const lines = text.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/^1\. 001_create_users_table\.sql {2}\[autocommit\]/);
    expect(lines[2]).toMatch(/^3\. \(raw\) conversation_logs stub {2}\[autocommit\]/);
    expect(lines[6]).toMatch(/SKIPPED: needs 069/);
  });
});

describe('real migrations directory', () => {
  it('every override still names a file on disk and the plan ends with 002', () => {
    const files = discoverMigrationFiles(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(100);
    const plan = buildPlan(files);
    expect(plan[plan.length - 1]).toMatchObject({ kind: 'js', file: '002_insert_initial_user.js' });
    expect(plan.filter((s) => s.kind === 'skip')).toHaveLength(0);
    const onDisk = new Set(files.map((f) => f.name));
    for (const o of OVERRIDES) expect(onDisk.has(o.file)).toBe(true);
  });

  it('only the files marked autocommit contain CONCURRENTLY', () => {
    const autocommit = new Set(OVERRIDES.filter((o) => o.mode === 'autocommit').map((o) => o.file));
    for (const f of discoverMigrationFiles(MIGRATIONS_DIR)) {
      if (f.ext !== 'sql') continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f.name), 'utf8');
      if (/CONCURRENTLY/i.test(sql)) expect(autocommit.has(f.name)).toBe(true);
    }
  });
});

describe('splitStatements', () => {
  it('splits on semicolons outside comments, strings and dollar quotes', () => {
    const sql = `-- header; not a statement
CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t(a, b DESC);
/* block; comment */
INSERT INTO t VALUES ('a;b', $$x;y$$);
DO $fn$ BEGIN PERFORM 1; END $fn$;
SELECT 1`;
    expect(splitStatements(sql)).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t(a, b DESC)',
      "INSERT INTO t VALUES ('a;b', $$x;y$$)",
      'DO $fn$ BEGIN PERFORM 1; END $fn$',
      'SELECT 1',
    ]);
  });

  it('keeps escaped quotes inside strings', () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2;")).toEqual(["SELECT 'it''s; fine'", 'SELECT 2']);
  });

  it('yields exactly one statement for 021 on disk', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '021_add_composite_message_index.sql'), 'utf8');
    expect(splitStatements(sql)).toHaveLength(1);
  });
});

describe('assertEmptyDatabase', () => {
  it('passes on an empty database', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(assertEmptyDatabase(db)).resolves.toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('refuses and names the objects it found', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ name: 'public.users' }, { name: 'public.messages' }] }) };
    await expect(assertEmptyDatabase(db)).rejects.toThrow(/not empty \(found public\.users, public\.messages\)/);
  });

  it('truncates a long listing with an ellipsis', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ name: `public.t${i}` }));
    const db = { query: vi.fn().mockResolvedValue({ rows }) };
    await expect(assertEmptyDatabase(db)).rejects.toThrow(/public\.t9, \.\.\.\)/);
  });
});

describe('parseArgs', () => {
  it('parses the three flags and --to in both spellings', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, allowExisting: false, help: false });
    expect(parseArgs(['--dry-run', '--to', '030'])).toMatchObject({ dryRun: true, to: 30 });
    expect(parseArgs(['--to=091', '--allow-existing'])).toMatchObject({ to: 91, allowExisting: true });
  });

  it('rejects unknown arguments and a malformed --to', () => {
    expect(() => parseArgs(['--from', '3'])).toThrow(/unknown argument --from/);
    expect(() => parseArgs(['--to', 'abc'])).toThrow(/three-digit/);
    expect(() => parseArgs(['--to'])).toThrow(/three-digit/);
  });
});

describe('scripts/redteam-db-setup.sh', () => {
  it('passes bash -n and calls migrateFromScratch.ts before the seeds', () => {
    const script = path.join(repoRoot, 'scripts/redteam-db-setup.sh');
    expect(() => execSync(`bash -n ${script}`, { stdio: 'pipe' })).not.toThrow();
    const body = fs.readFileSync(script, 'utf8');
    const migrate = body.lastIndexOf('migrateFromScratch.ts"');
    const seed = body.lastIndexOf('redteam-seed.sql"');
    const user = body.lastIndexOf('redteam-seed-user.mjs"');
    expect(migrate).toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(migrate);
    expect(user).toBeGreaterThan(seed);
    expect(body).toMatch(/unset IMESSAGE_API_KEY/);
    expect(body).toMatch(/unset CRISIS_ALERT_PHONE/);
    expect(body).not.toMatch(/runMigrationRange\.js" /);
  });
});
