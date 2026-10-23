// The privacy guarantee of the worksheet review loop (ai-therapist-89): a
// promoted template never carries a participant's answers.
import { describe, it, expect } from 'vitest';
import { buildWorksheetTemplate, findParticipantContent, MIN_ANSWER_CHARS, SHINGLE_WORDS } from './worksheetTemplate.js';
import type { WorksheetSection } from '../db/worksheets.queries.js';

const SECTIONS: WorksheetSection[] = [
  { type: 'textarea', label: 'What happened when your manager criticized the report?', placeholder: 'Describe the moment' },
  { type: 'textarea', label: 'What evidence supports the thought?' },
  { type: 'scale', label: 'How strongly do you believe it now?' },
];

const RESPONSES = {
  'What happened when your manager criticized the report?': 'My manager Priya said the Q3 report was sloppy in front of the whole team on Tuesday.',
  'What evidence supports the thought?': 'I missed two deadlines last month and my sister says I am lazy.',
  'How strongly do you believe it now?': '70',
};

describe('buildWorksheetTemplate', () => {
  const template = buildWorksheetTemplate({
    title: 'Evidence list for the report criticism',
    sections: SECTIONS,
    template_title: 'Evidence list',
    template_rationale: 'A CBT evidence-for-and-against exercise.',
  });

  it('keeps the structure: title, numbered typed prompts, placeholders, rationale', () => {
    expect(template.title).toBe('Evidence list for the report criticism');
    expect(template.content).toContain('Derived from vetted template: Evidence list');
    expect(template.content).toContain('Sections (3):');
    expect(template.content).toContain('1. [textarea] What happened when your manager criticized the report?');
    expect(template.content).toContain('   Example: Describe the moment');
    expect(template.content).toContain('3. [scale] How strongly do you believe it now?');
    expect(template.content).toContain('Rationale: A CBT evidence-for-and-against exercise.');
  });

  it('never reads responses or the personalized intro: the source type has no such fields', () => {
    // Belt and braces for the type-level guarantee: feeding an object that
    // also carries responses/intro changes nothing in the output.
    const withExtras = buildWorksheetTemplate({
      title: 'Evidence list', sections: SECTIONS, template_title: null, template_rationale: null,
      ...({ responses: RESPONSES, intro: 'After what you told me about Priya and the report' } as object),
    });
    expect(withExtras.content).not.toContain('Priya');
    expect(withExtras.content).not.toContain('lazy');
    expect(withExtras.content).not.toContain('After what you told me');
    for (const answer of Object.values(RESPONSES)) {
      if (answer.length >= MIN_ANSWER_CHARS) expect(withExtras.content).not.toContain(answer);
    }
    expect(findParticipantContent(withExtras.content, RESPONSES)).toBeNull();
  });

  it('omits the derived-from line when the template title equals the instance title, and the rationale when absent', () => {
    const t = buildWorksheetTemplate({ title: 'Evidence list', sections: SECTIONS, template_title: 'Evidence list', template_rationale: null });
    expect(t.content).not.toContain('Derived from');
    expect(t.content).not.toContain('Rationale:');
  });
});

describe('findParticipantContent', () => {
  it('passes a clean template', () => {
    expect(findParticipantContent('1. [textarea] What happened?\n2. [scale] How strongly?', RESPONSES)).toBeNull();
    expect(findParticipantContent('anything', null)).toBeNull();
  });

  it('catches a whole answer pasted in, ignoring case, punctuation and spacing', () => {
    const text = `Prompt:   my MANAGER priya said the q3 report was sloppy, in front of the whole team on tuesday`;
    expect(findParticipantContent(text, RESPONSES)).toEqual({ key: 'What happened when your manager criticized the report?' });
  });

  it('catches a fragment of an answer (a run of consecutive words)', () => {
    const words = 'I missed two deadlines last month and'.split(' ');
    expect(words.length).toBeGreaterThanOrEqual(SHINGLE_WORDS);
    expect(findParticipantContent(`Example: ${words.join(' ')} ...`, RESPONSES)).toEqual({ key: 'What evidence supports the thought?' });
  });

  it('does not flag a short run that is ordinary template wording', () => {
    expect(findParticipantContent('What evidence supports the thought? Think of the whole team.', RESPONSES)).toBeNull();
  });

  it('ignores short answers (scale values, yes/no) that carry no participant signal', () => {
    expect(findParticipantContent('Rate from 0 to 100; many people start at 70.', RESPONSES)).toBeNull();
    expect(findParticipantContent('yes', { q: 'yes' })).toBeNull();
  });

  it('ignores non-string response values', () => {
    expect(findParticipantContent('seventy two things', { q: 72, r: null, s: ['seventy two things'] })).toBeNull();
  });
});
