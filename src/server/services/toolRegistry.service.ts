/**
 * Tool Registry Service
 * Centralized registry for OpenAI Realtime API function/tool definitions and handlers
 */

import { pool } from '../config/db.js';

interface ToolDefinition {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Server-side context injected per invocation (the model never supplies it). */
export interface ToolContext {
  sessionId?: string;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

type ResourceKey = 'suicide' | 'domestic_violence' | 'substance_abuse' | 'mental_health';

export class ToolRegistry {
  private tools: Map<string, RegisteredTool>;

  constructor() {
    this.tools = new Map(); // tool name → { definition, handler }
    this.registerDefaultTools();
  }

  /**
   * Register a tool with its definition and handler
   * @param {string} name - Tool name
   * @param {object} definition - OpenAI function definition
   * @param {function} handler - async function(args) => result
   */
  registerTool(name: string, definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(name, { definition, handler });
    console.log(`[ToolRegistry] Registered tool: ${name}`);
  }

  /**
   * Execute a registered tool
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @returns {Promise<unknown>} - Tool execution result
   */
  async executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    // Admin kill switch (features.disabled_tools) also guards execution, in
    // case a session was minted before the tool was disabled.
    if ((await this.getDisabledTools()).includes(name)) {
      console.warn(`[ToolRegistry] Blocked disabled tool: ${name}`);
      return { error: `The ${name} tool is currently unavailable. Continue the conversation without it.` };
    }

    try {
      console.log(`[ToolRegistry] Executing tool: ${name}`);
      const result = await tool.handler(args, ctx);
      return result;
    } catch (error) {
      console.error(`[ToolRegistry] Tool execution error for ${name}:`, error);
      throw error;
    }
  }

  /** Admin-disabled tool names from features.disabled_tools (ai-therapist-32). */
  private async getDisabledTools(): Promise<string[]> {
    try {
      const { getSystemConfig } = await import('../utils/sessionHelpers.js');
      const config = await getSystemConfig();
      const features = (config.features ?? {}) as { disabled_tools?: unknown };
      return Array.isArray(features.disabled_tools)
        ? features.disabled_tools.filter((t): t is string => typeof t === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Get all tool definitions for session configuration
   * @returns {ToolDefinition[]} Array of OpenAI function definitions
   */
  getAllToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  /** Definitions minus the admin-disabled set — what new sessions are minted with. */
  async getEnabledToolDefinitions(): Promise<ToolDefinition[]> {
    const disabled = await this.getDisabledTools();
    return this.getAllToolDefinitions().filter(def => !disabled.includes(def.name));
  }

  /**
   * Get list of registered tool names
   * @returns {string[]}
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool is registered
   * @param {string} name
   * @returns {boolean}
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Register default tools
   */
  registerDefaultTools(): void {
    // Tool 1: Get session summary
    this.registerTool(
      'get_session_summary',
      {
        type: 'function',
        name: 'get_session_summary',
        description: 'Get a summary of the current therapy session including duration, message count, and conversation statistics.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        const session_id = ctx.sessionId;
        if (!session_id) {
          return { error: 'No session context available' };
        }

        try {
          const result = await pool.query(`
            SELECT
              ts.created_at,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ts.created_at)) / 60 as duration_minutes,
              COUNT(m.message_id) as message_count,
              COUNT(m.message_id) FILTER (WHERE m.role = 'user') as user_messages,
              COUNT(m.message_id) FILTER (WHERE m.role = 'assistant') as assistant_messages,
              COUNT(m.message_id) FILTER (WHERE m.role = 'system') as system_messages
            FROM therapy_sessions ts
            LEFT JOIN messages m ON ts.session_id = m.session_id
            WHERE ts.session_id = $1
            GROUP BY ts.session_id, ts.created_at
          `, [session_id]);

          if (result.rows.length === 0) {
            return {
              error: 'Session not found',
              session_id
            };
          }

          const session = result.rows[0];
          return {
            session_id,
            duration_minutes: Math.round(parseFloat(session.duration_minutes)),
            total_messages: parseInt(session.message_count),
            user_messages: parseInt(session.user_messages),
            assistant_messages: parseInt(session.assistant_messages),
            system_messages: parseInt(session.system_messages),
            started_at: session.created_at
          };
        } catch (error: unknown) {
          console.error('[ToolRegistry] Error in get_session_summary:', error);
          return {
            error: 'Failed to retrieve session summary',
            details: error instanceof Error ? error.message : String(error)
          };
        }
      }
    );

    // Tool 2: Get crisis resources
    this.registerTool(
      'get_crisis_resources',
      {
        type: 'function',
        name: 'get_crisis_resources',
        description: 'Get emergency crisis support resources including hotline numbers and online services. Use this when someone is in crisis or mentions thoughts of self-harm.',
        parameters: {
          type: 'object',
          properties: {
            resource_type: {
              type: 'string',
              enum: ['all', 'suicide', 'domestic_violence', 'substance_abuse', 'mental_health'],
              description: 'Type of crisis resources to retrieve. Default is "all" to provide comprehensive support options.'
            }
          },
          required: []
        }
      },
      async (args: Record<string, unknown>) => {
        const resource_type = (args['resource_type'] as string | undefined) ?? 'all';

        const resources: Record<ResourceKey, { name: string; phone: string; text?: string; chat?: string; available: string; description: string }> = {
          suicide: {
            name: '988 Suicide & Crisis Lifeline',
            phone: '988',
            text: 'Text 988',
            chat: 'https://988lifeline.org/chat',
            available: '24/7',
            description: 'Free and confidential support for people in distress, prevention and crisis resources.'
          },
          domestic_violence: {
            name: 'National Domestic Violence Hotline',
            phone: '1-800-799-7233',
            text: 'Text START to 88788',
            chat: 'https://www.thehotline.org',
            available: '24/7',
            description: 'Support for domestic violence victims and survivors.'
          },
          substance_abuse: {
            name: 'SAMHSA National Helpline',
            phone: '1-800-662-4357',
            available: '24/7',
            description: 'Treatment referral and information service for substance abuse and mental health issues.'
          },
          mental_health: {
            name: 'NAMI HelpLine',
            phone: '1-800-950-6264',
            text: 'Text NAMI to 741741',
            available: 'M-F 10am-10pm ET',
            description: 'National Alliance on Mental Illness - Information, referrals, and support.'
          }
        };

        if (resource_type === 'all') {
          return {
            message: 'Here are crisis support resources available to you:',
            resources: resources,
            important_note: 'If you are in immediate danger, please call 911 or go to your nearest emergency room.'
          };
        } else if (resource_type in resources) {
          const key = resource_type as ResourceKey;
          return {
            message: `Here is the ${resource_type.replace('_', ' ')} support resource:`,
            resource: resources[key],
            important_note: 'If you are in immediate danger, please call 911 or go to your nearest emergency room.'
          };
        } else {
          return {
            error: 'Resource type not found',
            available_types: Object.keys(resources),
            default_resource: resources.suicide
          };
        }
      }
    );

    // Tool 3: Guided breathing exercise (ai-therapist-26). The participant's
    // browser watches the same function-call event on the WebRTC data channel
    // and renders the animated overlay; this handler tells the model how to
    // narrate alongside it.
    this.registerTool(
      'start_breathing_exercise',
      {
        type: 'function',
        name: 'start_breathing_exercise',
        description: 'Start a guided box-breathing exercise on the participant\'s screen (an animated breathing circle appears). Use when the participant seems anxious, overwhelmed, or asks for help calming down. Always ask if they would like to try it before starting.',
        parameters: {
          type: 'object',
          properties: {
            duration_seconds: {
              type: 'number',
              description: 'How long the exercise should run. Default 60, maximum 300.'
            }
          },
          required: []
        }
      },
      async (args: Record<string, unknown>) => {
        const duration = Math.min(Math.max(Number(args['duration_seconds']) || 60, 20), 300);
        return {
          success: true,
          duration_seconds: duration,
          guidance: `A breathing circle is now showing on the participant's screen for ${duration} seconds. Narrate calmly along with it: breathe in slowly for 4 counts as the circle grows, hold for 4, breathe out for 4 as it shrinks, hold for 4. Keep your voice slow and quiet, repeat the cycle with them, and check in gently when the exercise ends.`
        };
      }
    );

    // Tool 4: 5-4-3-2-1 grounding exercise (ai-therapist-26).
    this.registerTool(
      'start_grounding_exercise',
      {
        type: 'function',
        name: 'start_grounding_exercise',
        description: 'Start a 5-4-3-2-1 grounding exercise on the participant\'s screen (a step-by-step sensory checklist appears). Use when the participant feels panicky, dissociated, or stuck in racing thoughts. Always ask if they would like to try it before starting.',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      async () => ({
        success: true,
        guidance: 'A 5-4-3-2-1 grounding checklist is now showing on the participant\'s screen. Walk them through it slowly, one sense at a time: 5 things they can see, 4 they can touch, 3 they can hear, 2 they can smell, 1 they can taste. Wait for their answers at each step — don\'t rush. Afterwards, ask how they feel.'
      })
    );

    // Tool 5: Structured mood self-report (ai-therapist-27).
    this.registerTool(
      'log_mood',
      {
        type: 'function',
        name: 'log_mood',
        description: 'Record the participant\'s self-reported mood when they describe how they are feeling, especially when they give or agree to a 1-10 rating. Ask naturally ("out of 10, where would you put how you\'re feeling right now?") — never demand a number.',
        parameters: {
          type: 'object',
          properties: {
            score: { type: 'number', description: 'Mood 1 (really struggling) to 10 (great).' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Short feeling words the participant used, e.g. ["anxious", "hopeful"].'
            }
          },
          required: ['score']
        }
      },
      async (args: Record<string, unknown>) => {
        const score = Number(args['score']);
        if (!Number.isFinite(score) || score < 1 || score > 10) {
          return { error: 'score must be a number from 1 to 10' };
        }
        // The invocation itself (args + risk score) is persisted by the
        // sideband's tool_invocations logging — nothing more to store here.
        return { success: true, recorded: { score, tags: args['tags'] ?? [] } };
      }
    );

    // Tools 6+7: Session goal (ai-therapist-28).
    this.registerTool(
      'set_session_goal',
      {
        type: 'function',
        name: 'set_session_goal',
        description: 'Record what the participant wants from today\'s conversation, once it becomes clear early in the session. One concise sentence in their words.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'The participant\'s goal for this conversation.' }
          },
          required: ['goal']
        }
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const goal = typeof args['goal'] === 'string' ? args['goal'].trim().substring(0, 500) : '';
        if (!goal || !ctx.sessionId) {
          return { error: 'goal text and session context are required' };
        }
        const { setSessionGoal } = await import('../db/index.js');
        await setSessionGoal(ctx.sessionId, goal);
        return { success: true, goal };
      }
    );

    this.registerTool(
      'recall_session_goal',
      {
        type: 'function',
        name: 'recall_session_goal',
        description: 'Retrieve the goal set for this conversation (from set_session_goal or the participant\'s pre-session check-in). Use before wrapping up to check the conversation served what they came for.',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const { getSessionGoal } = await import('../db/index.js');
        const goal = await getSessionGoal(ctx.sessionId);
        if (goal) return { goal, source: 'set_during_session' };
        const result = await pool.query<{ checkin: { goal?: string } | null }>(
          'SELECT checkin FROM therapy_sessions WHERE session_id = $1', [ctx.sessionId]);
        const checkinGoal = result.rows[0]?.checkin?.goal;
        return checkinGoal
          ? { goal: checkinGoal, source: 'pre_session_checkin' }
          : { goal: null, message: 'No goal was recorded for this session.' };
      }
    );

    // Tool 8: Model-initiated escalation (ai-therapist-29).
    this.registerTool(
      'escalate_to_human',
      {
        type: 'function',
        name: 'escalate_to_human',
        description: 'Alert the human monitoring team about this session. Use when you judge the participant needs human attention: safety concerns below the obvious-crisis threshold, requests to speak to a person, or situations beyond your scope. Do not announce the escalation to the participant unless they asked for a human.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'One or two sentences: why human attention is needed.' },
            urgency: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'low = review when convenient; medium = look soon; high = immediate safety concern.'
            }
          },
          required: ['reason', 'urgency']
        }
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const reason = typeof args['reason'] === 'string' ? args['reason'].substring(0, 1000) : 'No reason given';
        const urgency = ['low', 'medium', 'high'].includes(args['urgency'] as string)
          ? (args['urgency'] as 'low' | 'medium' | 'high') : 'medium';

        const { flagSessionCrisis, logInterventionAction } = await import('./crisisDetection.service.js');
        const scoreByUrgency = { low: 30, medium: 55, high: 80 } as const;

        // High urgency raises a full crisis flag; lower urgencies alert without flagging.
        if (urgency === 'high') {
          await flagSessionCrisis(
            ctx.sessionId, 'high', scoreByUrgency.high,
            'ai_assistant', 'ai_tool', null, ['model_escalation'], reason
          );
        }
        await logInterventionAction(ctx.sessionId, 'ai_escalation', { urgency, reason });

        if (global.io) {
          global.io.to('admin-broadcast').emit('session:escalation-requested', {
            sessionId: ctx.sessionId, urgency, reason, requestedAt: new Date(),
            message: `AI requested human attention (${urgency}): ${reason}`,
          });
        }
        return {
          success: true,
          message: `The monitoring team has been alerted (${urgency} urgency). Continue supporting the participant calmly; a human can now step in via this session.`
        };
      }
    );

    // Tool 9: Curated coping-technique library (ai-therapist-30).
    this.registerTool(
      'get_coping_strategies',
      {
        type: 'function',
        name: 'get_coping_strategies',
        description: 'Look up vetted coping techniques for a topic before suggesting one. Prefer these over improvising, and offer ONE at a time in your own warm words.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              enum: ['anxiety', 'stress', 'sleep', 'anger', 'sadness', 'grounding'],
              description: 'What the participant is struggling with.'
            }
          },
          required: ['topic']
        }
      },
      async (args: Record<string, unknown>) => {
        const topic = args['topic'] as string;
        const { getCopingLibrary } = await import('../utils/copingLibrary.js');
        const library = await getCopingLibrary();
        const techniques = library[topic];
        return techniques
          ? { topic, techniques, note: 'Offer one technique at a time, in your own words, and check it fits before moving on.' }
          : { error: `No techniques for topic '${topic}'`, available_topics: Object.keys(library) };
      }
    );

    // Tool 10: Time remaining (ai-therapist-31) — lets the model wind down
    // gracefully instead of being cut off by the duration limit.
    this.registerTool(
      'get_time_remaining',
      {
        type: 'function',
        name: 'get_time_remaining',
        description: 'Check how many minutes remain before this session\'s time limit. Use when a conversation is winding toward a natural close, or to pace a longer topic. Never read the exact number out robotically — use it to close warmly in time.',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const { getSystemConfig } = await import('../utils/sessionHelpers.js');
        const config = await getSystemConfig();
        const limits = (config.session_limits ?? {}) as { enabled?: boolean; max_duration_minutes?: number };
        if (!limits.enabled || !limits.max_duration_minutes) {
          return { unlimited: true, message: 'This session has no time limit.' };
        }
        const result = await pool.query<{ created_at: Date }>(
          'SELECT created_at FROM therapy_sessions WHERE session_id = $1', [ctx.sessionId]);
        const createdAt = result.rows[0]?.created_at;
        if (!createdAt) return { error: 'Session not found' };
        const elapsedMin = (Date.now() - new Date(createdAt).getTime()) / 60000;
        const remaining = Math.max(0, Math.round(limits.max_duration_minutes - elapsedMin));
        return { minutes_remaining: remaining, session_length_minutes: limits.max_duration_minutes };
      }
    );

    console.log('[ToolRegistry] Default tools registered');
  }

  /**
   * Unregister a tool
   * @param {string} name
   * @returns {boolean} - true if tool was removed, false if not found
   */
  unregisterTool(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      console.log(`[ToolRegistry] Unregistered tool: ${name}`);
    }
    return deleted;
  }

  /**
   * Clear all registered tools
   */
  clearAll(): void {
    this.tools.clear();
    console.log('[ToolRegistry] All tools cleared');
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
