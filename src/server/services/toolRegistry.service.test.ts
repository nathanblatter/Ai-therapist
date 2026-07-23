import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, getSystemConfigMock, setSessionGoalMock, getSessionGoalMock, flagSessionCrisisMock, logInterventionActionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  setSessionGoalMock: vi.fn(),
  getSessionGoalMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
}));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
}));
vi.mock('../db/index.js', () => ({
  setSessionGoal: setSessionGoalMock,
  getSessionGoal: getSessionGoalMock,
}));
vi.mock('./crisisDetection.service.js', () => ({
  flagSessionCrisis: flagSessionCrisisMock,
  logInterventionAction: logInterventionActionMock,
}));

import { toolRegistry } from './toolRegistry.service.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  getSystemConfigMock.mockReset().mockResolvedValue({ features: {} });
  setSessionGoalMock.mockReset();
  getSessionGoalMock.mockReset();
  flagSessionCrisisMock.mockReset();
  logInterventionActionMock.mockReset();
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
