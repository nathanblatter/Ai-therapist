import { describe, it, expect } from 'vitest';
import { crisisTextLinePhrase, crisisTextLineWords, DEFAULT_CRISIS_CONTACT, openingPreamble } from './openingPrompt.js';
import { buildCrisisText } from '../server/utils/sessionHelpers.js';
import { buildGrokCrisisPhrase } from '../server/utils/grokVoiceConfig.js';
import { buildDatabaseRetryMessage } from '../server/utils/databaseRetryMessage.js';
import { crisisResourcesSentence } from '../server/utils/sessionLimitRefusal.js';
import { recoveryCrisisLinePhrase } from './recoveryPrompt.js';

// system_config.crisis_contact.text is stored two ways: "HOME to 741741"
// (migration 090) and "Text HOME to 741741" (the fallback defaults, older
// rows). Each renderer used to assume one of them, so the other form came out
// as "text Text HOME to 741741" (opening disclaimer, system prompt) or
// "hOME to 741741" (limit refusals, the database retry message).
const STORED = [
  'HOME to 741741',
  'Text HOME to 741741',
  'text HOME to 741741',
  ' TEXT   HOME to 741741 ',
  'Text: HOME to 741741',
];

describe('crisisTextLineWords', () => {
  it.each(STORED)('%j becomes the words after "text"', (text) => {
    expect(crisisTextLineWords(text)).toBe('HOME to 741741');
  });

  it('leaves a keyword that merely starts with the letters "text" alone', () => {
    expect(crisisTextLineWords('TEXTLINE to 12345')).toBe('TEXTLINE to 12345');
  });

  it('is empty for an unset value, and the phrase is then empty too', () => {
    for (const v of [undefined, null, '', '   ', 'Text', ' text: ']) {
      expect(crisisTextLineWords(v)).toBe('');
      expect(crisisTextLinePhrase(v)).toBe('');
    }
  });
});

describe('every participant-facing sentence writes the text line once, correctly cased', () => {
  const contact = (text: string) => ({ hotline: '988 Suicide & Crisis Lifeline', phone: '988', text, enabled: true });

  it.each(STORED)('stored as %j', (text) => {
    const c = contact(text);
    const rendered = [
      openingPreamble(c),
      buildCrisisText(c),
      buildGrokCrisisPhrase(c),
      buildDatabaseRetryMessage(c),
      crisisResourcesSentence({ hotline: c.hotline, phone: c.phone, text }),
      recoveryCrisisLinePhrase(c),
    ];
    for (const sentence of rendered) {
      expect(sentence).toContain('text HOME to 741741');
      expect(sentence).not.toMatch(/text\s+text/i);
      expect(sentence).not.toContain('hOME');
    }
  });

  it('the shared default contact renders the same way', () => {
    expect(openingPreamble(DEFAULT_CRISIS_CONTACT)).toContain('crisis line at 988 or text HOME to 741741');
    expect(openingPreamble(DEFAULT_CRISIS_CONTACT)).not.toMatch(/text\s+text/i);
  });
});
