#!/usr/bin/env node
// lint-emoji: fail if any emoji appears in the repo's markdown or HTML.
// Complements the ESLint `no-emoji` rule (which covers string literals and JSX
// in .js/.ts/.tsx). Same definition of "emoji" and the same typographic
// allowlist: .eslint-rules/emoji-pattern.js. Read-only, no dependencies.
//
//   npm run lint:emoji
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { findEmoji } = createRequire(import.meta.url)(join(root, '.eslint-rules/emoji-pattern.js'));

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'redteam-results', 'redteam-baseline']);
const EXT = /\.(md|html)$/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

let problems = 0;
let files = 0;
for (const file of walk(root)) {
  files++;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const hit of findEmoji(line)) {
      problems++;
      console.log(`${relative(root, file)}:${i + 1}:${hit.index + 1}: emoji ${hit.label} ("${hit.char}") is not allowed`);
    }
  });
}

if (problems) {
  console.error(`\nlint-emoji: ${problems} problem(s) in ${files} file(s). No emojis (CLAUDE.md); typographic marks are listed in .eslint-rules/emoji-pattern.js.`);
  process.exit(1);
}
console.log(`lint-emoji: OK (${files} markdown/html files, no emoji)`);
