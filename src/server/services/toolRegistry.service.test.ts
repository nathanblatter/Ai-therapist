import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  queryMock, getSystemConfigMock, setSessionGoalMock, getSessionGoalMock, flagSessionCrisisMock,
  logInterventionActionMock, searchKnowledgeChunksMock, embedTextMock, getSessionMock,
  getUserMemoryEnabledMock, searchUserMemoriesMock, getActiveModalityMock,
  getUserLatestThoughtRecordMock, getUserLatestSafetyPlanMock, getSessionSafetyPlanMock,
  getSessionScaleResponsesMock, getUserLatestScaleScoreMock,
  getKnowledgeChunkByIdMock, insertWorksheetInstanceMock,
  insertRiskCheckStepMock, getRiskCheckStepsMock, getLatestCrisisEventIdMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  setSessionGoalMock: vi.fn(),
  getSessionGoalMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  searchKnowledgeChunksMock: vi.fn(),
  embedTextMock: vi.fn(),
  getSessionMock: vi.fn(),
  getUserMemoryEnabledMock: vi.fn(),
  searchUserMemoriesMock: vi.fn(),
  getActiveModalityMock: vi.fn(),
  getUserLatestThoughtRecordMock: vi.fn(),
  getUserLatestSafetyPlanMock: vi.fn(),
  getSessionSafetyPlanMock: vi.fn(),
  getSessionScaleResponsesMock: vi.fn(),
  getUserLatestScaleScoreMock: vi.fn(),
  getKnowledgeChunkByIdMock: vi.fn(),
  insertWorksheetInstanceMock: vi.fn(),
  insertRiskCheckStepMock: vi.fn(),
  getRiskCheckStepsMock: vi.fn(),
  getLatestCrisisEventIdMock: vi.fn(),
}));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
  getActiveModality: getActiveModalityMock,
}));
vi.mock('../db/index.js', () => ({
  setSessionGoal: setSessionGoalMock,
  getSessionGoal: getSessionGoalMock,
  searchKnowledgeChunks: searchKnowledgeChunksMock,
  getSession: getSessionMock,
  getUserMemoryEnabled: getUserMemoryEnabledMock,
  searchUserMemories: searchUserMemoriesMock,
  getUserLatestThoughtRecord: getUserLatestThoughtRecordMock,
  getUserLatestSafetyPlan: getUserLatestSafetyPlanMock,
  getSessionSafetyPlan: getSessionSafetyPlanMock,
  getSessionScaleResponses: getSessionScaleResponsesMock,
  getUserLatestScaleScore: getUserLatestScaleScoreMock,
  getKnowledgeChunkById: getKnowledgeChunkByIdMock,
  insertWorksheetInstance: insertWorksheetInstanceMock,
  insertRiskCheckStep: insertRiskCheckStepMock,
  getRiskCheckSteps: getRiskCheckStepsMock,
  getLatestCrisisEventId: getLatestCrisisEventIdMock,
}));
vi.mock('./crisisDetection.service.js', () => ({
  flagSessionCrisis: flagSessionCrisisMock,
  logInterventionAction: logInterventionActionMock,
}));
vi.mock('./embeddings.service.js', () => ({
  embedText: embedTextMock,
}));

import { toolRegistry } from './toolRegistry.service.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  getSystemConfigMock.mockReset().mockResolvedValue({ features: {} });
  setSessionGoalMock.mockReset();
  getSessionGoalMock.mockReset();
  flagSessionCrisisMock.mockReset();
  logInterventionActionMock.mockReset();
  searchKnowledgeChunksMock.mockReset();
  embedTextMock.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  getSessionMock.mockReset().mockResolvedValue({ user_id: 42 });
  getUserMemoryEnabledMock.mockReset().mockResolvedValue(true);
  searchUserMemoriesMock.mockReset().mockResolvedValue([]);
  getActiveModalityMock.mockReset().mockResolvedValue(null);
  getUserLatestThoughtRecordMock.mockReset().mockResolvedValue(null);
  getUserLatestSafetyPlanMock.mockReset().mockResolvedValue(null);
  getSessionSafetyPlanMock.mockReset().mockResolvedValue(null);
  getSessionScaleResponsesMock.mockReset().mockResolvedValue([]);
  getUserLatestScaleScoreMock.mockReset().mockResolvedValue(null);
  getKnowledgeChunkByIdMock.mockReset();
  insertWorksheetInstanceMock.mockReset().mockResolvedValue(1);
  insertRiskCheckStepMock.mockReset().mockResolvedValue(1);
  getRiskCheckStepsMock.mockReset().mockResolvedValue([]);
  getLatestCrisisEventIdMock.mockReset().mockResolvedValue(null);
});

describe('registry mechanics', () => {
  it('throws for an unregistered tool', async () => {
    await expect(toolRegistry.executeTool('no_such_tool', {})).rejects.toThrow('Tool not found');
  });

  it('the admin kill switch blocks execution of a disabled tool', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { disabled_tools: ['log_mood'] } });
    const result = await toolRegistry.executeTool('log_mood', { score: 5 }) as { error?: string };
    expect(result.error).toContain('unavailable');
  });

  it('getEnabledToolDefinitions filters out admin-disabled tools', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { disabled_tools: ['log_mood'] } });
    const enabled = await toolRegistry.getEnabledToolDefinitions();
    const names = enabled.map(d => d.name);
    expect(names).not.toContain('log_mood');
    expect(names).toContain('get_crisis_resources');
    expect(enabled.length).toBe(toolRegistry.getAllToolDefinitions().length - 1);
  });

  it('a malformed disabled_tools config fails open (all tools enabled)', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { disabled_tools: 'log_mood' } });
    const enabled = await toolRegistry.getEnabledToolDefinitions();
    expect(enabled.length).toBe(toolRegistry.getAllToolDefinitions().length);
  });
});

describe('log_mood', () => {
  it('rejects out-of-range and non-numeric scores', async () => {
    for (const score of [0, 11, 'high', NaN, undefined]) {
      const result = await toolRegistry.executeTool('log_mood', { score }) as { error?: string };
      expect(result.error).toContain('1 to 10');
    }
  });

  it('records a valid score with tags', async () => {
    const result = await toolRegistry.executeTool('log_mood', { score: 7, tags: ['hopeful'] });
    expect(result).toEqual({ success: true, recorded: { score: 7, tags: ['hopeful'] } });
  });
});

describe('set_session_goal / recall_session_goal', () => {
  it('requires a session context and non-empty goal', async () => {
    const noCtx = await toolRegistry.executeTool('set_session_goal', { goal: 'feel calmer' }) as { error?: string };
    expect(noCtx.error).toBeTruthy();
    const noGoal = await toolRegistry.executeTool('set_session_goal', { goal: '   ' }, { sessionId: 's1' }) as { error?: string };
    expect(noGoal.error).toBeTruthy();
    expect(setSessionGoalMock).not.toHaveBeenCalled();
  });

  it('trims and caps the goal before persisting', async () => {
    const long = 'x'.repeat(600);
    const result = await toolRegistry.executeTool('set_session_goal', { goal: `  ${long}` }, { sessionId: 's1' }) as { goal: string };
    expect(setSessionGoalMock).toHaveBeenCalledWith('s1', 'x'.repeat(500));
    expect(result.goal.length).toBe(500);
  });

  it('recall falls back to the pre-session check-in goal', async () => {
    getSessionGoalMock.mockResolvedValue(null);
    queryMock.mockResolvedValue({ rows: [{ checkin: { goal: 'sleep better' } }], rowCount: 1 });
    const result = await toolRegistry.executeTool('recall_session_goal', {}, { sessionId: 's1' });
    expect(result).toEqual({ goal: 'sleep better', source: 'pre_session_checkin' });
  });
});

describe('escalate_to_human', () => {
  it('high urgency raises a full crisis flag and logs the escalation', async () => {
    const result = await toolRegistry.executeTool(
      'escalate_to_human',
      { reason: 'participant asked for a person', urgency: 'high' },
      { sessionId: 's1' }
    ) as { success: boolean };
    expect(result.success).toBe(true);
    expect(flagSessionCrisisMock).toHaveBeenCalledWith(
      's1', 'high', 80, 'ai_assistant', 'ai_tool', null, ['model_escalation'], 'participant asked for a person'
    );
    expect(logInterventionActionMock).toHaveBeenCalledWith('s1', 'ai_escalation', expect.objectContaining({ urgency: 'high' }));
  });

  it('lower urgencies alert without raising a crisis flag', async () => {
    await toolRegistry.executeTool('escalate_to_human', { reason: 'wants human review', urgency: 'low' }, { sessionId: 's1' });
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalled();
  });

  it('clamps an unknown urgency to medium instead of failing', async () => {
    await toolRegistry.executeTool('escalate_to_human', { reason: 'r', urgency: 'critical!!' }, { sessionId: 's1' });
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith('s1', 'ai_escalation', expect.objectContaining({ urgency: 'medium' }));
  });
});

describe('retrieve_psychoeducation (RAG)', () => {
  it('requires a query', async () => {
    const result = await toolRegistry.executeTool('retrieve_psychoeducation', { query: '  ' }) as { error?: string };
    expect(result.error).toBeTruthy();
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('embeds the query and returns formatted, sourced passages', async () => {
    searchKnowledgeChunksMock.mockResolvedValue([
      { title: 'What depression is', content: 'Depression is...', source: 'NIMH', source_url: 'https://nimh', topic: 'depression', similarity: 0.9 },
    ]);
    const result = await toolRegistry.executeTool('retrieve_psychoeducation', { query: 'what is depression', topic: 'depression' }) as { results: unknown[]; guidance: string };
    expect(embedTextMock).toHaveBeenCalledWith('what is depression');
    expect(searchKnowledgeChunksMock).toHaveBeenCalledWith([0.1, 0.2, 0.3], { kind: 'psychoeducation', topic: 'depression' }, 4);
    expect(result.results).toEqual([
      { title: 'What depression is', content: 'Depression is...', source: 'NIMH', source_url: 'https://nimh' },
    ]);
    expect(result.guidance).toMatch(/do not add clinical claims or citations beyond/i);
  });

  it('passes null topic when none is given', async () => {
    searchKnowledgeChunksMock.mockResolvedValue([]);
    await toolRegistry.executeTool('retrieve_psychoeducation', { query: 'coping tips' });
    expect(searchKnowledgeChunksMock).toHaveBeenCalledWith([0.1, 0.2, 0.3], { kind: 'psychoeducation', topic: null }, 4);
  });

  it('on empty results, instructs the model not to fabricate citations', async () => {
    searchKnowledgeChunksMock.mockResolvedValue([]);
    const result = await toolRegistry.executeTool('retrieve_psychoeducation', { query: 'obscure' }) as { results: unknown[]; guidance: string };
    expect(result.results).toEqual([]);
    expect(result.guidance).toMatch(/do not invent citations/i);
  });

  it('fails safe (no throw, no-fabrication message) when the knowledge base errors', async () => {
    embedTextMock.mockRejectedValue(new Error('embeddings down'));
    const result = await toolRegistry.executeTool('retrieve_psychoeducation', { query: 'anything' }) as { error?: string };
    expect(result.error).toMatch(/do not invent citations/i);
  });
});

describe('recall_relevant_history (per-user RAG)', () => {
  it('requires a query', async () => {
    const r = await toolRegistry.executeTool('recall_relevant_history', { query: '' }, { sessionId: 's1' }) as { error?: string };
    expect(r.error).toBeTruthy();
  });

  it('is unavailable for anonymous participants', async () => {
    getSessionMock.mockResolvedValue({ user_id: null });
    const r = await toolRegistry.executeTool('recall_relevant_history', { query: 'my dog' }, { sessionId: 's1' }) as { available: boolean };
    expect(r.available).toBe(false);
    expect(searchUserMemoriesMock).not.toHaveBeenCalled();
  });

  it('is unavailable when session memory is off', async () => {
    getUserMemoryEnabledMock.mockResolvedValue(false);
    const r = await toolRegistry.executeTool('recall_relevant_history', { query: 'my dog' }, { sessionId: 's1' }) as { available: boolean };
    expect(r.available).toBe(false);
    expect(searchUserMemoriesMock).not.toHaveBeenCalled();
  });

  it('returns semantically matched memories scoped to the user', async () => {
    searchUserMemoriesMock.mockResolvedValue([
      { fact: 'Their dog is named Max', created_at: new Date('2026-07-01T00:00:00Z'), similarity: 0.8 },
    ]);
    const r = await toolRegistry.executeTool('recall_relevant_history', { query: 'pet' }, { sessionId: 's1' }) as { available: boolean; memories: { fact: string; when: string }[] };
    expect(searchUserMemoriesMock).toHaveBeenCalledWith(42, [0.1, 0.2, 0.3], 5);
    expect(r.memories).toEqual([{ fact: 'Their dog is named Max', when: '2026-07-01' }]);
  });

  it('on no matches, instructs the model not to fabricate past details', async () => {
    searchUserMemoriesMock.mockResolvedValue([]);
    const r = await toolRegistry.executeTool('recall_relevant_history', { query: 'nothing' }, { sessionId: 's1' }) as { memories: unknown[]; note: string };
    expect(r.memories).toEqual([]);
    expect(r.note).toMatch(/do not fabricate/i);
  });
});

describe('find_worksheet', () => {
  it('returns the matched worksheet and the render tool to call', async () => {
    searchKnowledgeChunksMock.mockResolvedValue([
      { title: 'Unsent letter', content: 'Write a letter...', source: 'Expressive writing', source_url: null, topic: 'grief', kind: 'worksheet', modality: null, metadata: { render_tool: 'show_journaling_prompt', prompt: 'Write a letter you will never send.' }, similarity: 0.7 },
    ]);
    const r = await toolRegistry.executeTool('find_worksheet', { concern: 'grief about a breakup' }) as { found: boolean; render_tool: string; suggested_prompt: string };
    expect(searchKnowledgeChunksMock).toHaveBeenCalledWith([0.1, 0.2, 0.3], { kind: 'worksheet' }, 1);
    expect(r.found).toBe(true);
    expect(r.render_tool).toBe('show_journaling_prompt');
    expect(r.suggested_prompt).toBe('Write a letter you will never send.');
  });

  it('falls back to a thought record when metadata names it', async () => {
    searchKnowledgeChunksMock.mockResolvedValue([
      { title: 'Challenging a thought', content: '...', source: 'CBT', source_url: null, topic: 'anxiety', kind: 'worksheet', modality: null, metadata: { render_tool: 'start_thought_record' }, similarity: 0.7 },
    ]);
    const r = await toolRegistry.executeTool('find_worksheet', { concern: 'a harsh self-critical thought' }) as { render_tool: string; suggested_prompt: string | null };
    expect(r.render_tool).toBe('start_thought_record');
    expect(r.suggested_prompt).toBeNull();
  });

  it('guides gracefully when no worksheet matches', async () => {
    searchKnowledgeChunksMock.mockResolvedValue([]);
    const r = await toolRegistry.executeTool('find_worksheet', { concern: 'obscure' }) as { found: boolean; guidance: string };
    expect(r.found).toBe(false);
    expect(r.guidance).toMatch(/do not invent a named worksheet/i);
  });
});

describe('suggest_modality_technique', () => {
  it('filters techniques by the active modality', async () => {
    getActiveModalityMock.mockResolvedValue({ key: 'cbt', preset: { label: 'CBT-informed', addition: '' } });
    searchKnowledgeChunksMock.mockResolvedValue([
      { title: 'Behavioral activation', content: 'Schedule small actions...', source: 'NIMH', source_url: 'https://nimh', topic: 'behavioral', kind: 'technique', modality: 'cbt', metadata: null, similarity: 0.8 },
    ]);
    const r = await toolRegistry.executeTool('suggest_modality_technique', { concern: 'no motivation' }) as { found: boolean; technique: string; approach: string };
    expect(embedTextMock).toHaveBeenCalledWith('CBT-informed: no motivation');
    expect(searchKnowledgeChunksMock).toHaveBeenCalledWith([0.1, 0.2, 0.3], { kind: 'technique', modality: 'cbt' }, 1);
    expect(r.found).toBe(true);
    expect(r.approach).toBe('cbt');
  });

  it('falls back to any technique when none match the active modality', async () => {
    getActiveModalityMock.mockResolvedValue({ key: 'mi', preset: { label: 'Motivational interviewing', addition: '' } });
    searchKnowledgeChunksMock
      .mockResolvedValueOnce([]) // no mi-tagged technique
      .mockResolvedValueOnce([{ title: '5-4-3-2-1 grounding', content: '...', source: 'x', source_url: null, topic: 'grounding', kind: 'technique', modality: null, metadata: null, similarity: 0.5 }]);
    const r = await toolRegistry.executeTool('suggest_modality_technique', { concern: 'panic' }) as { found: boolean; technique: string };
    expect(searchKnowledgeChunksMock).toHaveBeenNthCalledWith(1, [0.1, 0.2, 0.3], { kind: 'technique', modality: 'mi' }, 1);
    expect(searchKnowledgeChunksMock).toHaveBeenNthCalledWith(2, [0.1, 0.2, 0.3], { kind: 'technique' }, 1);
    expect(r.found).toBe(true);
    expect(r.technique).toBe('5-4-3-2-1 grounding');
  });

  it('with no active modality, searches all techniques (modality null)', async () => {
    getActiveModalityMock.mockResolvedValue(null);
    searchKnowledgeChunksMock.mockResolvedValue([]);
    await toolRegistry.executeTool('suggest_modality_technique', { concern: 'stress' });
    expect(embedTextMock).toHaveBeenCalledWith('stress');
    expect(searchKnowledgeChunksMock).toHaveBeenNthCalledWith(1, [0.1, 0.2, 0.3], { kind: 'technique', modality: null }, 1);
  });
});

describe('interactive experience tools', () => {
  it('registers the new on-screen experiences', () => {
    for (const name of ['start_body_scan', 'start_values_sort', 'start_fear_ladder']) {
      expect(toolRegistry.hasTool(name)).toBe(true);
    }
  });

  it('server handlers return guidance for the model to narrate alongside', async () => {
    const scan = await toolRegistry.executeTool('start_body_scan', { duration_seconds: 90 }) as { success: boolean; guidance: string };
    expect(scan.success).toBe(true);
    expect(scan.guidance).toMatch(/body-scan/i);
    const values = await toolRegistry.executeTool('start_values_sort', {}) as { success: boolean };
    expect(values.success).toBe(true);
    const ladder = await toolRegistry.executeTool('start_fear_ladder', {}) as { success: boolean };
    expect(ladder.success).toBe(true);
  });
});

describe('review_practice (ai-therapist-67)', () => {
  it('requires session context', async () => {
    const r = await toolRegistry.executeTool('review_practice', {}) as { error?: string };
    expect(r.error).toBeTruthy();
  });

  it('is unavailable for anonymous participants', async () => {
    getSessionMock.mockResolvedValue({ user_id: null });
    const r = await toolRegistry.executeTool('review_practice', {}, { sessionId: 's1' }) as { available: boolean };
    expect(r.available).toBe(false);
  });

  it('is unavailable when session memory is off', async () => {
    getUserMemoryEnabledMock.mockResolvedValue(false);
    const r = await toolRegistry.executeTool('review_practice', {}, { sessionId: 's1' }) as { available: boolean };
    expect(r.available).toBe(false);
  });

  it('reports no practice on record without inventing one', async () => {
    const r = await toolRegistry.executeTool('review_practice', {}, { sessionId: 's1' }) as { available: boolean; practice: null };
    expect(r.available).toBe(true);
    expect(r.practice).toBeNull();
  });

  it('returns the last balanced thought and whether a safety plan exists', async () => {
    getUserLatestThoughtRecordMock.mockResolvedValue({ record: { balanced_thought: 'I did my best' }, created_at: new Date('2026-07-01T00:00:00Z') });
    getUserLatestSafetyPlanMock.mockResolvedValue({ plan: {}, created_at: new Date(), session_id: 's0' });
    const r = await toolRegistry.executeTool('review_practice', {}, { sessionId: 's1' }) as {
      thought_record: { balanced_thought: string; when: string } | null;
      has_safety_plan: boolean;
    };
    expect(r.thought_record).toEqual({ balanced_thought: 'I did my best', when: '2026-07-01' });
    expect(r.has_safety_plan).toBe(true);
  });
});

describe('compare_screener_trend (ai-therapist-69)', () => {
  it('requires session context', async () => {
    const r = await toolRegistry.executeTool('compare_screener_trend', { scale: 'phq2' }) as { error?: string };
    expect(r.error).toBeTruthy();
  });

  it('rejects an unknown scale', async () => {
    const r = await toolRegistry.executeTool('compare_screener_trend', { scale: 'bogus' }, { sessionId: 's1' }) as { error?: string };
    expect(r.error).toBeTruthy();
  });

  it('is unavailable for anonymous participants', async () => {
    getSessionMock.mockResolvedValue({ user_id: null });
    const r = await toolRegistry.executeTool('compare_screener_trend', { scale: 'phq2' }, { sessionId: 's1' }) as { available: boolean };
    expect(r.available).toBe(false);
  });

  it('requires this session to already have a response for the scale', async () => {
    getSessionScaleResponsesMock.mockResolvedValue([]);
    const r = await toolRegistry.executeTool('compare_screener_trend', { scale: 'phq2' }, { sessionId: 's1' }) as { available: boolean; reason: string };
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/administer_scale first/);
  });

  it('reports no trend on a first-ever screener', async () => {
    getSessionScaleResponsesMock.mockResolvedValue([{ scale: 'phq2', answers: [1, 1], score: 2, created_at: new Date() }]);
    getUserLatestScaleScoreMock.mockResolvedValue(null);
    const r = await toolRegistry.executeTool('compare_screener_trend', { scale: 'phq2' }, { sessionId: 's1' }) as { previous_score: null };
    expect(r.previous_score).toBeNull();
  });

  it('computes direction against the previous score, excluding the current session', async () => {
    getSessionScaleResponsesMock.mockResolvedValue([{ scale: 'phq2', answers: [1, 0], score: 1, created_at: new Date() }]);
    getUserLatestScaleScoreMock.mockResolvedValue({ score: 4, created_at: new Date(), session_id: 's0' });
    const r = await toolRegistry.executeTool('compare_screener_trend', { scale: 'phq2' }, { sessionId: 's1' }) as { direction: string; current_score: number; previous_score: number };
    expect(getUserLatestScaleScoreMock).toHaveBeenCalledWith(42, 'phq2', 's1');
    expect(r.current_score).toBe(1);
    expect(r.previous_score).toBe(4);
    expect(r.direction).toBe('down');
  });
});

describe('retrieve_safety_plan (ai-therapist-72)', () => {
  it('requires session context', async () => {
    const r = await toolRegistry.executeTool('retrieve_safety_plan', {}) as { error?: string };
    expect(r.error).toBeTruthy();
  });

  it("prefers this session's own plan over a prior one", async () => {
    getSessionSafetyPlanMock.mockResolvedValue({ plan: { warning_signs: ['x'] }, created_at: new Date() });
    const r = await toolRegistry.executeTool('retrieve_safety_plan', {}, { sessionId: 's1' }) as { available: boolean; source: string };
    expect(r.available).toBe(true);
    expect(r.source).toBe('this_session');
    expect(getUserLatestSafetyPlanMock).not.toHaveBeenCalled();
  });

  it("falls back to a consented user's prior-session plan", async () => {
    getSessionSafetyPlanMock.mockResolvedValue(null);
    getUserLatestSafetyPlanMock.mockResolvedValue({ plan: { warning_signs: ['y'] }, created_at: new Date(), session_id: 's0' });
    const r = await toolRegistry.executeTool('retrieve_safety_plan', {}, { sessionId: 's1' }) as { available: boolean; source: string };
    expect(r.available).toBe(true);
    expect(r.source).toBe('previous_session');
  });

  it('does not look up a prior plan when memory is off', async () => {
    getSessionSafetyPlanMock.mockResolvedValue(null);
    getUserMemoryEnabledMock.mockResolvedValue(false);
    const r = await toolRegistry.executeTool('retrieve_safety_plan', {}, { sessionId: 's1' }) as { available: boolean };
    expect(r.available).toBe(false);
    expect(getUserLatestSafetyPlanMock).not.toHaveBeenCalled();
  });

  it('reports unavailable and suggests create_safety_plan when nothing exists', async () => {
    getSessionSafetyPlanMock.mockResolvedValue(null);
    getUserLatestSafetyPlanMock.mockResolvedValue(null);
    const r = await toolRegistry.executeTool('retrieve_safety_plan', {}, { sessionId: 's1' }) as { available: boolean; reason: string };
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/create_safety_plan/);
describe('create_custom_worksheet (ai-therapist-73)', () => {
  const structuredTemplate = {
    chunk_id: 5,
    kind: 'worksheet',
    title: 'Thought challenge',
    content: '...',
    source: 'CBT',
    active: true,
    metadata: { sections: [{ type: 'textarea' }, { type: 'text' }] },
  };

  it('requires session context and template_id', async () => {
    const noCtx = await toolRegistry.executeTool('create_custom_worksheet', { template_id: 5, title: 't', sections: [] }) as { error?: string };
    expect(noCtx.error).toBeTruthy();
    const noTemplate = await toolRegistry.executeTool('create_custom_worksheet', { title: 't', sections: [] }, { sessionId: 's1' }) as { error?: string };
    expect(noTemplate.error).toMatch(/template_id/);
  });

  it('rejects an unknown or inactive template', async () => {
    getKnowledgeChunkByIdMock.mockResolvedValue(null);
    const r = await toolRegistry.executeTool(
      'create_custom_worksheet',
      { template_id: 99, title: 'My worksheet', sections: [{ type: 'text', label: 'a' }] },
      { sessionId: 's1' }
    ) as { error?: string };
    expect(r.error).toMatch(/unknown or inactive/i);
    expect(insertWorksheetInstanceMock).not.toHaveBeenCalled();
  });

  it('enforces the vetted template\'s section count and types (structural mismatch rejected)', async () => {
    getKnowledgeChunkByIdMock.mockResolvedValue(structuredTemplate);
    const tooFew = await toolRegistry.executeTool(
      'create_custom_worksheet',
      { template_id: 5, title: 'Personalized', sections: [{ type: 'textarea', label: 'only one' }] },
      { sessionId: 's1' }
    ) as { error?: string };
    expect(tooFew.error).toMatch(/exactly 2 section/i);

    const wrongType = await toolRegistry.executeTool(
      'create_custom_worksheet',
      { template_id: 5, title: 'Personalized', sections: [{ type: 'scale', label: 'a' }, { type: 'text', label: 'b' }] },
      { sessionId: 's1' }
    ) as { error?: string };
    expect(wrongType.error).toMatch(/must be type "textarea"/i);
    expect(insertWorksheetInstanceMock).not.toHaveBeenCalled();
  });

  it('accepts personalized wording that matches the template structure and stores the instance', async () => {
    getKnowledgeChunkByIdMock.mockResolvedValue(structuredTemplate);
    const r = await toolRegistry.executeTool(
      'create_custom_worksheet',
      {
        template_id: 5,
        title: 'Your thought about the interview',
        intro: 'Let\'s look at that thought together.',
        sections: [
          { type: 'textarea', label: 'What went through your mind before the interview?' },
          { type: 'text', label: 'One word for how that felt' },
        ],
      },
      { sessionId: 's1' }
    ) as { success: boolean; instance_id: number };
    expect(r.success).toBe(true);
    expect(r.instance_id).toBe(1);
    expect(insertWorksheetInstanceMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      templateChunkId: 5,
      title: 'Your thought about the interview',
    }));
  });

  it('falls back to generic bounds for a legacy template with no structured metadata', async () => {
    getKnowledgeChunkByIdMock.mockResolvedValue({ ...structuredTemplate, metadata: null });
    const tooMany = await toolRegistry.executeTool(
      'create_custom_worksheet',
      {
        template_id: 5,
        title: 'Big form',
        sections: Array.from({ length: 8 }, (_, i) => ({ type: 'text', label: `q${i}` })),
      },
      { sessionId: 's1' }
    ) as { error?: string };
    expect(tooMany.error).toMatch(/too many sections/i);

    const ok = await toolRegistry.executeTool(
      'create_custom_worksheet',
      { template_id: 5, title: 'Small form', sections: [{ type: 'text', label: 'q1' }] },
      { sessionId: 's1' }
    ) as { success: boolean };
    expect(ok.success).toBe(true);
  });

  it('drops malformed sections (missing label / bad type) before validating', async () => {
    getKnowledgeChunkByIdMock.mockResolvedValue({ ...structuredTemplate, metadata: null });
    const r = await toolRegistry.executeTool(
      'create_custom_worksheet',
      { template_id: 5, title: 'Form', sections: [{ type: 'not_a_type', label: 'x' }, { type: 'text', label: '' }] },
      { sessionId: 's1' }
    ) as { error?: string };
    expect(r.error).toMatch(/at least one valid section/i);
  });
});

describe('run_risk_check (ai-therapist-71)', () => {
  it('validates step, answer, and risk_band', async () => {
    const badStep = await toolRegistry.executeTool('run_risk_check', { step: 'nope', answer: 'a', risk_band: 'low' }, { sessionId: 's1' }) as { error?: string };
    expect(badStep.error).toMatch(/step must be one of/i);

    const badBand = await toolRegistry.executeTool('run_risk_check', { step: 'ideation', answer: 'a', risk_band: 'nope' }, { sessionId: 's1' }) as { error?: string };
    expect(badBand.error).toMatch(/risk_band must be one of/i);

    const noAnswer = await toolRegistry.executeTool('run_risk_check', { step: 'ideation', answer: '  ', risk_band: 'low' }, { sessionId: 's1' }) as { error?: string };
    expect(noAnswer.error).toMatch(/answer text is required/i);

    expect(insertRiskCheckStepMock).not.toHaveBeenCalled();
  });

  it('requires a session context', async () => {
    const r = await toolRegistry.executeTool('run_risk_check', { step: 'ideation', answer: 'no', risk_band: 'none' }) as { error?: string };
    expect(r.error).toBeTruthy();
  });

  it('logs a step, sequencing after prior steps and linking the latest crisis event', async () => {
    getRiskCheckStepsMock.mockResolvedValue([{ check_step_id: 1 }, { check_step_id: 2 }]);
    getLatestCrisisEventIdMock.mockResolvedValue(77);

    const r = await toolRegistry.executeTool(
      'run_risk_check',
      { step: 'plan', answer: 'They described a specific plan.', risk_band: 'high' },
      { sessionId: 's1' }
    ) as { success: boolean; logged: { step: string; risk_band: string } };

    expect(r.success).toBe(true);
    expect(r.logged).toEqual({ step: 'plan', risk_band: 'high' });
    expect(insertRiskCheckStepMock).toHaveBeenCalledWith({
      sessionId: 's1',
      crisisEventId: 77,
      step: 'plan',
      answer: 'They described a specific plan.',
      riskBand: 'high',
      sequence: 3,
    });
  });

  it('first step of a session gets sequence 1 with no linked crisis event', async () => {
    const r = await toolRegistry.executeTool(
      'run_risk_check',
      { step: 'ideation', answer: 'Yes, sometimes.', risk_band: 'moderate' },
      { sessionId: 's1' }
    ) as { success: boolean };
    expect(r.success).toBe(true);
    expect(insertRiskCheckStepMock).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1, crisisEventId: null }));
  });
});
