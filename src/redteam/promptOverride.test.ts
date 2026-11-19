// `--prompt-file`: the override text reaches the stored chat and realtime
// prompt through getSystemConfig() in this process, and nothing is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(async () => ({
    rows: [
      {
        config_key: 'system_prompts',
        config_value: {
          chat: { prompt: 'stored chat' },
          realtime: { prompt: 'stored realtime' },
          active_modality: 'none',
        },
      },
    ],
  })),
}));
vi.mock('../server/config/db.js', () => ({ pool: { query } }));

import { applyPromptOverrideFromArgv, promptFileArg, promptMd5, readPromptFile } from './promptOverride.js';
import { getSystemConfig, invalidateConfigCache, setSystemPromptOverride } from '../server/utils/sessionHelpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-override-'));
const LONG = 'x'.repeat(600);

afterEach(() => {
  setSystemPromptOverride(null);
  invalidateConfigCache();
});

describe('promptFileArg / readPromptFile', () => {
  it('reads the flag and refuses a missing value', () => {
    expect(promptFileArg(['--suite', 'full'])).toBeNull();
    expect(promptFileArg(['--prompt-file', 'a.txt'])).toBe('a.txt');
    expect(() => promptFileArg(['--prompt-file', '--suite'])).toThrow(/needs a file path/);
  });
  it('drops one trailing newline and refuses a short file', () => {
    const f = path.join(tmp, 'p.txt');
    fs.writeFileSync(f, `${LONG}\n`);
    expect(readPromptFile(f)).toBe(LONG);
    fs.writeFileSync(f, 'short');
    expect(() => readPromptFile(f)).toThrow(/not a system prompt/);
  });
});

describe('applyPromptOverrideFromArgv', () => {
  it('is a no-op without the flag', async () => {
    expect(await applyPromptOverrideFromArgv([], tmp)).toBeNull();
    const cfg = await getSystemConfig();
    expect(cfg.system_prompts?.chat?.prompt).toBe('stored chat');
  });
  it('overlays both prompts in-process, keeps the other keys, and labels the run', async () => {
    const f = path.join(tmp, 'override.txt');
    fs.writeFileSync(f, LONG);
    const md5 = await applyPromptOverrideFromArgv(['--prompt-file', f], tmp);
    expect(md5).toBe(promptMd5(LONG));
    const cfg = await getSystemConfig();
    expect(cfg.system_prompts?.chat?.prompt).toBe(LONG);
    expect(cfg.system_prompts?.realtime?.prompt).toBe(LONG);
    expect(cfg.system_prompts?.active_modality).toBe('none');
    const label = JSON.parse(fs.readFileSync(path.join(tmp, 'prompt-override.json'), 'utf8'));
    expect(label).toMatchObject({ md5, characters: 600 });
    // Only SELECTs: nothing was written to system_config.
    for (const call of query.mock.calls as unknown as Array<[string]>)
      expect(String(call[0])).not.toMatch(/INSERT|UPDATE/i);
  });
});
