import { describe, it, expect, vi, beforeEach } from 'vitest';

// The text hand-off's decisions (ai-therapist-356): which sessions are the
// incident, what the participant's risk in it was, what the new chat session
// starts flagged at, and what the model is seeded with. Database, paging
// policy and sideband are mocked; the rules under test are this module's.
const q = vi.hoisted(() => ({
  getHandoffRecord: vi.fn(),
  getHandoffSessionRow: vi.fn(),
  getIncidentTurns: vi.fn(),
  getPredecessorSessionId: vi.fn(),
  getSessionAssessedPeak: vi.fn(),
  getSessionRiskCheckSteps: vi.fn(),
  insertHandoffLink: vi.fn(),
  markTextHandoffContinuation: vi.fn(),
}));
const paging = vi.hoisted(() => ({
  resolveIncidentPeak: vi.fn(),
  pageHighRisk: vi.fn(),
  pageVendorTermination: vi.fn(),
}));
const sideband = vi.hoisted(() => ({ waitForUserTurnsScored: vi.fn() }));

vi.mock('../db/textHandoff.queries.js', () => ({
  ...q,
  HANDOFF_EVENT: 'voice_cut_text_handoff',
  VOICE_RETURN_EVENT: 'voice_resumed_from_text',
}));
vi.mock('./crisisPaging.service.js', () => paging);
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sideband }));
vi.mock('../utils/adminBroadcast.js', () => ({
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));

import {
  buildIncidentRecap,
  consumeNarrowFirstTurn,
  HANDOFF_RECAP_SESSION_BREAK,
  HANDOFF_SCORING_WAIT_MS,
  isHandoffSession,
  prepareTextHandoff,
  resolveIncidentChain,
  resolveVoiceReturn,
  verifyVoiceReturn,
  _resetTextHandoffStateForTests,
} from './textHandoff.service.js';
import {
  HANDOFF_CEILING_FIRST_MESSAGE,
  HANDOFF_CRISIS_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE,
} from '../../shared/textHandoff.js';

const USER = 7;
const row = (id: string, over: Record<string, unknown> = {}) => ({
  session_id: id,
  user_id: USER,
  session_type: id.startsWith('chat') ? 'chat' : 'realtime',
  status: 'ended',
  crisis_flagged: false,
  crisis_severity: null,
  ...over,
});
const mine = () => true;
const turn = (sessionId: string, role: string, content: string) => ({
  session_id: sessionId,
  role,
  content,
  created_at: new Date(),
});

function arrange(opts: {
  rows?: Record<string, ReturnType<typeof row>>;
  predecessors?: Record<string, string | null>;
  peak?: { severity: string; riskScore: number | null };
  scored?: boolean;
  turns?: ReturnType<typeof turn>[];
}) {
  const rows = opts.rows ?? { live_A: row('live_A') };
  q.getHandoffSessionRow.mockImplementation(async (id: string) => rows[id] ?? null);
  q.getPredecessorSessionId.mockImplementation(async (id: string) => opts.predecessors?.[id] ?? null);
  paging.resolveIncidentPeak.mockResolvedValue(opts.peak ?? { severity: 'none', riskScore: null });
  sideband.waitForUserTurnsScored.mockResolvedValue(opts.scored ?? true);
  q.getIncidentTurns.mockResolvedValue(
    opts.turns ?? [turn('live_A', 'assistant', 'How has this week been?'), turn('live_A', 'user', 'Pretty rough.')],
  );
}

const start = (over: Record<string, unknown> = {}) =>
  prepareTextHandoff({
    chatSessionId: 'chat_new',
    continuedFrom: 'live_A',
    reason: 'content',
    canAccess: mine,
    crisisContact: { phone: '988', text: 'HOME to 741741', enabled: true },
    voiceEnabled: true,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  _resetTextHandoffStateForTests();
  q.insertHandoffLink.mockResolvedValue(undefined);
  q.markTextHandoffContinuation.mockResolvedValue(undefined);
  q.getSessionAssessedPeak.mockResolvedValue('none');
  q.getSessionRiskCheckSteps.mockResolvedValue([]);
  q.getHandoffRecord.mockResolvedValue(null);
  (globalThis as { io?: unknown }).io = undefined;
});

describe('prepareTextHandoff: routing', () => {
  it('crisis cut (incident risk high): the crisis message, quick replies, flagged high at the real score', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    const result = await start();
    expect(result).not.toBeNull();
    expect(result!.firstMessage).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
    expect(result!.payload).toMatchObject({
      kind: 'crisis',
      severity: 'high',
      reason: 'content',
      quickReplies: ['Yes', 'No', 'Not sure'],
      voiceReturnAllowed: false,
      seededFrom: ['live_A'],
    });
    expect(q.markTextHandoffContinuation).toHaveBeenCalledWith('chat_new', {
      severity: 'high',
      riskScore: 85,
      continuedFrom: 'live_A',
      reason: 'content',
    });
    // The first participant turn of a crisis hand-off takes the narrow path, once.
    expect(isHandoffSession('chat_new')).toBe(true);
    expect(consumeNarrowFirstTurn('chat_new')).toBe(true);
    expect(consumeNarrowFirstTurn('chat_new')).toBe(false);
  });

  it('no-risk cut: the neutral message, no suicide question, no flag, voice offered', async () => {
    arrange({ peak: { severity: 'none', riskScore: null } });
    const result = await start();
    expect(result!.firstMessage).toBe(HANDOFF_NEUTRAL_FIRST_MESSAGE);
    expect(result!.firstMessage).not.toMatch(/ending your life/);
    expect(result!.payload).toMatchObject({
      kind: 'neutral',
      severity: 'none',
      quickReplies: [],
      voiceReturnAllowed: true,
    });
    expect(q.markTextHandoffContinuation).not.toHaveBeenCalled();
    expect(consumeNarrowFirstTurn('chat_new')).toBe(false);
    // The model is told not to assume a crisis.
    expect(result!.guidance).toMatch(/Do not assume a crisis/);
  });

  it('no-risk cut with voice disabled in this deployment: neutral, without the voice offer', async () => {
    arrange({ peak: { severity: 'none', riskScore: null } });
    const result = await start({ voiceEnabled: false });
    expect(result!.firstMessage).toBe(HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE);
    expect(result!.payload.voiceReturnAllowed).toBe(false);
  });

  it('medium incident: neutral wording, flagged medium at the real score, no voice offer yet', async () => {
    arrange({ peak: { severity: 'medium', riskScore: 50 } });
    const result = await start();
    expect(result!.firstMessage).toBe(HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE);
    expect(result!.payload).toMatchObject({
      kind: 'neutral',
      severity: 'medium',
      quickReplies: [],
      voiceReturnAllowed: false,
    });
    expect(q.markTextHandoffContinuation).toHaveBeenCalledWith(
      'chat_new',
      expect.objectContaining({ severity: 'medium', riskScore: 50 }),
    );
    // The model is told to finish the interrupted safety check.
    expect(result!.guidance).toMatch(/moderate safety concern/);
    expect(result!.guidance).toMatch(/run_risk_check/);
  });

  it('vendor ceiling on a session flagged high: the time-limit message, flagged high, no quick replies', async () => {
    arrange({ peak: { severity: 'high', riskScore: 78 } });
    const result = await start({ reason: 'expired' });
    expect(result!.firstMessage).toBe(HANDOFF_CEILING_FIRST_MESSAGE);
    expect(result!.payload).toMatchObject({
      kind: 'ceiling',
      reason: 'expired',
      quickReplies: [],
      voiceReturnAllowed: false,
    });
    expect(q.markTextHandoffContinuation).toHaveBeenCalledWith(
      'chat_new',
      expect.objectContaining({ severity: 'high', riskScore: 78, reason: 'expired' }),
    );
    expect(result!.guidance).toMatch(/session time limit/);
    // Only the crisis hand-off's first turn is narrow.
    expect(consumeNarrowFirstTurn('chat_new')).toBe(false);
  });

  it("the cut call's last words are still being scored: risk is unknown, worded and flagged as a crisis", async () => {
    arrange({ peak: { severity: 'none', riskScore: null }, scored: false });
    const result = await start();
    expect(sideband.waitForUserTurnsScored).toHaveBeenCalledWith('live_A', HANDOFF_SCORING_WAIT_MS);
    expect(result!.payload).toMatchObject({ kind: 'crisis', severity: 'unknown' });
    expect(result!.firstMessage).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
    // Flagged high with NO score, so the first scored turn flags for real.
    expect(q.markTextHandoffContinuation).toHaveBeenCalledWith(
      'chat_new',
      expect.objectContaining({ severity: 'high', riskScore: null }),
    );
  });

  it('a high flag already on record wins over a turn still being scored', async () => {
    arrange({ peak: { severity: 'high', riskScore: 90 }, scored: false });
    const result = await start();
    expect(result!.payload).toMatchObject({ kind: 'crisis', severity: 'high' });
    expect(q.markTextHandoffContinuation).toHaveBeenCalledWith('chat_new', expect.objectContaining({ riskScore: 90 }));
  });

  it('the risk read failing is not "no risk": crisis wording', async () => {
    arrange({});
    paging.resolveIncidentPeak.mockRejectedValue(new Error('db down'));
    const result = await start();
    expect(result!.payload).toMatchObject({ kind: 'crisis', severity: 'unknown' });
  });

  it("someone else's session, or one that does not exist, is not continued", async () => {
    arrange({});
    expect(await start({ canAccess: () => false })).toBeNull();
    expect(await start({ continuedFrom: 'live_missing' })).toBeNull();
    expect(q.markTextHandoffContinuation).not.toHaveBeenCalled();
    expect(q.insertHandoffLink).not.toHaveBeenCalled();
    expect(isHandoffSession('chat_new')).toBe(false);
  });
});

describe('prepareTextHandoff: paging and records', () => {
  it('never pages: the cut is paged (or not) where it always was', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    await start();
    expect(paging.pageHighRisk).not.toHaveBeenCalled();
    expect(paging.pageVendorTermination).not.toHaveBeenCalled();
  });

  it('links the two sessions in both directions, with what was decided', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    await start();
    const calls = q.insertHandoffLink.mock.calls.map(
      ([id, details]) => [id, details] as [string, Record<string, unknown>],
    );
    const onChat = calls.find(([id]) => id === 'chat_new')![1];
    const onVoice = calls.find(([id]) => id === 'live_A')![1];
    expect(onChat).toMatchObject({
      event: 'voice_cut_text_handoff',
      role: 'continuation',
      from: 'live_A',
      reason: 'content',
      kind: 'crisis',
      severity: 'high',
      riskScore: 85,
      seededFrom: ['live_A'],
    });
    expect(onVoice).toMatchObject({
      event: 'voice_cut_text_handoff',
      role: 'cut_session',
      to: 'chat_new',
      kind: 'crisis',
    });
  });

  it('a failed flag or link write does not cost the participant the session', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    q.markTextHandoffContinuation.mockRejectedValue(new Error('deadlock'));
    q.insertHandoffLink.mockRejectedValue(new Error('deadlock'));
    const result = await start();
    expect(result!.firstMessage).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
    expect(result!.payload.kind).toBe('crisis');
  });

  it('a failed transcript read still returns the first message (no seeding guidance)', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    q.getIncidentTurns.mockRejectedValue(new Error('timeout'));
    const result = await start();
    expect(result!.firstMessage).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
    expect(result!.guidance).toBeNull();
  });
});

describe('seeding: every session of the incident, most recent first', () => {
  it('follows the chain back and seeds from all of it (not the first session only)', async () => {
    // voice A -> chat B -> voice C (cut now). The disclosure was made in C.
    arrange({
      rows: {
        live_A: row('live_A'),
        chat_B: row('chat_B'),
        live_C: row('live_C', { crisis_flagged: true, crisis_severity: 'high' }),
      },
      predecessors: { live_C: 'chat_B', chat_B: 'live_A' },
      peak: { severity: 'high', riskScore: 85 },
      turns: [
        turn('live_A', 'user', 'I have had a rough week.'),
        turn('chat_B', 'assistant', 'We can keep going here in writing.'),
        turn('live_C', 'user', "I've been thinking about killing myself."),
      ],
    });
    const result = await start({ continuedFrom: 'live_C' });
    expect(result!.payload.seededFrom).toEqual(['live_A', 'chat_B', 'live_C']);
    expect(q.getIncidentTurns).toHaveBeenCalledWith(['live_A', 'chat_B', 'live_C'], expect.any(Number));
    expect(result!.guidance).toContain("Participant: I've been thinking about killing myself.");
    expect(result!.guidance).toContain('Participant: I have had a rough week.');
    expect(result!.guidance).toContain(HANDOFF_RECAP_SESSION_BREAK);
  });

  it('the guidance forbids the "connection got cut off" line and repeats nothing', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    const result = await start();
    const guidance = result!.guidance!;
    expect(guidance).toMatch(/Never describe it as a dropped or lost connection/);
    expect(guidance).toMatch(/do not make them repeat anything/i);
    expect(guidance).toMatch(/Do not say or imply that a person is on the way/);
    // The crisis protocol is intact: ask directly, give the line, log and escalate.
    expect(guidance).toMatch(/ONE direct safety\s+question/);
    expect(guidance).toMatch(/call or text 988 at any time, or text HOME to 741741/);
    expect(guidance).toMatch(/run_risk_check/);
    expect(guidance).toMatch(/escalate_to_human/);
    expect(guidance).toMatch(/read a short reply \("yes", "no", "ok"/);
  });

  it('an anonymous incident takes the highest risk across its linked sessions', async () => {
    arrange({
      rows: {
        live_A: row('live_A', { user_id: null, crisis_flagged: true, crisis_severity: 'high' }),
        chat_B: row('chat_B', { user_id: null }),
        live_C: row('live_C', { user_id: null }),
      },
      predecessors: { live_C: 'chat_B', chat_B: 'live_A' },
    });
    paging.resolveIncidentPeak.mockImplementation(async (id: string) =>
      id === 'live_A' ? { severity: 'high', riskScore: 80 } : { severity: 'none', riskScore: null },
    );
    const result = await start({ continuedFrom: 'live_C' });
    expect(result!.payload).toMatchObject({ kind: 'crisis', severity: 'high' });
    expect(paging.resolveIncidentPeak).toHaveBeenCalledTimes(3);
  });
});

describe('resolveIncidentChain', () => {
  it('returns the sessions oldest first', async () => {
    arrange({
      rows: { live_A: row('live_A'), chat_B: row('chat_B'), live_C: row('live_C') },
      predecessors: { live_C: 'chat_B', chat_B: 'live_A' },
    });
    expect((await resolveIncidentChain('live_C', mine)).map((r) => r.session_id)).toEqual([
      'live_A',
      'chat_B',
      'live_C',
    ]);
  });

  it("stops at a session that is not the requester's", async () => {
    arrange({
      rows: { live_A: row('live_A', { user_id: 99 }), chat_B: row('chat_B'), live_C: row('live_C') },
      predecessors: { live_C: 'chat_B', chat_B: 'live_A' },
    });
    const chain = await resolveIncidentChain('live_C', (r) => r.user_id === USER);
    expect(chain.map((r) => r.session_id)).toEqual(['chat_B', 'live_C']);
  });

  it('does not loop on a cycle of links', async () => {
    arrange({
      rows: { live_A: row('live_A'), chat_B: row('chat_B') },
      predecessors: { live_A: 'chat_B', chat_B: 'live_A' },
    });
    expect((await resolveIncidentChain('live_A', mine)).map((r) => r.session_id)).toEqual(['chat_B', 'live_A']);
  });

  it('keeps the cut session when the link lookup fails', async () => {
    arrange({});
    q.getPredecessorSessionId.mockRejectedValue(new Error('timeout'));
    expect((await resolveIncidentChain('live_A', mine)).map((r) => r.session_id)).toEqual(['live_A']);
  });
});

describe('buildIncidentRecap', () => {
  it('labels the turns and keeps them oldest first', () => {
    const recap = buildIncidentRecap([turn('s1', 'assistant', 'Hello.'), turn('s1', 'user', 'Hi there.')]);
    expect(recap).toBe('You: Hello.\nParticipant: Hi there.');
  });

  it('keeps the MOST RECENT lines when the bound is reached, whole lines only', () => {
    const turns = [
      turn('s1', 'user', 'A'.repeat(40)),
      turn('s1', 'assistant', 'B'.repeat(40)),
      turn('s1', 'user', 'the disclosure itself'),
    ];
    const recap = buildIncidentRecap(turns, 90);
    expect(recap).toContain('Participant: the disclosure itself');
    expect(recap).toContain('B'.repeat(40));
    expect(recap).not.toContain('A'.repeat(40));
    expect(recap.length).toBeLessThanOrEqual(90);
  });

  it('never returns nothing because the newest line alone is too long: keeps its end', () => {
    const recap = buildIncidentRecap([turn('s1', 'user', `${'x'.repeat(500)} and I want to die`)], 60);
    expect(recap.length).toBe(60);
    expect(recap.endsWith('and I want to die')).toBe(true);
  });

  it('marks where one session of the incident ends and the next begins', () => {
    const recap = buildIncidentRecap([turn('s1', 'user', 'first call'), turn('s2', 'user', 'second call')]);
    expect(recap.split('\n')).toEqual([
      'Participant: first call',
      HANDOFF_RECAP_SESSION_BREAK,
      'Participant: second call',
    ]);
  });

  it('skips empty turns and anything that is not participant or assistant speech', () => {
    expect(
      buildIncidentRecap([turn('s1', 'system', 'tool call'), turn('s1', 'user', '   '), turn('s1', 'user', 'ok')]),
    ).toBe('Participant: ok');
    expect(buildIncidentRecap([])).toBe('');
  });
});

describe('return to voice', () => {
  it('is not a question for an ordinary chat session', async () => {
    q.getHandoffRecord.mockResolvedValue(null);
    expect(await resolveVoiceReturn('chat_plain')).toBeNull();
  });

  it('after a crisis hand-off: never, even once the risk check reads low', async () => {
    arrange({ peak: { severity: 'high', riskScore: 85 } });
    await start();
    expect(await resolveVoiceReturn('chat_new')).toBe(false);
    q.getSessionRiskCheckSteps.mockResolvedValue([{ step: 'ideation', risk_band: 'low' }]);
    expect(await resolveVoiceReturn('chat_new')).toBe(false);
  });

  it('after a medium hand-off: withheld until the risk check clears, then allowed', async () => {
    arrange({ peak: { severity: 'medium', riskScore: 55 } });
    await start();
    expect(await resolveVoiceReturn('chat_new')).toBe(false);
    q.getSessionRiskCheckSteps.mockResolvedValue([{ step: 'ideation', risk_band: 'low' }]);
    expect(await resolveVoiceReturn('chat_new')).toBe(true);
    // A turn scored high in the chat closes it again, whatever the check says.
    q.getSessionAssessedPeak.mockResolvedValue('high');
    expect(await resolveVoiceReturn('chat_new')).toBe(false);
  });

  it('reads the stored hand-off when this process did not start it (after a restart)', async () => {
    q.getHandoffRecord.mockResolvedValue({ kind: 'crisis', severity: 'high', reason: 'content', from: 'live_A' });
    expect(await resolveVoiceReturn('chat_old')).toBe(false);
    q.getHandoffRecord.mockResolvedValue({ kind: 'neutral', severity: 'none', reason: 'content', from: 'live_A' });
    expect(await resolveVoiceReturn('chat_old')).toBe(true);
  });

  it('a failed read withholds the button', async () => {
    q.getHandoffRecord.mockRejectedValue(new Error('db down'));
    expect(await resolveVoiceReturn('chat_old')).toBe(false);
  });

  it('verifyVoiceReturn: only the owner, only a chat session, only when cleared', async () => {
    q.getHandoffRecord.mockResolvedValue({ kind: 'neutral', severity: 'none', reason: 'content', from: 'live_A' });
    q.getHandoffSessionRow.mockResolvedValue(row('chat_old'));
    expect(await verifyVoiceReturn('chat_old', mine)).toBe(true);
    expect(await verifyVoiceReturn('chat_old', () => false)).toBe(false);
    q.getHandoffSessionRow.mockResolvedValue(row('live_X'));
    expect(await verifyVoiceReturn('live_X', mine)).toBe(false);
    q.getHandoffSessionRow.mockResolvedValue(null);
    expect(await verifyVoiceReturn('chat_missing', mine)).toBe(false);
    // An ordinary chat session (no hand-off on record) gets no exemption.
    q.getHandoffSessionRow.mockResolvedValue(row('chat_plain'));
    q.getHandoffRecord.mockResolvedValue(null);
    expect(await verifyVoiceReturn('chat_plain', mine)).toBe(false);
  });
});
