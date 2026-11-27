// A deterministic "is any of this not English?" screen for the crisis detector
// (ai-therapist-329, docs/decisions-crisis-classifiers-2026-11-26.md).
//
// The detector's first stage is a list of ENGLISH crisis keywords, and that
// stage decides whether the LLM assessor reads a turn at all. A disclosure in
// Spanish, or an English sentence that switches to Spanish for the hard part,
// matches nothing: it reached the assessor only when the moderation screen
// happened to score it. This screen closes that hole the cheapest way there
// is. It never scores and never lowers anything: a match does exactly one
// thing, it sends the turn to the same assessor every keyword turn goes to.
//
// It is a regex and two word lists on purpose. It runs on every participant
// turn, on the path that pages a person, so it must not wait on a vendor, cost
// money or be able to fail. The price of being crude is false wakes ("my
// fiancée", "José"): one assessor call for a turn that then scores 0.
//
// Three signals, any one of which is a match:
//   1. a letter outside ASCII (á, ñ, ç, ü, and every non-Latin script);
//   2. one crisis word in Spanish, Portuguese, French, German or Italian
//      ("matarme", "morir", and any inflection of a few stems: "cortar...",
//      "suicid..." other than the English forms);
//   3. one common word from those languages that English does not have
//      ("pero", "estoy", "ich", "je"), or three of the short ones English
//      shares ("y", "ya", "se", "la"). One word is enough on purpose: people
//      who switch languages for the hard part often switch for only a clause
//      ("...but me volvi a cortar anoche"), and a borrowed "nada" or "amigos"
//      in an English sentence costs one assessor call.
//
// Not covered, and said so in the doc: a language written in ASCII letters
// whose words are in none of the lists (Dutch, Tagalog, romanised Hindi...).
// The moderation wake and the periodic sweep still apply to those, as before.
//
// No imports: no database, no config, no pipeline.

/** A letter (any script) outside ASCII: a letter that is not one of the
 *  printable ASCII characters. Punctuation, digits, typographic quotes and
 *  symbols are not letters. */
const NON_ASCII_LETTER = /(?![ -~])\p{L}/u;

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

/** Any ONE of these wakes the assessor. Written without accents (the text is
 *  folded before matching). None is an English word. */
const CRISIS_WORDS = words(`
  matarme matarte matarse mataria mato suicidio suicidarme suicidarse suicido suicidar
  morir morirme morirse muero muerte muerta muerto quitarme ahorcarme cortarme lastimarme
  pastillas desaparecer despedirme despedi
  matar morrer morte matarei
  mourir tuer suicider
  sterben umbringen selbstmord suizid
  morire uccidermi ammazzarmi
`);

/** Any word that STARTS with one of these is a crisis word too (verb forms). */
const CRISIS_PREFIXES = [
  'matar',
  'morir',
  'muer',
  'morrer',
  'cortar',
  'cortand',
  'lastim',
  'ahorc',
  'desaparec',
  'despedi',
  'pastilla',
  'umbring',
  'uccid',
  'ammazz',
];
/** "suicidio", "suicidarme", "suicidas", "suicídio"...: every form except English's own. */
const SUICID_NOT_ENGLISH = /^suicid(?!e$|es$|al$|ally$|ality$)/;

function isCrisisWord(word: string): boolean {
  return CRISIS_WORDS.has(word) || SUICID_NOT_ENGLISH.test(word) || CRISIS_PREFIXES.some((p) => word.startsWith(p));
}

/** Words English does not have (it borrows a few: "nada", "amigos"). */
const STRONG_WORDS = words(`
  que pero porque estoy tengo quiero muy cuando nada nadie siempre nunca hoy una esto eso
  bien aqui ahora noche mejor puedo hacer vivir seguir vida verdad voy tambien mucho mucha
  pues donde quien tiene tienes estar estas eres fue hace dijo casa dia dias gente cosas cada otra otro
  hasta desde aunque mientras ustedes nosotros ellos mis tus tu pienso siento cansada cansado todos
  sobre entre nos ese estos otros otras tanto muchos poco cual estamos estan hemos somos ser
  tenemos tienen fui antes despues entonces ademas todavia tampoco ayer manana semana tiempo mundo
  amigos amiga hermano hermana hijos hija hijo abuela abuelo escuela trabajo jaja jajaja ahorita
  quieres quiere vez veces ando estaba estuve estado bueno buena triste sola ganas dormir despertar sentir
  pensar decir digo creo sabes sabe puede puedes tener hago haces vamos viene vengo llevo sigo duele
  llorar lloro miedo carga cansancio harta harto aguanto aguantar sentido razon ojala quisiera
  gustaria peor xq pq porq tmb
  nao voce estou tenho quero muito quando ninguem sempre hoje isso sou tudo bem agora noite melhor
  posso fazer viver mais meu minha meus vou penso
  pra tbm mto obrigado obrigada tambem ainda depois ontem amanha trabalho escola sozinho sozinha
  vontade acordar acho sei quer pode sao estao estava foi ter aguento consigo sumir embora kkk kkkk
  je suis veux avec rien jamais toujours envie nuit vais mes
  ich nicht und mehr leben heute nacht kann habe keine immer wieder mein meine
  voglio sono niente oggi notte vivere
`);

/** Short words that also turn up in English text (names, places, borrowed
 *  phrases, slang: "pro and con", "see ya", "soy milk", "Ella", "my ESA",
 *  "this sem"). One or two of them say nothing; three do. */
const WEAK_WORDS = words(`
  el la de en es un se lo le te y los las al del por con para como este esta sus mas si ni su
  ya yo soy hay ella algo todo uno ti era han ante culpa q familia solo mama papa amigo
  com um os na em eu uma vc ta tem tb tempo
  les esa sem moi mich mir ist
  est et les des ne pas tout
  das der
  non
`);

export type NonEnglishSignal = 'non_ascii_letter' | 'crisis_word' | 'function_words';

export interface NonEnglishScreen {
  nonEnglish: boolean;
  /** Which of the three signals matched, from a fixed vocabulary (safe to
   *  store: never message text). */
  signals: NonEnglishSignal[];
}

/** Lower case, accents removed, split into words of letters. */
function foldedWords(content: string): string[] {
  return content
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

/**
 * Is any part of this message written in a language other than English, as
 * far as a word list can tell? Never throws; empty text is English.
 */
export function detectNonEnglish(content: string | null | undefined): NonEnglishScreen {
  const signals: NonEnglishSignal[] = [];
  if (!content) return { nonEnglish: false, signals };
  if (NON_ASCII_LETTER.test(content.normalize('NFC'))) signals.push('non_ascii_letter');
  const seen = new Set(foldedWords(content));
  let strong = 0;
  let weak = 0;
  let crisis = false;
  for (const word of seen) {
    if (isCrisisWord(word)) crisis = true;
    if (STRONG_WORDS.has(word)) strong++;
    else if (WEAK_WORDS.has(word)) weak++;
  }
  if (crisis) signals.push('crisis_word');
  if (strong >= 1 || weak >= 3) signals.push('function_words');
  return { nonEnglish: signals.length > 0, signals };
}
