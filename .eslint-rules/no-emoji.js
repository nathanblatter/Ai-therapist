'use strict';
// no-emoji: flag emoji in string literals, template literals and JSX text.
// Project rule (CLAUDE.md): no emojis anywhere in participant/admin UI, toasts
// or server-sent strings; use react-feather icons instead. Typographic marks
// are allowed; the shared definition lives in ./emoji-pattern.js. Docs and
// HTML are covered separately by `npm run lint:emoji`.
const { findEmoji } = require('./emoji-pattern.js');

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'disallow emoji in string literals, template literals and JSX text' },
    schema: [],
    messages: {
      emoji:
        'Emoji {{label}} ("{{char}}") is not allowed (CLAUDE.md: no emojis; use react-feather icons or plain words).',
    },
  },
  create(context) {
    function check(node, text) {
      if (typeof text !== 'string' || !text) return;
      for (const hit of findEmoji(text)) {
        context.report({ node, messageId: 'emoji', data: { label: hit.label, char: hit.char } });
      }
    }
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};
