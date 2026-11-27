import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leftoverCapitalisedWords } from './leftoverNames';

describe('leftoverCapitalisedWords', () => {
  it('finds a school, an employer and a person left in the middle of a sentence', () => {
    expect(leftoverCapitalisedWords('I teach sophomore English at Lone Peak High School.')).toEqual([
      'Lone',
      'Peak',
      'High',
      'School',
    ]);
    expect(leftoverCapitalisedWords('I graduated from Skyridge and I still feel invisible.')).toEqual(['Skyridge']);
    expect(leftoverCapitalisedWords("my shift at Trader Joe's ended and Bruce drove me home")).toEqual([
      'Trader',
      'Joe',
      'Bruce',
    ]);
  });

  it('counts an abbreviation that could be an organisation, and not clinical or everyday ones', () => {
    expect(leftoverCapitalisedWords('I got into BYU but my ADHD and my GPA worry me, and CBT helped.')).toEqual([
      'BYU',
    ]);
  });

  it('says nothing about a correctly redacted message', () => {
    expect(
      leftoverCapitalisedWords(
        'I saw [REDACTED: NAME] at the clinic on Friday. My number is [REDACTED: TELEPHONE NUMBER] and I live in [REDACTED: LOCATION].',
      ),
    ).toEqual([]);
  });

  it('ignores the first word of a sentence, a line, a quotation and a list entry', () => {
    const text = [
      'Tonight was hard. Everything feels heavy! Maybe tomorrow is better? Hopefully.',
      'Options:',
      '1) Sleep early',
      '- Call someone',
      '**Breathing:** Inhale slowly',
      'She said “Stop doing that” and left (Nobody noticed).',
    ].join('\n');
    expect(leftoverCapitalisedWords(text)).toEqual([]);
  });

  it('ignores weekdays, months, emphasis, crisis lines, medicines, states and the pronoun I', () => {
    expect(
      leftoverCapitalisedWords(
        "on Monday in March I'm SO tired and I NEVER sleep, my Prozac ran out, I moved from Utah, call the Suicide and Crisis Lifeline or text HOME",
      ),
    ).toEqual([]);
  });

  it('says nothing about a message typed wholly in capitals', () => {
    expect(leftoverCapitalisedWords('I HATE MY JOB AT QUALTRICS AND I HATE MONDAYS')).toEqual([]);
  });

  it('lists each word once, in order of first appearance', () => {
    expect(leftoverCapitalisedWords('I asked Emma, then Emma asked Sam, and Sam said no')).toEqual(['Emma', 'Sam']);
  });

  it('keeps Will as a name', () => {
    expect(leftoverCapitalisedWords('my brother Will moved out')).toEqual(['Will']);
  });

  it('does not see a name that opens a sentence or is typed in lower case (documented limits)', () => {
    expect(leftoverCapitalisedWords('Skyridge was the worst four years of my life.')).toEqual([]);
    expect(leftoverCapitalisedWords('i hated skyridge')).toEqual([]);
  });

  // The fixture is 50 invented messages, 40 of them naming one place or
  // organisation that the redaction wording does not list. Run on the RAW
  // text (the worst case: redaction returned the message word for word, which
  // is what a survivor was in every measured case), the signal must see every
  // one of those names and stay silent on the messages with nothing in them.
  it('sees the identifier in every place and organisation message of the eval fixture', () => {
    const rows = readFileSync('evals/goldens/redaction-place-org.jsonl', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string; class: string; text: string; match: string[] });
    const missed = rows
      .filter((r) => !r.class.startsWith('control'))
      .filter((r) => leftoverCapitalisedWords(r.text).length === 0)
      .map((r) => r.id);
    expect(missed).toEqual([]);
    const noisy = rows
      .filter((r) => r.class === 'control-none')
      .filter((r) => leftoverCapitalisedWords(r.text).length > 0)
      .map((r) => r.id);
    expect(noisy).toEqual([]);
  });
});
