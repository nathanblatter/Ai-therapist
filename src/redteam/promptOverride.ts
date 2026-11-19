// `--prompt-file <file>`: run the harness with a different base system prompt.
//
// The file's text replaces the stored chat and realtime prompt IN THIS PROCESS
// (sessionHelpers.setSystemPromptOverride), the same way --variant overlays
// feature flags: nothing is written to system_config, so it is safe on any
// database and two wordings can be compared on one disposable database. It is
// for prompt experiments (old prompt versus new, a candidate edit); results are
// labelled with the file's md5 in prompt-override.json in --out.
//
// The text is used exactly as stored prompts are: {{crisis_text}} is still
// interpolated and the language, modality and feature appendices still apply.
// One trailing newline is dropped (a psql or editor artefact, never part of a
// stored prompt).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** `--prompt-file <file>` from argv; null when the flag is absent. */
export function promptFileArg(argv: readonly string[]): string | null {
  const i = argv.indexOf('--prompt-file');
  if (i === -1) return null;
  const file = argv[i + 1];
  if (!file || file.startsWith('--')) throw new Error('--prompt-file needs a file path');
  return file;
}

/** Read the override text; refuses an empty or implausibly short file. */
export function readPromptFile(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`prompt override: cannot read ${file}: ${(err as Error).message}`);
  }
  text = text.replace(/\r?\n$/, '');
  if (text.length < 500) throw new Error(`prompt override: ${file} has ${text.length} characters; not a system prompt`);
  return text;
}

export function promptMd5(text: string): string {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** The whole `--prompt-file` step for cli.ts: no-op without the flag. */
export async function applyPromptOverrideFromArgv(argv: readonly string[], outDir: string): Promise<string | null> {
  const file = promptFileArg(argv);
  if (!file) return null;
  const text = readPromptFile(file);
  const { setSystemPromptOverride, invalidateConfigCache } = await import('../server/utils/sessionHelpers.js');
  setSystemPromptOverride(text);
  invalidateConfigCache();
  const md5 = promptMd5(text);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'prompt-override.json'),
    JSON.stringify({ file: path.resolve(file), md5, characters: text.length }, null, 2) + '\n',
  );
  console.log(`[redteam] prompt override ${md5} (${text.length} characters) from ${file}`);
  return md5;
}
