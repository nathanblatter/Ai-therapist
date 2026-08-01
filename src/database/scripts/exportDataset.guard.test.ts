import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeOutputPath } from './exportDataset.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

describe('assertSafeOutputPath (spec §7)', () => {
  it('refuses paths under ~/Desktop', () => {
    expect(() => assertSafeOutputPath(path.join(os.homedir(), 'Desktop', 'x'))).toThrow(/Desktop/);
  });

  it('refuses paths under ~/Documents', () => {
    expect(() => assertSafeOutputPath(path.join(os.homedir(), 'Documents', 'exp'))).toThrow(/Documents/);
  });

  it('refuses ~/Desktop itself', () => {
    expect(() => assertSafeOutputPath(path.join(os.homedir(), 'Desktop'))).toThrow();
  });

  it('allows a path under ~/docker-services', () => {
    expect(() => assertSafeOutputPath(path.join(os.homedir(), 'docker-services', 'ai-therapist-exports'))).not.toThrow();
  });
});

describe('backup script', () => {
  it('passes bash syntax check (bash -n)', () => {
    expect(() =>
      execSync(`bash -n ${path.join(repoRoot, 'scripts/backup-ai-therapist.sh')}`, { stdio: 'pipe' })
    ).not.toThrow();
  });
});
