// What the stage-1 screens match, and just as much what they must not.
//
// Found by the first detector goldens baseline (evals/goldens, 2026-11-18):
//  - the keyword tiers matched one inflection of each phrase, so "I think I
//    overdosed" and "thinking about killing myself" matched nothing and the
//    assessor never ran;
//  - shorthand and euphemism ("kms", "ctb", "sewerslide", "I want out. Like
//    out out.", "Life isn't worth it.") matched nothing;
//  - someone else's suicidal statement ("she's going to kill herself tonight")
//    matched nothing, so the owner's decision that it pages (ai-therapist-326)
//    could not take effect whatever the assessor's rubric said;
//  - the reply to an assistant safety question ("yeah. kind of. most nights.")
//    carries no word of its own.
//
// Pure functions only; no OpenAI, no database.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));

const { detectCrisisKeywords, detectContextSignals, keywordPattern, asksSafetyQuestion, repliesToSafetyQuestion } =
  await import('./crisisDetection.service.js');

const score = (text: string) => detectCrisisKeywords(text).keywordScore;
const kinds = (text: string) => detectContextSignals(text).map((s) => s.kind);
/** Matched by neither screen: in a calm session the turn costs nothing. */
const untouched = (text: string) => score(text) === 0 && detectContextSignals(text).length === 0;

describe('keyword tiers match every form of a phrase, not one', () => {
  it.each([
    ['I think I overdosed a little while ago and I am scared.', 'overdose'],
    ['I keep thinking about overdosing', 'overdose'],
    ["i think i od'd", 'overdose'],
    ["I'm thinking about killing myself.", 'kill myself'],
    ['i almost killed myself last year', 'kill myself'],
    ["I've been thinking about ending my life a lot lately.", 'end my life'],
    ['I keep thinking about taking my own life', 'take my own life'],
    ['part of me wants to die', 'want to die'],
    ['I wanted to die', 'want to die'],
    ['i keep wishing i was dead', 'wish i was dead'],
    ["I've been hurting myself again", 'hurt myself'],
    ['I started cutting myself again', 'cut myself'],
    ['i have been self-harming', 'self-harm'],
    ['i was self harming all week', 'self harm'],
    ['honestly thinking about ending it all', 'end it all'],
  ])('high tier: %s', (text, keyword) => {
    const found = detectCrisisKeywords(text);
    expect(found.keywordScore, text).toBe(75);
    // The reported keyword is the base phrase, so the audit trail is unchanged.
    expect(found.keywords, text).toContain(keyword);
  });

  it.each([
    ["part of me doesn't want to be here anymore", "don't want to be here"],
    ["I didn't want to be alive", "don't want to be alive"],
    ["I couldn't go on", "can't go on"],
    ['I have given up on life', 'give up on life'],
    ['i keep wanting to disappear', 'want to disappear'],
  ])('passive tier: %s', (text, keyword) => {
    const found = detectCrisisKeywords(text);
    expect(found.keywordScore, text).toBe(50);
    expect(found.keywords, text).toContain(keyword);
  });

  it('tolerates the adverbs people put in the middle of a phrase', () => {
    // The check-in text of the OPEN-03 scenario; it matched nothing.
    expect(score("I don't really want to be alive")).toBe(50);
    expect(score("i don't even want to be here anymore")).toBe(50);
    expect(score('I just want to literally die')).toBe(75);
    expect(score('I want to just end it all')).toBe(75);
    expect(score('sometimes i kind of wish i was dead')).toBe(75);
    // Only fillers: a word that changes the meaning does not match.
    expect(score("I don't want you to be here")).toBe(0);
    expect(score('I want to see the Dead Sea')).toBe(0);
    expect(score('I want my fish to not die')).toBe(0);
  });

  it('still matches the base forms and tolerates extra whitespace', () => {
    expect(score('I want to kill myself')).toBe(75);
    expect(score('i want to kill  myself')).toBe(75);
    expect(score("I don't want to be here")).toBe(50);
  });

  it('does not inflect pronouns: someone else is a different statement and never a tier score', () => {
    expect(score('The character kills himself at the end of the film.')).toBe(0);
    expect(score('She told me she wants to kill herself.')).toBe(0);
  });

  it('must not fire: look-alike words and bare shorthand', () => {
    for (const text of [
      'That was an odd thing to say.',
      'The odds are against me this semester.',
      'My skill set is not great.',
      'I killed it at the recital.',
      'The weekend ended too fast.',
      'I took my own advice for once.',
      'We wanted to diet together.',
      'I cut my hair myself.',
      "It's the end of my lifeguard shift.",
    ]) {
      expect(score(text), text).toBe(0);
    }
  });

  it('keywordPattern is whole-word and inflects only the listed words', () => {
    expect(keywordPattern('kill myself').test('killing myself')).toBe(true);
    expect(keywordPattern('kill myself').test('skill myself')).toBe(false);
    expect(keywordPattern('overdose').test('overdosed')).toBe(true);
    expect(keywordPattern('suicide').test('suicides')).toBe(false);
  });
});

describe('algospeak with no everyday meaning is a keyword', () => {
  it.each([
    'been thinking about sewerslide a lot',
    'thinking about sewer slide',
    'i want to unalive myself',
    'i keep thinking about unaliving myself',
  ])('%s', (text) => {
    expect(score(text), text).toBe(75);
  });
});

describe('"Life isn\'t worth it" is passive ideation', () => {
  it.each(["Life isn't worth it.", 'life is not worth it anymore', 'honestly life just isnt worth the effort'])(
    '%s',
    (text) => {
      expect(score(text), text).toBe(50);
    },
  );

  it('only with life as the subject', () => {
    for (const text of [
      "This class isn't worth it.",
      "The gym membership isn't worth it.",
      'Is it worth it to retake the exam?',
      'Life is worth it, I know that.',
    ]) {
      expect(score(text), text).toBe(0);
    }
  });
});

describe('shorthand with other meanings only wakes the assessor (never a score)', () => {
  it.each([
    ['kms', 'slang'],
    ['honestly i just want to kms', 'slang'],
    ['been thinking about ctb a lot lately', 'slang'],
    ['thinking about unaliving', 'slang'],
    ['sometimes i think i should just off myself', 'slang'],
    ['I want out. Like out out. Of everything.', 'slang'],
    ["i want out i can't do this anymore", 'slang'],
    ['I just need a way out', 'slang'],
  ])('%s', (text, kind) => {
    expect(score(text), text).toBe(0);
    expect(kinds(text), text).toContain(kind);
    expect(detectContextSignals(text).every((s) => s.kind !== 'slang' || s.strong === false)).toBe(true);
  });

  it('an unrelated "CTB" or "kms" is sent to the assessor, not scored: the screen alone can never flag it', () => {
    // The assessor reads these in context. What the screen guarantees is that
    // they carry no score of their own, so with the assessor down they are 0.
    for (const text of ['Our CTB meeting got moved to Friday.', 'the kms key rotation broke the deploy']) {
      expect(score(text), text).toBe(0);
      expect(detectContextSignals(text).every((s) => !s.strong)).toBe(true);
    }
  });

  it('must not fire: distances, prepositions and ordinary sentences', () => {
    for (const text of [
      'I ran 5 kms this morning.',
      'It is about 12kms from campus.',
      'I need to get this weight off myself.',
      'I want to get out of the house more.',
      'I want outdoor time this weekend.',
      'We wanted out-of-state tuition waived.',
      'I have to catch the bus at 5.',
      'I offered myself as a tutor.',
    ]) {
      expect(untouched(text), text).toBe(true);
    }
  });
});

describe("someone else's suicidal statement wakes the assessor (never a score)", () => {
  it.each([
    "My roommate just texted me that she's going to kill herself tonight. I don't know what to do.",
    'My best friend told me he has a plan to end his life this weekend.',
    'My roommate told me last night she wants to kill herself. What do I do?',
    'My mom has depression and some days she says she wishes she was not here. I worry about her.',
    'My brother keeps saying he wishes he was dead.',
    'She said everyone would be better off without her.',
    'My roommate keeps saying she wishes she could disappear, and yesterday she gave me all her plants.',
    'I think he is going to hurt himself.',
    'They tried to take their own life last night.',
  ])('%s', (text) => {
    expect(score(text), text).toBe(0);
    expect(kinds(text), text).toContain('third_party');
    expect(detectContextSignals(text).some((s) => s.kind === 'third_party' && s.strong)).toBe(false);
  });

  it('"wants to die" and "doesn\'t want to be alive" reach the assessor through the keyword tiers', () => {
    // The verb forms that make "part of me wants to die" match are the same
    // words in the third person. The assessor files these as bystander.
    expect(score('My brother keeps saying he wants to die.')).toBe(75);
    expect(score("My boyfriend said he doesn't want to be alive anymore and he's not picking up.")).toBe(50);
  });

  it('a film, a song or the news wakes the assessor too, which is why this is never a score', () => {
    const text = 'In the movie the main character kills himself at the end.';
    expect(score(text)).toBe(0);
    expect(kinds(text)).toContain('third_party');
  });

  it('must not fire: ordinary worry and ordinary third-person sentences', () => {
    for (const text of [
      'My friend has been really down lately.',
      'My roommate is stressed about finals and I am worried about her.',
      'She wants to diet with me.',
      'He ended his lease early.',
      'They took their time.',
      'She cut her hair herself.',
      'He has a plan to study abroad.',
    ]) {
      expect(untouched(text), text).toBe(true);
    }
  });
});

describe('the assistant asking about safety', () => {
  it.each([
    'Thank you for telling me. Are you having thoughts of ending your life?',
    'Have you been having any thoughts of suicide?',
    'Do you ever have thoughts of not wanting to be alive?',
    'Sometimes when people feel this low they think about hurting themselves or killing themselves. Have you thought about killing yourself?',
    'I want to check: are you safe right now?',
    'Do you feel safe tonight?',
    'When you say that, do you mean you wish you were dead?',
    'Have you had thoughts about dying?',
    'Have you thought about harming yourself?',
  ])('is a safety question: %s', (text) => {
    expect(asksSafetyQuestion(text), text).toBe(true);
  });

  it.each([
    'What would you like to focus on today?',
    'That sounds exhausting. How did the exam go?',
    'You can call or text 988 at any time. It is the Suicide and Crisis Lifeline.',
    'How long have you been feeling this way?',
    'Is it safe to say the group project is the main stress?',
    '',
  ])('is not: %s', (text) => {
    expect(asksSafetyQuestion(text), text).toBe(false);
  });

  it('repliesToSafetyQuestion looks at the last assistant turn before the reply', () => {
    const question = { role: 'assistant', content: 'Do you ever have thoughts of not wanting to be alive?' };
    const reply = { role: 'user', content: 'yeah. kind of. most nights.' };
    expect(repliesToSafetyQuestion([{ role: 'user', content: 'hi' }, question, reply])).toBe(true);
    // The reply arriving in two parts (voice) is still a reply to it.
    expect(repliesToSafetyQuestion([question, { role: 'user', content: 'yeah.' }, reply])).toBe(true);
    // An earlier safety question that the assistant has since moved on from is not.
    expect(
      repliesToSafetyQuestion([
        question,
        { role: 'user', content: 'no' },
        { role: 'assistant', content: 'Okay. What would help most today?' },
        { role: 'user', content: 'yeah, the essay' },
      ]),
    ).toBe(false);
    expect(repliesToSafetyQuestion([reply])).toBe(false);
    expect(repliesToSafetyQuestion([])).toBe(false);
  });

  it('reads the redacted text when the original has been wiped', () => {
    expect(
      repliesToSafetyQuestion([
        { role: 'assistant', content: null, content_redacted: 'Are you thinking about suicide?' },
        { role: 'user', content: 'sometimes' },
      ]),
    ).toBe(true);
  });
});

// Owner decision 2026-11-18 (ai-therapist-330): credible thoughts of harming
// another person are detected on every path and staff are notified. The
// keyword tiers are about self-harm, so on the realtime path these turns were
// never assessed ("I keep picturing hurting him. I know where he parks."
// scored 0). The screen only wakes the assessor: the idiom has the same words.
describe('thoughts of harming another person wake the assessor (never a score)', () => {
  it.each([
    'I keep picturing hurting him. I know where he parks.',
    "My roommate is going to get what's coming to him. I've thought about exactly what I'd do.",
    "I've been having thoughts about hurting my baby sister and it scares me. I would never do it.",
    'I want to hurt him the way he hurt me',
    'honestly i think about killing my stepdad every single day',
    "I'm going to make her pay for what she did",
    'I know where she lives and she is going to regret it',
    // The idiom is sent to the assessor too: only context tells it apart.
    "I swear I'm going to kill my lab partner, he did nothing all semester.",
  ])('%s', (text) => {
    expect(score(text), text).toBe(0);
    expect(kinds(text), text).toContain('harm_others');
    expect(detectContextSignals(text).some((s) => s.kind === 'harm_others' && s.strong)).toBe(false);
  });

  it('must not fire: objects that are not people, and ordinary anger', () => {
    for (const text of [
      'I hurt my back moving the couch.',
      'That class is going to kill my GPA.',
      'This heat is killing my appetite.',
      'I want to beat my record on the 5k.',
      "I'm going to shoot my shot and ask her out.",
      "I'm so mad at my ex I could scream.",
      'I punched my pillow, it helped a little.',
      'She really hurt my feelings.',
      'I attacked the problem set all night.',
      "I'm going to murder this exam.",
    ]) {
      expect(untouched(text), text).toBe(true);
    }
  });

  it('thoughts of hurting MYSELF are the self-harm keyword, not this signal', () => {
    expect(score('I keep thinking about hurting myself')).toBe(75);
    expect(kinds('thoughts of hurting my self')).not.toContain('harm_others');
  });
});
