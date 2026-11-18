// Regenerate (or, with --check, verify) the IRB verbatim-prompts attachment.
//
//   npm run irb:prompts            rewrite docs/irb-phase2-instruments/prompts.html
//   npm run irb:prompts -- --check exit 1 if the committed file is out of date
//
// Rendering makes no API calls. Several prompt modules read the OpenAI key at
// import time, so a placeholder is set when none is present.
import { readFileSync, writeFileSync } from 'node:fs';

process.env.OPENAI_API_KEY ??= 'offline-render-no-api-calls';

const { renderPromptsAttachment, ATTACHMENT_PATH, ATTACHMENT_URL } = await import('./promptsAttachment.js');

const rendered = renderPromptsAttachment();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(ATTACHMENT_URL, 'utf8');
  } catch {
    // missing file counts as stale
  }
  if (current !== rendered) {
    console.error(`${ATTACHMENT_PATH} is out of date with the prompts in code. Run: npm run irb:prompts`);
    process.exit(1);
  }
  console.log(`${ATTACHMENT_PATH} is up to date.`);
} else {
  writeFileSync(ATTACHMENT_URL, rendered);
  console.log(`wrote ${ATTACHMENT_PATH}`);
}
process.exit(0);
