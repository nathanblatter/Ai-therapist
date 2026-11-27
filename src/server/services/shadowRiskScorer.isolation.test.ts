// Structural guard for the shadow risk scorer (ai-therapist-83): it must stay
// a dead end. The behavioural proof is crisisPipeline.shadowScorer.test.ts;
// this file keeps a later edit from quietly wiring the scorer into something
// that acts.
//
//   1. The scorer's modules import nothing that steers, flags, pages, emits
//      to a socket, queues work or sends a message.
//   2. Nothing on the server reads shadow_risk_scores except the scorer's own
//      query module (its insert, and the researcher report).
//   3. The crisis pipeline calls the scorer exactly once, without awaiting it
//      and without using a return value.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const read = (rel: string): string => fs.readFileSync(path.join(serverRoot, rel), 'utf8');

function importsOf(source: string): string[] {
  const found = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((x) => x[1]);
  return [...new Set(found)];
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('shadow risk scorer isolation', () => {
  it('the scorer imports only its questions, its queries, config, the key and the logger', () => {
    expect(importsOf(read('services/shadowRiskScorer.service.ts')).sort()).toEqual(
      [
        '../../shared/riskBands.js',
        '../config/secrets.js',
        '../db/config.queries.js',
        '../db/shadowRisk.queries.js',
        '../utils/logger.js',
        './shadowRiskQuestions.js',
        'openai',
      ].sort(),
    );
    expect(importsOf(read('services/shadowRiskQuestions.ts')).sort()).toEqual(['../../shared/riskBands.js', 'openai']);
    expect(importsOf(read('db/shadowRisk.queries.ts')).sort()).toEqual(
      ['../../shared/riskBands.js', '../config/db.js', './irbPacket.queries.js'].sort(),
    );
  });

  it('the scorer never names an acting part of the system', () => {
    const acting =
      /crisisPipeline|crisisDetection|crisisIntervention|crisisPaging|crisisAlert|crisisResources|adminBroadcast|workQueue|adverseEvent|notification|emailer|global\.io|flagSessionCrisis|UPDATE\s|DELETE\s/;
    for (const file of ['services/shadowRiskScorer.service.ts', 'services/shadowRiskQuestions.ts']) {
      const code = read(file)
        .split('\n')
        .filter(
          (line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'),
        )
        .join('\n');
      expect(code, file).not.toMatch(acting);
    }
    // The query module writes one thing: its own table.
    const queries = read('db/shadowRisk.queries.ts');
    expect(queries.match(/INSERT INTO (\w+)/g)).toEqual(['INSERT INTO shadow_risk_scores']);
    expect(queries).not.toMatch(/\b(UPDATE|DELETE FROM)\s/);
  });

  it('only the scorer query module touches shadow_risk_scores', () => {
    const users = sourceFiles(serverRoot)
      .filter((f) => fs.readFileSync(f, 'utf8').includes('shadow_risk_scores'))
      .map((f) => path.relative(serverRoot, f))
      .sort();
    // The service names the table in comments only; the routes file and the
    // pipeline do not name it at all.
    expect(users).toEqual(['db/shadowRisk.queries.ts', 'services/shadowRiskScorer.service.ts']);
    expect(read('services/shadowRiskScorer.service.ts')).not.toMatch(/(FROM|INTO|JOIN)\s+shadow_risk_scores/);
  });

  it('the crisis pipeline calls the scorer once, fire-and-forget', () => {
    const pipeline = read('services/crisisPipeline.service.ts');
    const calls = pipeline.match(/.*shadowScoreTurn\(.*/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.trim()).toBe('shadowScoreTurn({');
    // Nothing else from the scorer is imported into the pipeline.
    expect(pipeline.match(/import .* from '\.\/shadowRiskScorer\.service\.js';/g)).toEqual([
      "import { shadowScoreTurn } from './shadowRiskScorer.service.js';",
    ]);
    // No other acting module imports the scorer.
    const importers = sourceFiles(serverRoot)
      .filter((f) => /shadowRiskScorer\.service\.js/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(serverRoot, f))
      .sort();
    expect(importers).toEqual(['index.ts', 'routes/admin/shadowRisk.routes.ts', 'services/crisisPipeline.service.ts']);
  });
});
