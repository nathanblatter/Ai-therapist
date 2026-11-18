import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ATTACHMENT_PATH, ATTACHMENT_URL, renderPromptsAttachment } from './promptsAttachment.js';
import { DEFAULT_SYSTEM_PROMPT } from '../utils/sessionHelpers.js';
import { SAFETY_PROTOCOL_GUIDANCE } from '../services/crisisIntervention.service.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('IRB verbatim-prompts attachment', () => {
  it(`${ATTACHMENT_PATH} matches the prompts in code (run \`npm run irb:prompts\` to regenerate)`, () => {
    const committed = readFileSync(ATTACHMENT_URL, 'utf8');
    // A plain boolean keeps the failure readable; the diff of a 70 KB string is not.
    const upToDate = committed === renderPromptsAttachment();
    expect(upToDate, `${ATTACHMENT_PATH} is stale: run \`npm run irb:prompts\` and commit the result`).toBe(true);
  });

  it('is deterministic', () => {
    expect(renderPromptsAttachment()).toBe(renderPromptsAttachment());
  });

  it('carries prompt text verbatim', () => {
    const html = renderPromptsAttachment();
    expect(html).toContain(`<pre>${escapeHtml(DEFAULT_SYSTEM_PROMPT)}</pre>`);
    expect(html).toContain(`<pre>${escapeHtml(SAFETY_PROTOCOL_GUIDANCE)}</pre>`);
  });
});
