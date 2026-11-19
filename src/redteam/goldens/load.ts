// Load and validate the golden JSONL files. Every problem is reported with its
// file and line, so a reviewer who edits a row by hand can find the mistake.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { detectorRowSchema, replyRowSchema, type DetectorRow, type ReplyRow } from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const GOLDENS_DIR = path.join(REPO_ROOT, 'evals/goldens');
export const DETECTOR_FILE = path.join(GOLDENS_DIR, 'detector.jsonl');
export const REPLY_FILE = path.join(GOLDENS_DIR, 'reply.jsonl');
export const CATALOGUE_FILE = path.join(REPO_ROOT, 'docs/eval-scenario-catalogue.md');

/** Every scenario id the catalogue defines (its `**CRI-10 Title.**` headings). */
export function loadCatalogueIds(file = CATALOGUE_FILE): Set<string> {
  const text = fs.readFileSync(file, 'utf8');
  return new Set([...text.matchAll(/^\*\*([A-Z]{2,4}-\d{2}) /gm)].map((m) => m[1]));
}

export interface LoadResult<T> {
  rows: T[];
  errors: string[];
}

function loadJsonl<T extends { id: string; catalogueIds: string[] }>(
  file: string,
  schema: z.ZodType<T>,
  catalogue: Set<string>,
): LoadResult<T> {
  const rows: T[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const name = path.relative(REPO_ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const at = `${name}:${i + 1}`;
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      errors.push(`${at}: not valid JSON (${(err as Error).message})`);
      return;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown })?.id;
      for (const issue of parsed.error.issues) {
        errors.push(
          `${at}${typeof id === 'string' ? ` (${id})` : ''}: ${issue.path.join('.') || 'row'}: ${issue.message}`,
        );
      }
      return;
    }
    const row = parsed.data;
    const first = seen.get(row.id);
    if (first !== undefined) errors.push(`${at}: duplicate id ${row.id} (first on line ${first})`);
    else seen.set(row.id, i + 1);
    for (const c of row.catalogueIds) {
      if (!catalogue.has(c)) errors.push(`${at} (${row.id}): unknown catalogue id ${c}`);
    }
    rows.push(row);
  });
  return { rows, errors };
}

export function loadDetectorGoldens(file = DETECTOR_FILE, catalogue = loadCatalogueIds()): LoadResult<DetectorRow> {
  return loadJsonl(file, detectorRowSchema as unknown as z.ZodType<DetectorRow>, catalogue);
}

export function loadReplyGoldens(file = REPLY_FILE, catalogue = loadCatalogueIds()): LoadResult<ReplyRow> {
  return loadJsonl(file, replyRowSchema as unknown as z.ZodType<ReplyRow>, catalogue);
}
