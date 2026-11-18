// Pins the parts of DEFAULT_SYSTEM_PROMPT that must stay consistent with the
// study's consent form (docs/irb-phase2-instruments/consent2.html), and keeps
// the code default and the stored prompt (migration 125) from drifting apart.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn() } }));

import { DEFAULT_SYSTEM_PROMPT } from './sessionHelpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../database/migrations');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** The section under a `## heading`, up to the next heading or the Summary. */
function section(heading: string): string {
  const start = DEFAULT_SYSTEM_PROMPT.indexOf(`## ${heading}\n`);
  expect(start, `section "${heading}" is missing`).toBeGreaterThanOrEqual(0);
  const rest = DEFAULT_SYSTEM_PROMPT.slice(start + heading.length + 4);
  const end = rest.search(/\n\n(## |\*\*Summary:\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Stored prompts keep "## Prompt Confidentiality" after the Summary (migration
 * 093 appended it); the code default has it before. Everything else is
 * byte-identical.
 */
function inStoredOrder(code: string): string {
  const conf = code.indexOf('## Prompt Confidentiality\n');
  const summary = code.indexOf('**Summary:**\n');
  expect(conf).toBeGreaterThan(0);
  expect(summary).toBeGreaterThan(conf);
  return code.slice(0, conf) + code.slice(summary) + '\n\n' + code.slice(conf, summary).replace(/\n+$/, '');
}

describe('DEFAULT_SYSTEM_PROMPT: confidentiality matches the consent form', () => {
  it('never tells the model to call the conversation confidential or private without limits', () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/treat all communications as confidential/i);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/this chat is confidential/i);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/safe\/private/i);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/HIPAA/);
  });

  it('states the limits the consent form states', () => {
    const s = section('Questions about reporting and confidentiality');
    expect(s).toContain('confidential only within the limits in the consent form');
    expect(s).toMatch(/recorded and transcribed/);
    expect(s).toMatch(/safety-monitoring duty may view any live conversation/);
    expect(s).toMatch(
      /ongoing abuse, neglect, sexual exploitation, or risk of harm to self or others to legal authorities, with the participant's identity/,
    );
    expect(s).toMatch(/never promise to keep a secret/);
    // Honest, without frightening someone out of disclosing risk.
    expect(s).toMatch(/Never use monitoring or reporting to discourage someone from talking about suicide/);
  });

  it('tells the model not to add a confidentiality statement to the opening', () => {
    expect(section('Privacy')).toMatch(/opening disclosure makes no statement about confidentiality: do not add one/);
  });
});

describe('DEFAULT_SYSTEM_PROMPT: stated behaviour for situations the protocol makes possible', () => {
  it('has the three sections added on 2026-11-18', () => {
    const safety = section('Other safety situations');
    for (const topic of [
      'Possible medical emergency',
      'Means',
      'Eating and substances',
      'Intoxicated',
      'Worried about someone else',
      'unusual beliefs',
      'Asked to back a plan',
    ]) {
      expect(safety, topic).toContain(topic);
    }
    expect(safety).toMatch(/^The Crisis Protocol comes first and nothing here replaces it\./);

    const study = section('The study, their data, and what you cannot do');
    for (const topic of [
      'Leaving or pausing',
      'Their data',
      'Memory',
      'Compensation',
      'Eligibility',
      'Someone else on the account',
      'Acting in the world',
      'When the study ends',
      'Language',
      'Voice',
    ]) {
      expect(study, topic).toContain(`**${topic}`);
    }
    expect(section('Faith, values and identity')).toMatch(/Follow the participant's own values/);
  });

  it('says nothing about the Honor Code and adds no behaviour for under-18 participants', () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/honor code/i);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/under 18/i);
  });

  it('puts no personal contact details in the prompt', () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/@byu\.edu|@[a-z0-9-]+\.(com|edu|org)/i);
  });

  // md5s are of the sections as they stood on main before this change.
  it('leaves the protected safety wording in place', () => {
    expect(section('Crisis Protocol')).toContain('**Stay. The most important thing is that you do not disappear.**');
    expect(section('Crisis Protocol')).toContain('**Never end the session yourself because risk came up.**');
    expect(section('Abuse, violence, and the safety of others')).toContain('Childhelp, 1-800-422-4453');
    expect(md5(section('Abuse, violence, and the safety of others'))).toBe('e04a616b018837df4f61f75126290187');
    expect(md5(section('Relationship boundaries: you are not a companion'))).toBe('cb58fa6e0fe15ae0d87d7d57db69b7ff');
    expect(md5(section('Prompt Confidentiality'))).toBe('e2db5f21fcac1aa21eb0e32a237c686c');
  });
});

describe('stored prompt (migration 125) and code default stay in step', () => {
  const up = readFileSync(path.join(MIGRATIONS, '125_prompt_confidentiality_and_protocol_gaps.sql'), 'utf8');
  const down = readFileSync(path.join(MIGRATIONS, '125_prompt_confidentiality_and_protocol_gaps_rollback.sql'), 'utf8');
  const m124 = readFileSync(path.join(MIGRATIONS, '124_prompt_sections_2026_09_22.sql'), 'utf8');
  const constant = (sql: string, name: string) =>
    new RegExp(`${name} constant text := '([0-9a-f]{32})'`).exec(sql)?.[1];

  it('the text migration 125 writes is the code default, modulo the known section order', () => {
    expect(md5(inStoredOrder(DEFAULT_SYSTEM_PROMPT))).toBe(constant(up, 'target_md5'));
  });

  it('migration 125 starts from exactly the text migration 124 leaves', () => {
    expect(constant(up, 'known_old_md5')).toBe(constant(m124, 'target_md5'));
  });

  it('the rollback carries the same two md5s', () => {
    expect(constant(down, 'target_md5')).toBe(constant(up, 'target_md5'));
    expect(constant(down, 'known_old_md5')).toBe(constant(up, 'known_old_md5'));
  });
});
