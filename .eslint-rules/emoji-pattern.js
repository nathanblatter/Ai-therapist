'use strict';
// Single definition of "what counts as an emoji" for this repo. Used by both
// the ESLint rule (.eslint-rules/no-emoji.js, source files) and the docs
// checker (scripts/lint-emoji.mjs, markdown + html). The project rule
// (CLAUDE.md) is: no emojis anywhere, but typographic characters are fine.
//
// Forbidden: anything Unicode classes as Extended_Pictographic, the whole
// Miscellaneous Symbols + Dingbats blocks (U+2600-U+27BF), the emoji
// presentation selector U+FE0F (it turns a text glyph into an emoji), and the
// supplementary emoji planes (U+1F000-U+1FFFF) as a belt-and-braces catch.
//
// Allowed (typographic marks that happen to fall in those ranges):
//   U+00A9 copyright, U+00AE registered, U+2122 trade mark (legal text in docs)
//   U+2194 left-right arrow, U+25B6 / U+25C0 triangles (ASCII-art diagrams)
//   U+2605 black star (IRB question marker)
//   U+2713 check mark, U+2715 multiplication x, U+2717 ballot x (console reports,
//   dismiss buttons). Note U+2714 / U+2716 (the HEAVY variants) are emoji.
const ALLOWED = new Set([
  0x00a9, 0x00ae, 0x2122, 0x2194, 0x25b6, 0x25c0, 0x2605, 0x2713, 0x2715, 0x2717,
]);

const CANDIDATE = /\p{Extended_Pictographic}|[☀-➿]|️|[\u{1F000}-\u{1FFFF}]/gu;

/** Returns the forbidden emoji code points found in `text` (deduplicated, in order). */
function findEmoji(text) {
  const found = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const cp = m[0].codePointAt(0);
    if (ALLOWED.has(cp)) continue;
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    if (!found.some(f => f.label === label)) found.push({ label, char: m[0], index: m.index });
  }
  return found;
}

module.exports = { ALLOWED, CANDIDATE, findEmoji };
