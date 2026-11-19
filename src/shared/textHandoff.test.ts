import { describe, it, expect } from 'vitest';
import {
  HANDOFF_CEILING_FIRST_MESSAGE,
  HANDOFF_CRISIS_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE,
  HANDOFF_QUICK_REPLIES,
  handoffFailedSpokenLine,
  handoffFirstMessage,
  handoffKind,
  handoffQuickReplies,
  handoffSpokenBridge,
  handoffStampSeverity,
  voiceReturnAllowed,
  type HandoffKind,
  type HandoffReason,
  type HandoffSeverity,
} from './textHandoff.js';

// Wording and routing of the text hand-off (ai-therapist-356): what the
// participant reads, hears and is offered when the voice vendor ends a call.

// The study answers "no" to deception: nothing may say a connection failed.
const DECEPTIVE =
  /connection|dropped|got cut off|was cut off|cut us off|technical|glitch|signal|network|lost (the )?call|disconnect/i;
// Nothing may promise a person, or claim staff were told: neither is known to
// be true when these lines are written.
const PROMISES_PEOPLE =
  /someone (will|is going to)|a (person|human|counselor|researcher|member of)|on (the|their) way|been (notified|alerted|told)|we('ve| have) (notified|alerted|contacted)|will (call|contact|reach out to) you|staff|team/i;

const EVERY_LINE: Array<[string, string]> = [
  ['crisis first message', HANDOFF_CRISIS_FIRST_MESSAGE],
  ['ceiling first message', HANDOFF_CEILING_FIRST_MESSAGE],
  ['neutral first message', HANDOFF_NEUTRAL_FIRST_MESSAGE],
  ['neutral first message without the voice offer', HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE],
  ['crisis spoken bridge', handoffSpokenBridge('crisis')],
  ['ceiling spoken bridge', handoffSpokenBridge('ceiling')],
  ['neutral spoken bridge', handoffSpokenBridge('neutral')],
  ['failed spoken line', handoffFailedSpokenLine()],
];

describe('hand-off wording', () => {
  it('the crisis first message is the wording the study owner reviewed', () => {
    expect(HANDOFF_CRISIS_FIRST_MESSAGE).toBe(
      "I'm still here, and I heard you. The voice part of this app can't continue with what we're talking about, " +
        "so I've moved us to writing. Nothing you said was wrong. Are you thinking about ending your life tonight?",
    );
  });

  it.each(EVERY_LINE)('%s never blames a connection or says the call got cut off', (_name, line) => {
    expect(line).not.toMatch(DECEPTIVE);
  });

  it.each(EVERY_LINE)('%s promises no person and claims no notification', (_name, line) => {
    expect(line).not.toMatch(PROMISES_PEOPLE);
  });

  it('only the crisis first message asks about suicide', () => {
    expect(HANDOFF_CRISIS_FIRST_MESSAGE).toMatch(/ending your life/);
    for (const line of [
      HANDOFF_CEILING_FIRST_MESSAGE,
      HANDOFF_NEUTRAL_FIRST_MESSAGE,
      HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE,
    ]) {
      expect(line).not.toMatch(/suicid|ending your life|kill|hurt yourself/i);
    }
  });

  it('every first message says the conversation continues in writing', () => {
    for (const kind of ['crisis', 'ceiling', 'neutral'] as HandoffKind[]) {
      expect(handoffFirstMessage(kind, false)).toMatch(/writing/);
      expect(handoffFirstMessage(kind, true)).toMatch(/writing/);
    }
  });

  it('the neutral message offers a new voice call only when one may be started', () => {
    expect(handoffFirstMessage('neutral', true)).toMatch(/start a new voice call/);
    expect(handoffFirstMessage('neutral', false)).not.toMatch(/new voice call/);
    // A crisis or ceiling message never offers voice, whatever is passed.
    expect(handoffFirstMessage('crisis', true)).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
    expect(handoffFirstMessage('ceiling', true)).toBe(HANDOFF_CEILING_FIRST_MESSAGE);
  });

  it('the ceiling message names the time limit, not the conversation', () => {
    expect(HANDOFF_CEILING_FIRST_MESSAGE).toMatch(/time limit/);
    expect(HANDOFF_CEILING_FIRST_MESSAGE).not.toMatch(/can't continue with what we're talking about/);
  });

  it('quick replies are offered for the suicide question only', () => {
    expect(handoffQuickReplies('crisis')).toEqual(['Yes', 'No', 'Not sure']);
    expect(handoffQuickReplies('ceiling')).toEqual([]);
    expect(handoffQuickReplies('neutral')).toEqual([]);
    // A copy, not the constant: callers may not mutate the shared list.
    expect(handoffQuickReplies('crisis')).not.toBe(HANDOFF_QUICK_REPLIES);
  });

  it('the spoken bridge after a crisis cut says where the conversation went and names the number', () => {
    for (const kind of ['crisis', 'ceiling'] as HandoffKind[]) {
      const line = handoffSpokenBridge(kind);
      expect(line).toMatch(/writing/);
      expect(line).toMatch(/your screen/);
      expect(line).toMatch(/call or text 988/);
    }
    expect(handoffSpokenBridge('crisis', { phone: '555-0100', enabled: true })).toMatch(/call or text 555-0100/);
    // A disabled or blank contact falls back to the national line.
    expect(handoffSpokenBridge('crisis', { phone: '555-0100', enabled: false })).toMatch(/call or text 988/);
    expect(handoffSpokenBridge('crisis', { phone: '  ' })).toMatch(/call or text 988/);
  });

  it('the neutral spoken bridge does not bring up a crisis line', () => {
    expect(handoffSpokenBridge('neutral')).not.toMatch(/988|crisis/i);
    expect(handoffSpokenBridge('neutral')).toMatch(/writing/);
  });

  it('the failed line points at the numbers on the screen', () => {
    expect(handoffFailedSpokenLine()).toMatch(/on your screen/);
    expect(handoffFailedSpokenLine()).toMatch(/call or text 988/);
  });
});

describe('handoffKind: which first screen', () => {
  const cases: Array<[HandoffReason, HandoffSeverity, HandoffKind]> = [
    // A content cut at high risk is the crisis screen.
    ['content', 'high', 'crisis'],
    // Risk that could not be read is not "no risk".
    ['content', 'unknown', 'crisis'],
    // No high signal: the filter also stops ordinary phrases.
    ['content', 'medium', 'neutral'],
    ['content', 'none', 'neutral'],
    // The vendor's session ceiling on a session flagged high.
    ['expired', 'high', 'ceiling'],
    ['expired', 'unknown', 'ceiling'],
    ['expired', 'medium', 'neutral'],
    ['expired', 'none', 'neutral'],
  ];
  it.each(cases)('%s cut, incident risk %s -> %s', (reason, severity, kind) => {
    expect(handoffKind(reason, severity)).toBe(kind);
  });
});

describe('handoffStampSeverity: what the continuation starts flagged at', () => {
  it('carries the real severity, and treats unknown as high', () => {
    expect(handoffStampSeverity('high')).toBe('high');
    expect(handoffStampSeverity('unknown')).toBe('high');
    expect(handoffStampSeverity('medium')).toBe('medium');
    expect(handoffStampSeverity('none')).toBeNull();
  });
});

describe('voiceReturnAllowed: when a new voice call may be offered', () => {
  const cleared = [{ step: 'ideation', risk_band: 'none' }];

  it('no risk signal anywhere: offered from the first screen', () => {
    expect(voiceReturnAllowed({ handoffSeverity: 'none', chatPeakSeverity: 'none', riskCheckSteps: [] })).toBe(true);
  });

  it('never while a turn in this chat has scored high, even with a clear risk check', () => {
    for (const handoffSeverity of ['none', 'medium', 'high', 'unknown'] as HandoffSeverity[]) {
      expect(voiceReturnAllowed({ handoffSeverity, chatPeakSeverity: 'high', riskCheckSteps: cleared })).toBe(false);
    }
  });

  it('a high or unknown incident: never, whatever the risk check in this chat says', () => {
    // The voice call it would start is unflagged and has no transcript; the
    // safety assessment stays in writing (PR #77 review, checked live).
    for (const handoffSeverity of ['high', 'unknown'] as HandoffSeverity[]) {
      for (const riskCheckSteps of [[], cleared, [{ step: 'ideation', risk_band: 'low' }]]) {
        expect(voiceReturnAllowed({ handoffSeverity, chatPeakSeverity: 'none', riskCheckSteps })).toBe(false);
      }
    }
  });

  it('a medium incident: not until the assistant has logged the ideation check', () => {
    expect(voiceReturnAllowed({ handoffSeverity: 'medium', chatPeakSeverity: 'none', riskCheckSteps: [] })).toBe(false);
    // A check that never asked about ideation is not the risk check.
    expect(
      voiceReturnAllowed({
        handoffSeverity: 'medium',
        chatPeakSeverity: 'none',
        riskCheckSteps: [{ step: 'protective_factors', risk_band: 'none' }],
      }),
    ).toBe(false);
  });

  it('the risk check has cleared when the latest logged band is none or low', () => {
    for (const band of ['none', 'low']) {
      expect(
        voiceReturnAllowed({
          handoffSeverity: 'medium',
          chatPeakSeverity: 'none',
          riskCheckSteps: [{ step: 'ideation', risk_band: band }],
        }),
      ).toBe(true);
    }
    for (const band of ['moderate', 'high', 'imminent', 'something-new']) {
      expect(
        voiceReturnAllowed({
          handoffSeverity: 'medium',
          chatPeakSeverity: 'none',
          riskCheckSteps: [{ step: 'ideation', risk_band: band }],
        }),
      ).toBe(false);
    }
  });

  it('the LATEST step decides: an early "low" does not clear a later "high"', () => {
    expect(
      voiceReturnAllowed({
        handoffSeverity: 'medium',
        chatPeakSeverity: 'none',
        riskCheckSteps: [
          { step: 'ideation', risk_band: 'low' },
          { step: 'plan', risk_band: 'high' },
        ],
      }),
    ).toBe(false);
    expect(
      voiceReturnAllowed({
        handoffSeverity: 'medium',
        chatPeakSeverity: 'medium',
        riskCheckSteps: [
          { step: 'ideation', risk_band: 'moderate' },
          { step: 'protective_factors', risk_band: 'low' },
        ],
      }),
    ).toBe(true);
  });

  it('a medium turn in a chat that started with no signal now needs the check too', () => {
    expect(voiceReturnAllowed({ handoffSeverity: 'none', chatPeakSeverity: 'medium', riskCheckSteps: [] })).toBe(false);
    expect(voiceReturnAllowed({ handoffSeverity: 'none', chatPeakSeverity: 'medium', riskCheckSteps: cleared })).toBe(
      true,
    );
  });
});
