// migrateFromScratch.ts - bring an EMPTY Postgres to the current migration head
// in one deterministic command (eval program WP8; replaces the hand-ordered
// sequence that used to live in scripts/redteam-db-setup.sh).
//
// Usage (from the repo root, under tsx; node is not on PATH by default):
//   DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/ai_therapist_scratch \
//     npx tsx src/database/scripts/migrateFromScratch.ts [--to NNN] [--dry-run] [--allow-existing]
//
// Env:   DATABASE_URL (required; this script deliberately does NOT read .env so
//        it can never land on stage by accident), DATABASE_SSL=true for RDS.
// Flags: --to NNN          stop after prefix NNN (partial bootstrap; steps that
//                          need a later migration are skipped and say so)
//        --dry-run         print the plan, touch nothing (no connection made)
//        --allow-existing  skip the empty-database check. Nothing is skipped or
//                          reconciled: every file re-applies, and not every
//                          migration is idempotent (091's DROP CONSTRAINT has
//                          no IF EXISTS). Only for databases you can throw away.
//
// How it works: every NNN_*.sql / NNN_*.js in src/database/migrations (minus
// *_rollback*) is applied in prefix-then-filename order, each .sql file in its
// own transaction on one pg client. The handful of files that cannot be treated
// that way are listed as data in OVERRIDES below, nowhere else. There is no
// migrations table in this project (docs/db.md), so the runner refuses to start
// on a database that already has objects instead of guessing what was applied.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src/database/migrations');

// --- Override table ---------------------------------------------------------
//
// Every special case the bootstrap needs, as data. Keep this table and the
// explanation in docs/db.md ("Migrations" > "Bootstrapping from empty") in step.
//
//   mode: 'autocommit'  The file runs statement by statement outside any
//                       transaction (what `psql -f` did), on a dedicated client.
//                       Needed for CREATE INDEX CONCURRENTLY, which Postgres
//                       refuses inside a transaction block.
//   before: { sql }     Extra SQL applied (autocommit) immediately before the
//                       file. Used for legacy state no migration creates.
//   deferToEnd          A migration whose number predates the objects it needs.
//                       It runs after every SQL migration in the plan instead
//                       of at its numeric position; `requires` is the prefix it
//                       depends on, so a `--to` below that skips it (with a
//                       log line) rather than failing.

export interface Override {
  file: string;
  reason: string;
  mode?: 'autocommit';
  before?: { label: string; sql: string };
  deferToEnd?: { requires: number };
}

export const OVERRIDES: readonly Override[] = [
  {
    file: '001_create_users_table.sql',
    mode: 'autocommit',
    reason:
      'Historically applied raw with psql -f (the range runner started at 003). ' +
      'Kept statement-by-statement so the bootstrap matches that record exactly.',
  },
  {
    file: '002_insert_initial_user.js',
    deferToEnd: { requires: 69 },
    reason:
      'Seeds the first researcher account via the app pool; users.organization_id ' +
      'is NOT NULL since 069 and the irb-study org row comes from 069, so it runs ' +
      'after the SQL migrations.',
  },
  {
    file: '010_fix_timestamp_columns.sql',
    before: {
      label: 'conversation_logs stub',
      sql:
        'CREATE TABLE IF NOT EXISTS conversation_logs ' +
        '(id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);',
    },
    reason:
      'conversation_logs is a pre-001 legacy table no migration creates; 010 ALTERs ' +
      'its created_at column and 036 drops it, so an empty database needs a stub.',
  },
  {
    file: '021_add_composite_message_index.sql',
    mode: 'autocommit',
    reason: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block.',
  },
];

// --- Plan -------------------------------------------------------------------

export type PlanStep =
  | { kind: 'sql'; file: string; mode: 'transaction' | 'autocommit'; note?: string }
  | { kind: 'raw'; label: string; sql: string; note: string }
  | { kind: 'js'; file: string; note?: string }
  | { kind: 'skip'; file: string; note: string };

export interface MigrationFile {
  name: string;
  number: number;
  ext: 'sql' | 'js';
}

export const MIGRATION_FILE_RE = /^(\d{3})_.*\.(sql|js)$/;

/** Forward migration files in prefix-then-filename order (rollbacks excluded). */
export function listMigrationFiles(names: readonly string[]): MigrationFile[] {
  return names
    .map((name) => ({ name, m: MIGRATION_FILE_RE.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null && !x.name.includes('_rollback'))
    .map(({ name, m }) => ({ name, number: Number(m[1]), ext: m[2] as 'sql' | 'js' }))
    .sort((a, b) => a.number - b.number || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function discoverMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return listMigrationFiles(fs.readdirSync(dir));
}

export interface PlanOptions {
  /** Inclusive upper bound on the three-digit prefix; undefined = everything. */
  to?: number;
  overrides?: readonly Override[];
}

/**
 * Turn the file list into an ordered list of steps. Pure: no filesystem, no
 * database. Throws if an override names a file that does not exist, so a
 * renamed migration cannot silently lose its special handling.
 */
export function buildPlan(files: readonly MigrationFile[], opts: PlanOptions = {}): PlanStep[] {
  const overrides = opts.overrides ?? OVERRIDES;
  const byFile = new Map(overrides.map((o) => [o.file, o]));
  const known = new Set(files.map((f) => f.name));
  for (const o of overrides) {
    if (!known.has(o.file)) {
      throw new Error(`migrateFromScratch: override refers to missing migration file ${o.file}`);
    }
  }

  const selected = files.filter((f) => opts.to === undefined || f.number <= opts.to);
  const steps: PlanStep[] = [];
  const deferred: PlanStep[] = [];

  for (const f of selected) {
    const o = byFile.get(f.name);
    if (o?.before) {
      steps.push({ kind: 'raw', label: o.before.label, sql: o.before.sql, note: `before ${f.name}: ${o.reason}` });
    }
    let step: PlanStep;
    if (f.ext === 'js') {
      step = { kind: 'js', file: f.name, note: o?.reason };
    } else {
      step = { kind: 'sql', file: f.name, mode: o?.mode ?? 'transaction', note: o?.mode ? o.reason : undefined };
    }
    if (o?.deferToEnd) {
      const maxSelected = selected.length ? selected[selected.length - 1].number : 0;
      if (maxSelected < o.deferToEnd.requires) {
        const req = String(o.deferToEnd.requires).padStart(3, '0');
        deferred.push({ kind: 'skip', file: f.name, note: `needs ${req}, plan stops at ${String(maxSelected).padStart(3, '0')}` });
      } else {
        deferred.push({ ...step, note: o.reason });
      }
    } else {
      steps.push(step);
    }
  }
  return [...steps, ...deferred];
}

export function formatPlan(steps: readonly PlanStep[]): string {
  const width = String(steps.length).length;
  return steps
    .map((s, i) => {
      const n = String(i + 1).padStart(width, ' ');
      switch (s.kind) {
        case 'sql':
          return `${n}. ${s.file}  [${s.mode}]${s.note ? `  -- ${s.note}` : ''}`;
        case 'raw':
          return `${n}. (raw) ${s.label}  [autocommit]  -- ${s.note}`;
        case 'js':
          return `${n}. ${s.file}  [tsx subprocess]${s.note ? `  -- ${s.note}` : ''}`;
        case 'skip':
          return `${n}. ${s.file}  [SKIPPED: ${s.note}]`;
      }
    })
    .join('\n');
}

// --- SQL splitting (autocommit files only) ----------------------------------

/**
 * Split a SQL file into statements so each can run as its own autocommit
 * query (a multi-statement simple query is wrapped in an implicit transaction,
 * which is exactly what CONCURRENTLY forbids). Understands -- comments,
 * block comments, single-quoted strings and $tag$ dollar quoting. Used only for
 * override files; transactional files are sent whole.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// --- Empty-database check ---------------------------------------------------

export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const USER_OBJECTS_SQL = `
  SELECT n.nspname || '.' || c.relname AS name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ORDER BY 1
  LIMIT 11`;

/**
 * Throws when the database already holds user tables, views, sequences or
 * foreign tables. Extensions (pgvector) are ignored: CI images ship with them
 * and no migration data lives there.
 */
export async function assertEmptyDatabase(db: Queryable): Promise<void> {
  const { rows } = await db.query(USER_OBJECTS_SQL);
  if (rows.length === 0) return;
  const shown = rows.slice(0, 10).map((r) => String(r.name));
  const more = rows.length > 10 ? ', ...' : '';
  throw new Error(
    'migrateFromScratch: refusing to run, the database is not empty ' +
      `(found ${shown.join(', ')}${more}). There is no migrations table, so ` +
      'nothing can tell what has already been applied. Use runMigrationRange.js ' +
      'for an existing database, or drop and recreate this one. ' +
      '--allow-existing bypasses this check for throwaway databases only.',
  );
}

// --- Execution --------------------------------------------------------------

export interface ExecOptions {
  connectionString: string;
  ssl: boolean;
  allowExisting: boolean;
  migrationsDir?: string;
  log?: (line: string) => void;
}

function tsxCommand(): { cmd: string; args: string[] } {
  const local = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
  if (fs.existsSync(local)) return { cmd: local, args: [] };
  return { cmd: 'npx', args: ['--no-install', 'tsx'] };
}

function fmtMs(start: number): string {
  return `${String(Date.now() - start).padStart(5, ' ')} ms`;
}

export async function executePlan(steps: readonly PlanStep[], opts: ExecOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const ssl = opts.ssl ? { rejectUnauthorized: false } : false;
  const width = String(steps.length).length;
  const tag = (i: number) => `[${String(i + 1).padStart(width, ' ')}/${steps.length}]`;

  const client = new pg.Client({ connectionString: opts.connectionString, ssl });
  await client.connect();
  try {
    if (opts.allowExisting) {
      log('--allow-existing: skipping the empty-database check; every file will re-apply');
    } else {
      await assertEmptyDatabase(client);
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const start = Date.now();
      switch (step.kind) {
        case 'sql': {
          const sql = fs.readFileSync(path.join(dir, step.file), 'utf8');
          if (step.mode === 'transaction') {
            try {
              await client.query('BEGIN');
              await client.query(sql);
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK').catch(() => undefined);
              throw new Error(`${step.file}: ${(err as Error).message}`);
            }
          } else {
            // Dedicated client so no session or transaction state leaks in.
            const raw = new pg.Client({ connectionString: opts.connectionString, ssl });
            await raw.connect();
            try {
              for (const stmt of splitStatements(sql)) await raw.query(stmt);
            } catch (err) {
              throw new Error(`${step.file} (autocommit): ${(err as Error).message}`);
            } finally {
              await raw.end();
            }
          }
          log(`${tag(i)} ${step.file.padEnd(58)} ${step.mode.padEnd(11)} OK ${fmtMs(start)}`);
          break;
        }
        case 'raw': {
          const raw = new pg.Client({ connectionString: opts.connectionString, ssl });
          await raw.connect();
          try {
            for (const stmt of splitStatements(step.sql)) await raw.query(stmt);
          } finally {
            await raw.end();
          }
          log(`${tag(i)} ${`(raw) ${step.label}`.padEnd(58)} ${'autocommit'.padEnd(11)} OK ${fmtMs(start)}`);
          break;
        }
        case 'js': {
          const { cmd, args } = tsxCommand();
          const res = spawnSync(cmd, [...args, path.join(dir, step.file)], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            env: {
              ...process.env,
              DATABASE_URL: opts.connectionString,
              DATABASE_SSL: opts.ssl ? 'true' : 'false',
            },
          });
          if (res.status !== 0) {
            throw new Error(`${step.file} (tsx) exited ${res.status}: ${(res.stderr || res.stdout || '').trim()}`);
          }
          log(`${tag(i)} ${step.file.padEnd(58)} ${'tsx'.padEnd(11)} OK ${fmtMs(start)}`);
          break;
        }
        case 'skip':
          log(`${tag(i)} ${step.file.padEnd(58)} ${'skipped'.padEnd(11)} ${step.note}`);
          break;
      }
    }
  } finally {
    await client.end();
  }
}

// --- CLI --------------------------------------------------------------------

export interface CliArgs {
  to?: number;
  dryRun: boolean;
  allowExisting: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { dryRun: false, allowExisting: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-existing') out.allowExisting = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--to') {
      const v = argv[++i];
      if (!/^\d{1,3}$/.test(v ?? '')) throw new Error(`--to expects a three-digit migration number, got ${v ?? '(nothing)'}`);
      out.to = Number(v);
    } else if (a.startsWith('--to=')) {
      const v = a.slice(5);
      if (!/^\d{1,3}$/.test(v)) throw new Error(`--to expects a three-digit migration number, got ${v}`);
      out.to = Number(v);
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

const USAGE = `Usage: npx tsx src/database/scripts/migrateFromScratch.ts [--to NNN] [--dry-run] [--allow-existing]
Brings an EMPTY database (DATABASE_URL, DATABASE_SSL=true for RDS) to the current migration head.`;

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`migrateFromScratch: ${(err as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const files = discoverMigrationFiles();
  const steps = buildPlan(files, { to: args.to });
  const head = files.length ? String(files[files.length - 1].number).padStart(3, '0') : '(none)';
  const target = args.to === undefined ? `head ${head}` : `${String(args.to).padStart(3, '0')} (head on disk ${head})`;

  if (args.dryRun) {
    console.log(`migrateFromScratch: dry run, ${steps.length} step(s) to ${target}\n${formatPlan(steps)}`);
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('migrateFromScratch: DATABASE_URL must be set (this script does not read .env on purpose)');
    process.exit(2);
  }
  console.log(`migrateFromScratch: ${steps.length} step(s) to ${target}, target ${connectionString.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')}`);
  const start = Date.now();
  await executePlan(steps, {
    connectionString,
    ssl: process.env.DATABASE_SSL === 'true',
    allowExisting: args.allowExisting,
  });
  console.log(`migrateFromScratch: done in ${Date.now() - start} ms`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: Error) => {
    console.error(`migrateFromScratch: FAILED: ${err.message}`);
    process.exit(1);
  });
}
