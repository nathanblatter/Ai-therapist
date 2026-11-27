// A deterministic second signal for the redaction leak-check (ai-therapist-409).
//
// The redaction prompt lists the 18 Safe Harbor identifiers and the model
// follows it to the letter: names of schools, employers, clinics,
// congregations and teams are not on the list and were left in 95 of 105
// times (docs/redaction-shape-eval-2026-11-26.md, addendum). The model
// leak-check that runs afterwards flagged about two thirds of those.
//
// English writes names with a capital letter. So after redaction, a word that
// is capitalised in the middle of a sentence, and is not a word everybody
// capitalises (a weekday, "AI", "CBT", a crisis line), is very likely a name
// of something: a person, a school, an employer. This module finds those
// words. It changes no text and asks no model; the verifier uses it to send
// the message to a researcher for review.
//
// Deliberate limits:
//   - a name that opens a sentence is not seen (the first word of every
//     sentence is capitalised), unless it has a second capitalised word;
//   - a name typed in lower case is not seen;
//   - it is English-only.
// It is a net under the model check, not a replacement for it.
//
// Pure and shared so the review screen can mark the same words.

/** Matches one redaction placeholder, e.g. "[REDACTED: NAME]" or "[REDACTED]". */
const PLACEHOLDER_RE = /\[\s*REDACTED\b[^\]\n]{0,80}\]/gi;

/** Where a new sentence, line, quotation or list entry may start. */
const SEGMENT_BREAK_RE = /[.!?:;]+[*_'\u2019]*\s+|[\r\n]+|["“”()[\]{}]|\s[-–—•*]\s|^\s*[-•*\d.)]+\s+/gmu;

const WORD_RE = /\p{L}[\p{L}'’]*/gu;

function set(words: string): Set<string> {
  return new Set(words.split(/\s+/).filter(Boolean));
}

/** Capitalised words that are not a name of a person, place or organisation
 *  below state level. Compared in lower case. */
const ORDINARY_CAPITALISED = set(`
  i i'm i've i'd i'll
  monday tuesday wednesday thursday friday saturday sunday
  mondays tuesdays wednesdays thursdays fridays saturdays sundays
  mon tue tues wed thu thur thurs fri sat sun
  january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec
  christmas thanksgiving easter halloween hanukkah ramadan eid diwali passover lent
  god lord jesus christ christian christians christianity catholic protestant mormon mormons muslim muslims islam
  jewish judaism hindu buddhist buddhism bible quran torah heavenly father
  english spanish french german chinese japanese korean portuguese italian arabic russian latin
  american americans canadian mexican british european asian african indian native hispanic latino latina white black
  america usa canada mexico england britain europe asia africa australia china japan india germany france spain italy
  earth internet covid google youtube netflix spotify instagram facebook tiktok snapchat reddit twitter zoom
  iphone android apple microsoft amazon uber
  alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois
  indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana
  nebraska nevada hampshire jersey york carolina dakota ohio oklahoma oregon pennsylvania rhode island tennessee texas
  utah vermont virginia washington wisconsin wyoming new north south west
  suicide crisis lifeline text line national hotline helpline prevention emergency
  prozac zoloft lexapro xanax adderall ritalin wellbutrin celexa paxil effexor cymbalta klonopin ativan valium
  lithium abilify seroquel trazodone buspar vyvanse concerta tylenol advil ibuprofen benadryl melatonin
  mr mrs ms dr mom dad mum grandma grandpa
`);

/** Upper-case abbreviations that are not an organisation. Compared as written. */
const ORDINARY_ABBREVIATIONS = set(`
  AI AIs OK TV PC US USA UK ER ICU ED HR IT ID PE PTO CEO GPA SAT ACT GRE AP IB TA RA GED PhD MBA
  CBT DBT ACT EMDR ADHD ADD OCD PTSD CPTSD GAD MDD BPD PHQ SSRI SNRI IOP PCP OB DNA
  LGBT LGBTQ ASAP FYI IDK TBH LOL OMG BTW DIY AM PM AC DM PDF
  HOME START STOP
`);

/** Everyday words that get a capital for emphasis ("I am SO tired"), in a
 *  heading or after punctuation this module does not treat as a sentence
 *  break. Never counted, however they are capitalised: "BYU" counts, "NEVER"
 *  and "What" do not. "will" and "may" are left out on purpose: they are
 *  also first names. */
const EVERYDAY_WORDS = set(`
  a an the and or but so not no yes never always ever very really just too all any every none nothing everything
  one two three first last only still even again now then here there what why how who when where which
  am is are was were be been do does did have has had can could would should must might
  i me my mine you your we us our they them their he him his she her it its this that these those
  to of in on at for from with by about into over out up down off
  hate love want need feel felt tired done stop help please sorry fine okay ok good bad worst best great
  can't don't won't didn't isn't wasn't couldn't shouldn't
  vent step plan list goal note tip try yet much more most less after before today tomorrow tonight hey if
`);

/**
 * The words in `redacted` that are capitalised where ordinary writing would
 * not capitalise them, in order of first appearance, without repeats. An
 * empty list means the signal has nothing to say.
 */
export function leftoverCapitalisedWords(redacted: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const text = redacted.replace(PLACEHOLDER_RE, ' . ');
  // A message typed wholly in capitals says nothing about which words are names.
  const letters = text.replace(/[^\p{L}]/gu, '');
  const shouted = letters.length > 0 && letters === letters.toUpperCase();
  if (shouted) return found;

  for (const segment of text.split(SEGMENT_BREAK_RE)) {
    const words = segment.match(WORD_RE) ?? [];
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/['’]s$/i, '').replace(/['’]+$/, '');
      if (word.length < 2) continue;
      const first = word[0];
      if (first === first.toLowerCase()) continue;
      const lower = word.toLowerCase().replace(/’/g, "'");
      if (ORDINARY_CAPITALISED.has(lower)) continue;
      if (ORDINARY_ABBREVIATIONS.has(word) || EVERYDAY_WORDS.has(lower)) continue;
      if (!seen.has(word)) {
        seen.add(word);
        found.push(word);
      }
    }
  }
  return found;
}
