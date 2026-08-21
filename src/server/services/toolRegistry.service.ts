/**
 * Tool Registry Service
 * Centralized registry for OpenAI Realtime API function/tool definitions and handlers
 */

import { pool } from '../config/db.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

interface ToolDefinition {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Which pipeline(s) may offer this tool to the model (ai-therapist-118).
   * Omitted = resolved via CHAT_CAPABLE_TOOLS below, so existing/concurrent
   * registrations don't need to change: tools NOT in that set default to
   * 'realtime' (safe default — a new voice-only tool never leaks into chat).
   */
  channel?: 'realtime' | 'chat' | 'both';
}

/**
 * Text-safe tools (ai-therapist-118): everything that works over the chat
 * pipeline — persistence/retrieval tools plus overlays the chat client can
 * render from response toolEvents. Excluded (realtime-only): the narrated
 * live exercises (breathing/grounding/body scan/values sort/fear ladder),
 * switch_language (rewrites realtime session_configurations/sideband
 * instructions) and end_session (chat has its own explicit /api/chat/end
 * path; the handler's server-backstop semantics assume the realtime
 * teardown flow).
 */
const CHAT_CAPABLE_TOOLS = new Set([
  'get_crisis_resources', 'show_resource_card', 'create_safety_plan', 'retrieve_safety_plan',
  'remember_this', 'recall_previous_sessions', 'recall_relevant_history',
  'log_mood', 'set_session_goal', 'recall_session_goal',
  'get_session_summary', 'get_time_remaining', 'get_coping_strategies',
  'retrieve_psychoeducation', 'find_worksheet', 'suggest_modality_technique',
  'start_thought_record', 'show_journaling_prompt', 'display_session_recap',
  'administer_scale', 'flag_notable_moment', 'compare_screener_trend',
  'review_practice', 'create_custom_worksheet', 'escalate_to_human', 'run_risk_check',
]);

/** Effective channel for a definition: explicit field wins, else the set. */
function toolChannel(def: ToolDefinition): 'realtime' | 'chat' | 'both' {
  return def.channel ?? (CHAT_CAPABLE_TOOLS.has(def.name) ? 'both' : 'realtime');
}

/**
 * Project definitions to the exact OpenAI Realtime tool shape. Registry
 * definitions may carry harness-side metadata (`channel`) that OpenAI rejects
 * as an unknown parameter — sending a definition object verbatim to
 * /v1/realtime/client_secrets 400s the whole session mint (assign_practice's
 * `channel: 'both'` broke every realtime session; caught by the voice eval
 * harness, ai-therapist-124). Chat has its own projection (toResponsesTools).
 */
export function toRealtimeTools(defs: ToolDefinition[]): Array<Record<string, unknown>> {
  return defs.map(d => ({
    type: d.type,
    name: d.name,
    description: d.description,
    parameters: d.parameters,
  }));
}

/** Server-side context injected per invocation (the model never supplies it). */
export interface ToolContext {
  sessionId?: string;
  /** Which pipeline invoked the tool ('realtime' sideband vs 'chat' loop). */
  channel?: 'realtime' | 'chat';
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

  /**
   * Definitions minus the admin-disabled set — what new sessions are minted
   * with. Pass { channel } to also filter by pipeline: 'chat' returns only
   * text-safe tools (ai-therapist-118); 'realtime' excludes chat-only ones.
   * Omitting channel keeps the historical behavior (all enabled tools).
   */
  async getEnabledToolDefinitions(opts: { channel?: 'realtime' | 'chat' } = {}): Promise<ToolDefinition[]> {
    const disabled = await this.getDisabledTools();
    return this.getAllToolDefinitions().filter(def => {
      if (disabled.includes(def.name)) return false;
      if (!opts.channel) return true;
      const ch = toolChannel(def);
      return ch === 'both' || ch === opts.channel;
    });
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
          void broadcastAdminEventForSession(global.io, 'session:escalation-requested', {
            sessionId: ctx.sessionId, urgency, reason, requestedAt: new Date(),
            message: `AI requested human attention (${urgency}): ${reason}`,
          }, ctx.sessionId);
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

    // ==================== WAVE 2 TOOLS ====================

    // Tappable crisis-resource card on the participant's screen (rendered
    // client-side from the data-channel event; this handler informs the model).
    this.registerTool(
      'show_resource_card',
      {
        type: 'function',
        name: 'show_resource_card',
        description: 'Display a tappable crisis-resource card on the participant\'s screen with call/text buttons (988, crisis text line, etc.). Stronger than reading numbers aloud — use whenever you share crisis resources, alongside saying them.',
        parameters: {
          type: 'object',
          properties: {
            resource_type: {
              type: 'string',
              enum: ['all', 'suicide', 'domestic_violence', 'substance_abuse', 'mental_health'],
              description: 'Which resources to show. Default all.'
            }
          },
          required: []
        }
      },
      async (args: Record<string, unknown>) => ({
        success: true,
        shown: args['resource_type'] ?? 'all',
        guidance: 'The resource card is now on the participant\'s screen with tappable call/text buttons. Mention it gently ("I\'ve put some numbers on your screen you can tap any time") without pressuring them to use it right now.'
      })
    );

    // Guided CBT thought record (client renders the form; the completed record
    // comes back through the normal logging path as a thought_record message).
    this.registerTool(
      'start_thought_record',
      {
        type: 'function',
        name: 'start_thought_record',
        description: 'Open a guided CBT thought-record form on the participant\'s screen (situation → automatic thought → feeling → evidence → balanced thought). Use when examining a specific unhelpful thought, after asking if they\'d like to work through it in writing.',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      async () => ({
        success: true,
        guidance: 'A thought-record form is now on the participant\'s screen. Stay quiet or offer brief encouragement while they fill it in; when they finish you will receive their entries — respond to the balanced thought they arrived at, not the form itself.'
      })
    );

    // Private journaling overlay. Participant chooses whether to share.
    this.registerTool(
      'show_journaling_prompt',
      {
        type: 'function',
        name: 'show_journaling_prompt',
        description: 'Open a private writing box on the participant\'s screen with a prompt you provide. They choose to share what they wrote with you OR keep it entirely private (you will never see it). Good for feelings that are easier to write than say.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The journaling prompt, e.g. "What would you say to them if there were no consequences?"' }
          },
          required: ['prompt']
        }
      },
      async (args: Record<string, unknown>) => ({
        success: true,
        prompt: args['prompt'],
        guidance: 'The writing box is on their screen. Give them quiet time. If they share it, respond to what they wrote with care; if they keep it private, respect that completely and ask only how the writing felt.'
      })
    );

    // End-of-session visual recap card (client renders from the args).
    this.registerTool(
      'display_session_recap',
      {
        type: 'function',
        name: 'display_session_recap',
        description: 'Show a visual recap card at the end of the session: what was worked on, techniques tried, and one takeaway. Call during your wind-down, right before saying goodbye.',
        parameters: {
          type: 'object',
          properties: {
            focus: { type: 'string', description: 'One line: what today was about.' },
            techniques: { type: 'array', items: { type: 'string' }, description: 'Techniques tried or discussed.' },
            takeaway: { type: 'string', description: 'One warm, specific takeaway for the participant.' }
          },
          required: ['focus', 'takeaway']
        }
      },
      async () => ({
        success: true,
        guidance: 'The recap card is on the participant\'s screen — they can screenshot it. Close the conversation warmly.'
      })
    );

    // Collaborative safety plan: stored server-side + shown as a card.
    this.registerTool(
      'create_safety_plan',
      {
        type: 'function',
        name: 'create_safety_plan',
        description: 'Save a safety plan you built WITH the participant (never invent entries — use their words). It is stored for the clinical team and shown to the participant as a card they can keep. Use after talking through warning signs and coping steps with someone experiencing recurring distress or risk.',
        parameters: {
          type: 'object',
          properties: {
            warning_signs: { type: 'array', items: { type: 'string' }, description: 'Their early warning signs.' },
            coping_strategies: { type: 'array', items: { type: 'string' }, description: 'Steps that help them, in their words.' },
            support_contacts: { type: 'array', items: { type: 'string' }, description: 'People they said they could reach out to (first names only).' },
            reasons_worth_living: { type: 'array', items: { type: 'string' }, description: 'Their stated reasons/values (optional).' }
          },
          required: ['warning_signs', 'coping_strategies']
        }
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const clean = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map(s => s.substring(0, 300)).slice(0, 10) : [];
        const plan = {
          warning_signs: clean(args['warning_signs']),
          coping_strategies: clean(args['coping_strategies']),
          support_contacts: clean(args['support_contacts']),
          reasons_worth_living: clean(args['reasons_worth_living']),
          professional_resources: ['988 Suicide & Crisis Lifeline (call or text 988)', 'Crisis Text Line (text HOME to 741741)', '911 for immediate danger'],
        };
        if (plan.warning_signs.length === 0 || plan.coping_strategies.length === 0) {
          return { error: 'warning_signs and coping_strategies are both required' };
        }
        const { insertSafetyPlan, getSession } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        await insertSafetyPlan(ctx.sessionId, session?.user_id ?? null, plan);

        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'session:safety-plan-created', {
            sessionId: ctx.sessionId, createdAt: new Date(),
          }, ctx.sessionId);
        }
        return {
          success: true,
          guidance: 'The safety plan is saved and now showing on the participant\'s screen with crisis lines added. Encourage them to screenshot it and revisit the coping steps when warning signs appear.'
        };
      }
    );

    // On-demand deep memory recall (consent-gated like the injected block).
    this.registerTool(
      'recall_previous_sessions',
      {
        type: 'function',
        name: 'recall_previous_sessions',
        description: 'Retrieve summaries of this participant\'s previous conversations (only works if they are logged in and opted into session memory). Use when past context would genuinely help — e.g. they reference something from before.',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const { getSession, getUserMemoryEnabled, getRecentUserSummaries, getUserMemories } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (!userId) return { available: false, reason: 'Participant is anonymous — no session history exists.' };
        if (!(await getUserMemoryEnabled(userId))) {
          return { available: false, reason: 'Participant has not opted into session memory. Do not press them about it.' };
        }
        const [summaries, facts] = await Promise.all([
          getRecentUserSummaries(userId, 5),
          getUserMemories(userId),
        ]);
        return {
          available: true,
          previous_sessions: summaries.map(s => ({
            date: (s.ended_at ?? s.created_at).toISOString().slice(0, 10),
            headline: s.summary.headline,
            topics: s.summary.topics,
            what_helped: s.summary.techniques_helped,
            follow_up: s.summary.follow_up,
          })),
          remembered_facts: facts,
          note: 'Use for continuity and warmth. Never claim to remember more than this.'
        };
      }
    );

    // Participant-approved memory.
    this.registerTool(
      'remember_this',
      {
        type: 'function',
        name: 'remember_this',
        description: 'Store one specific fact the participant EXPLICITLY asked you to remember for future conversations ("remember that..."). Only works for logged-in participants with session memory on. Never store anything they did not ask you to keep.',
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: 'The fact, phrased close to their words. One sentence.' }
          },
          required: ['fact']
        }
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const fact = typeof args['fact'] === 'string' ? args['fact'].trim().substring(0, 300) : '';
        if (!fact || !ctx.sessionId) return { error: 'fact and session context are required' };
        const { getSession, getUserMemoryEnabled, insertUserMemory } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (!userId) {
          return { stored: false, reason: 'Participant is anonymous — memories need an account. Let them know gently if they asked.' };
        }
        if (!(await getUserMemoryEnabled(userId))) {
          return { stored: false, reason: 'Session memory is turned off in their settings. Mention they can enable it there if they want this remembered.' };
        }
        // Embed the fact so recall_relevant_history can find it semantically.
        // Best-effort: if embedding fails, still store the fact (it remains
        // listable via recall_previous_sessions, just not semantically searchable).
        let embedding: number[] | undefined;
        try {
          const { embedText } = await import('./embeddings.service.js');
          embedding = await embedText(fact);
        } catch (err) {
          console.error('[ToolRegistry] remember_this embedding failed (storing without it):', err);
        }
        await insertUserMemory(userId, fact, ctx.sessionId, embedding);
        return { stored: true, fact };
      }
    );

    // Graceful model-initiated session end (the client performs the teardown).
    this.registerTool(
      'end_session',
      {
        type: 'function',
        name: 'end_session',
        description: 'End the session cleanly. Call ONLY after you have fully said goodbye and the participant has agreed the conversation is complete — the session closes a few seconds after you call this.',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        // Server-side backstop (ai-therapist-113): ending used to depend
        // entirely on the client reacting to this tool call and POSTing /end
        // — a lost POST left the session active until the abandonment sweep.
        // The sideband executes this handler, so schedule an authoritative
        // end after a grace window for the goodbye audio + the client's own
        // (idempotent) /end. serverEndSession no-ops if the client got there
        // first.
        if (ctx.sessionId) {
          const sessionId = ctx.sessionId;
          setTimeout(() => {
            import('./sessionLifecycle.service.js')
              .then(m => m.serverEndSession(sessionId, { endedBy: 'model', reason: 'model_end_session' }))
              .then(ended => {
                if (ended) console.log(`[end_session] server backstop ended session ${sessionId}`);
              })
              .catch(err => console.error('[end_session] server backstop failed:', err));
          }, 15 * 1000);
        }
        return {
          success: true,
          message: 'The session will close in a few seconds. Do not start any new topics.'
        };
      }
    );

    // Mid-session language switch (steers the model; config recorded).
    this.registerTool(
      'switch_language',
      {
        type: 'function',
        name: 'switch_language',
        description: 'Switch the conversation language when the participant asks or clearly prefers another language. Continue in the new language immediately after calling.',
        parameters: {
          type: 'object',
          properties: {
            language: { type: 'string', description: 'Target language code, e.g. "es", "fr", "ja".' }
          },
          required: ['language']
        }
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const language = typeof args['language'] === 'string' ? args['language'].toLowerCase().substring(0, 10) : '';
        if (!language || !ctx.sessionId) return { error: 'language and session context are required' };
        const { getSystemConfig } = await import('../utils/sessionHelpers.js');
        const config = await getSystemConfig();
        const languages = (config.languages as { languages?: { value: string; label: string; enabled: boolean }[] } | undefined)?.languages ?? [];
        // The model tends to say bare codes ("es"); config uses regional ones
        // ("es-ES", "es-419") — exact match first, then prefix match.
        const enabled = languages.filter(l => l.enabled);
        const target =
          enabled.find(l => l.value.toLowerCase() === language) ??
          enabled.find(l => l.value.toLowerCase().startsWith(`${language}-`)) ??
          enabled.find(l => l.value.toLowerCase().split('-')[0] === language.split('-')[0]);
        if (!target) {
          return { error: `Language '${language}' is not available`, available: enabled.map(l => l.value) };
        }
        // Push the change into the LIVE session config too (ai-therapist-112):
        // previously only the DB row changed, so the running OpenAI session
        // kept its original-language instructions and the model was merely
        // asked to comply. Append a language-override block to the session's
        // stored instructions (replacing any earlier override so repeated
        // switches don't stack) and session.update over the sideband.
        const LANG_OVERRIDE_MARKER = '\n\n[LANGUAGE OVERRIDE]';
        let liveUpdated = false;
        const cfg = await pool.query<{ instructions: string | null }>(
          'SELECT instructions FROM session_configurations WHERE session_id = $1',
          [ctx.sessionId]
        );
        const baseInstructions = cfg.rows[0]?.instructions;
        let newInstructions: string | null = null;
        if (baseInstructions) {
          const markerIdx = baseInstructions.indexOf(LANG_OVERRIDE_MARKER);
          const withoutOverride = markerIdx >= 0 ? baseInstructions.slice(0, markerIdx) : baseInstructions;
          newInstructions =
            withoutOverride +
            `${LANG_OVERRIDE_MARKER} The participant has switched languages mid-session. ` +
            `Conduct the rest of this session entirely in ${target.label}, including all tool narration and your closing.`;
          try {
            const { sidebandManager } = await import('./sidebandManager.service.js');
            if (sidebandManager.isConnected(ctx.sessionId)) {
              await sidebandManager.updateSession(ctx.sessionId, { instructions: newInstructions });
              liveUpdated = true;
            }
          } catch (err) {
            console.error('[switch_language] live session.update failed (guidance-only fallback):', err);
          }
        }
        await pool.query(
          'UPDATE session_configurations SET language = $2, instructions = COALESCE($3, instructions) WHERE session_id = $1',
          [ctx.sessionId, target.value, newInstructions]
        );
        return {
          success: true,
          language: target.label,
          live_config_updated: liveUpdated,
          guidance: `Continue the conversation entirely in ${target.label} from your next sentence. Keep the same warmth and approach.`
        };
      }
    );

    // Brief validated screeners (PHQ-2 / GAD-2). Client renders the form and
    // posts answers to /api/sessions/:id/scale-response.
    this.registerTool(
      'administer_scale',
      {
        type: 'function',
        name: 'administer_scale',
        description: 'Present a brief 2-question validated check-in form on the participant\'s screen: phq2 (mood) or gad2 (anxiety). These are screeners, not diagnoses. Ask permission first ("mind if I ask two quick standard questions?"). At most one scale per session unless the participant asks.',
        parameters: {
          type: 'object',
          properties: {
            scale: { type: 'string', enum: ['phq2', 'gad2'], description: 'Which screener to present.' }
          },
          required: ['scale']
        }
      },
      async (args: Record<string, unknown>) => {
        const { SCALES } = await import('../utils/scales.js');
        const scale = SCALES[args['scale'] as string];
        if (!scale) return { error: 'Unknown scale', available: Object.keys(SCALES) };
        return {
          success: true,
          scale: scale.id,
          guidance: `The ${scale.name} form is on the participant's screen. Wait quietly while they answer; you will receive the result. Respond supportively to the answers — never announce a score as a diagnosis.`
        };
      }
    );

    // Research bookmark: the invocation log IS the storage; a transcript
    // marker anchors it in context for later qualitative review.
    this.registerTool(
      'flag_notable_moment',
      {
        type: 'function',
        name: 'flag_notable_moment',
        description: 'Silently bookmark a conversationally significant moment for the research team: a breakthrough, a technique clearly landing or failing, strong resistance, or an unexpected turn. The participant never sees this. Use sparingly (a few per session at most).',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['breakthrough', 'technique_worked', 'technique_failed', 'resistance', 'disclosure', 'other'],
              description: 'What kind of moment this is.'
            },
            reason: { type: 'string', description: 'One sentence on why it is notable.' }
          },
          required: ['category', 'reason']
        }
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const { insertMessagesBatch } = await import('../db/index.js');
        await insertMessagesBatch([{
          session_id: ctx.sessionId,
          role: 'system',
          message_type: 'notable_moment',
          content: `[${args['category']}] ${args['reason']}`,
          content_redacted: `[${args['category']}] ${args['reason']}`,
          metadata: { category: args['category'], reason: args['reason'] },
        }]);
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'session:notable-moment', {
            sessionId: ctx.sessionId, category: args['category'], reason: args['reason'], flaggedAt: new Date(),
          }, ctx.sessionId);
        }
        return { success: true, note: 'Bookmarked. Do not mention this to the participant.' };
      }
    );

    // Tool 22: Grounded psychoeducation retrieval (RAG over a vetted, evidence-
    // based corpus in pgvector; see migration 031 + ingestKnowledge.js). The
    // guardrails in the description + returned guidance are load-bearing: the
    // model must ground claims/citations in the returned passages, never invent
    // them. Safe to leave registered even before the corpus is ingested — any
    // failure (missing table, embed error, empty corpus) returns a graceful,
    // no-fabrication message rather than throwing.
    this.registerTool(
      'retrieve_psychoeducation',
      {
        type: 'function',
        name: 'retrieve_psychoeducation',
        description:
          'Retrieve vetted, evidence-based psychoeducation passages from the clinical knowledge base to ground an explanation. Use when the participant asks what a condition is, why they might feel a certain way, or how a coping technique or therapy works. Summarize the returned passages in warm, plain language and mention the source. Do NOT state clinical facts, statistics, or citations that are not present in the returned passages.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What to look up, in natural language (e.g. "why does CBT help with anxiety").',
            },
            topic: {
              type: 'string',
              description: 'Optional coarse filter, e.g. "depression", "anxiety", "coping".',
            },
          },
          required: ['query'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
        if (!query) return { error: 'query text is required' };
        const topic = typeof args['topic'] === 'string' && args['topic'].trim()
          ? args['topic'].trim()
          : null;

        try {
          const { embedText } = await import('./embeddings.service.js');
          const { searchKnowledgeChunks } = await import('../db/index.js');
          const embedding = await embedText(query);
          // Widen the vector candidate set, then LLM-rerank down to the 3 that
          // most directly answer the query (ai-therapist-88).
          const candidates = await searchKnowledgeChunks(embedding, { kind: 'psychoeducation', topic }, 8);

          if (candidates.length === 0) {
            return {
              results: [],
              guidance:
                'No matching passages in the knowledge base. Rely on general supportive knowledge, keep it brief, and do NOT invent citations, statistics, or specific clinical claims.',
            };
          }

          const { rerankChunks } = await import('./rerank.service.js');
          const { chunks: rows } = await rerankChunks(query, candidates, 3, {
            sessionId: ctx.sessionId ?? null, toolName: 'retrieve_psychoeducation',
          });

          return {
            results: rows.map(r => ({
              title: r.title,
              content: r.content,
              source: r.source,
              source_url: r.source_url,
            })),
            guidance:
              'Summarize these passages for the participant in warm, plain language and mention the source. Do NOT add clinical claims or citations beyond what is shown here.',
          };
        } catch (error) {
          console.error('[ToolRegistry] retrieve_psychoeducation failed:', error);
          return {
            error:
              'The knowledge base is unavailable right now. Continue supporting the participant without it, and do not invent citations.',
          };
        }
      }
    );

    // Tool 23: Semantic recall over the participant's OWN remembered facts
    // (ai-therapist-66). Consent-gated like recall_previous_sessions, but
    // retrieves by meaning instead of dumping everything. Only embedded memories
    // (stored via remember_this after migration 032) are searchable.
    this.registerTool(
      'recall_relevant_history',
      {
        type: 'function',
        name: 'recall_relevant_history',
        description:
          "Semantically search THIS participant's own remembered facts from past conversations for ones relevant to a topic (only for logged-in participants with session memory on). Use when they reference something from before or when specific past context would help — more targeted than recall_previous_sessions.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for, e.g. "their sister" or "sleep problems".' },
          },
          required: ['query'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
        if (!query) return { error: 'query text is required' };
        if (!ctx.sessionId) return { error: 'No session context available' };

        const { getSession, getUserMemoryEnabled, searchUserMemories } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (!userId) return { available: false, reason: 'Participant is anonymous — no saved history.' };
        if (!(await getUserMemoryEnabled(userId))) {
          return { available: false, reason: 'Participant has not opted into session memory. Do not press them about it.' };
        }

        try {
          const { embedText } = await import('./embeddings.service.js');
          const embedding = await embedText(query);
          const rows = await searchUserMemories(userId, embedding, 5);
          if (rows.length === 0) {
            return {
              available: true,
              memories: [],
              note: 'Nothing relevant found in what they asked you to remember. Do NOT fabricate past details.',
            };
          }
          return {
            available: true,
            memories: rows.map(r => ({ fact: r.fact, when: r.created_at.toISOString().slice(0, 10) })),
            note: 'Use for continuity and warmth. Never claim to remember more than these facts.',
          };
        } catch (error) {
          console.error('[ToolRegistry] recall_relevant_history failed:', error);
          return { error: 'Could not search history right now. Continue without it; do not invent past details.' };
        }
      }
    );

    // Tool 24: Find the best-fitting worksheet for a concern, then hand off to a
    // render tool (ai-therapist-68). RAG over kind='worksheet'; the matched row's
    // metadata says which existing render tool to call.
    this.registerTool(
      'find_worksheet',
      {
        type: 'function',
        name: 'find_worksheet',
        description:
          "Find the most fitting therapeutic worksheet/exercise for what the participant is working on, then follow its instructions to open it on their screen. Use when a written exercise would help. After calling this, call the render tool it returns (start_thought_record or show_journaling_prompt).",
        parameters: {
          type: 'object',
          properties: {
            concern: { type: 'string', description: 'What they want to work on, e.g. "a harsh self-critical thought" or "grief about a breakup".' },
          },
          required: ['concern'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const concern = typeof args['concern'] === 'string' ? args['concern'].trim() : '';
        if (!concern) return { error: 'concern text is required' };
        try {
          const { embedText } = await import('./embeddings.service.js');
          const { searchKnowledgeChunks } = await import('../db/index.js');
          const embedding = await embedText(concern);
          // Widen to 5 vector candidates, then LLM-rerank to the single best fit.
          const candidates = await searchKnowledgeChunks(embedding, { kind: 'worksheet' }, 5);
          if (candidates.length === 0) {
            return {
              found: false,
              guidance: 'No matching worksheet found. You can still open a blank thought record (start_thought_record) or offer a journaling prompt (show_journaling_prompt) if it would help. Do not invent a named worksheet.',
            };
          }
          const { rerankChunks } = await import('./rerank.service.js');
          const { chunks: rows } = await rerankChunks(concern, candidates, 1, {
            sessionId: ctx.sessionId ?? null, toolName: 'find_worksheet',
          });
          const w = rows[0];
          const meta = (w.metadata ?? {}) as { render_tool?: string; prompt?: string };
          const renderTool = meta.render_tool === 'start_thought_record' ? 'start_thought_record' : 'show_journaling_prompt';
          return {
            found: true,
            template_id: w.chunk_id,
            title: w.title,
            rationale: w.content,
            source: w.source,
            render_tool: renderTool,
            suggested_prompt: meta.prompt ?? null,
            guidance: `This worksheet fits. Briefly introduce it in your own warm words, then call ${renderTool}${meta.prompt ? ` with prompt: "${meta.prompt}"` : ''}. Do not invent worksheet content beyond this. ` +
              `If personalizing the wording to what the participant just told you would help more than the generic form, you may instead call create_custom_worksheet with template_id ${w.chunk_id}, keeping the same number and kind of sections as this template.`,
          };
        } catch (error) {
          console.error('[ToolRegistry] find_worksheet failed:', error);
          return { error: 'The worksheet library is unavailable right now. Offer a blank thought record or journaling prompt instead if useful.' };
        }
      }
    );

    // Tool 25: Suggest a technique matching the session's active modality
    // (ai-therapist-70), grounded in the technique corpus. Prefers techniques
    // tagged for the active approach; falls back to any if none match.
    this.registerTool(
      'suggest_modality_technique',
      {
        type: 'function',
        name: 'suggest_modality_technique',
        description:
          "Suggest a specific therapeutic technique that fits the session's active approach (CBT/ACT/MI/supportive) and the participant's current concern, grounded in the clinical knowledge base. Use when you want a concrete, approach-consistent technique to offer.",
        parameters: {
          type: 'object',
          properties: {
            concern: { type: 'string', description: 'The current focus, e.g. "avoiding social situations".' },
          },
          required: ['concern'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        const concern = typeof args['concern'] === 'string' ? args['concern'].trim() : '';
        if (!concern) return { error: 'concern text is required' };
        try {
          const { getActiveModality } = await import('../utils/sessionHelpers.js');
          const { embedText } = await import('./embeddings.service.js');
          const { searchKnowledgeChunks } = await import('../db/index.js');
          const modality = await getActiveModality();
          const modalityKey = modality?.key ?? null;
          const label = modality?.preset.label ? `${modality.preset.label}: ` : '';
          const embedding = await embedText(`${label}${concern}`);

          // Prefer the active modality's techniques; fall back to any technique.
          // Widen to 5 vector candidates, then LLM-rerank to the single best fit.
          let candidates = await searchKnowledgeChunks(embedding, { kind: 'technique', modality: modalityKey }, 5);
          if (candidates.length === 0) {
            candidates = await searchKnowledgeChunks(embedding, { kind: 'technique' }, 5);
          }
          if (candidates.length === 0) {
            return {
              found: false,
              guidance: 'No matching technique in the library. Offer support in your own words consistent with the approach; do not invent named techniques or cite sources.',
            };
          }
          const { rerankChunks } = await import('./rerank.service.js');
          const { chunks: rows } = await rerankChunks(concern, candidates, 1, {
            sessionId: ctx.sessionId ?? null, toolName: 'suggest_modality_technique',
          });
          const t = rows[0];
          return {
            found: true,
            technique: t.title,
            how_to: t.content,
            approach: t.modality ?? 'general',
            source: t.source,
            guidance: 'Offer this technique in warm, plain language, matched to the active approach and to what the participant said. Do not add steps or citations beyond what is shown here.',
          };
        } catch (error) {
          console.error('[ToolRegistry] suggest_modality_technique failed:', error);
          return { error: 'The technique library is unavailable right now. Continue supportively in your own words without naming a specific technique or source.' };
        }
      }
    );

    // Tools 26-28: interactive on-screen experiences (client renders the widget
    // from the same data-channel event; the server just guides the model). Two
    // return the participant's input to the model as an invisible message.
    this.registerTool(
      'start_body_scan',
      {
        type: 'function',
        name: 'start_body_scan',
        description: 'Start a guided body-scan relaxation on the participant\'s screen — attention moves gently from feet to head, softening each area. Use when they feel tense, wired, or want to relax. Ask first, then narrate slowly alongside the visual.',
        parameters: {
          type: 'object',
          properties: {
            duration_seconds: { type: 'number', description: 'Total length, 30-300 seconds (default 120).' },
          },
          required: [],
        },
      },
      async () => ({
        success: true,
        guidance: 'A guided body-scan is now on the participant\'s screen, advancing through body regions on its own. Narrate slowly and calmly in time with it; leave silences. When it ends, ask how their body feels now.',
      })
    );

    this.registerTool(
      'start_values_sort',
      {
        type: 'function',
        name: 'start_values_sort',
        description: 'Open an ACT values card-sort on the participant\'s screen: they tap the values that matter most to them. Use when exploring what gives their life meaning or direction, or when they feel stuck or disconnected. You will receive their choices when they finish.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async () => ({
        success: true,
        guidance: 'A values card-sort is on the participant\'s screen. Give them quiet time to choose. When they finish you\'ll receive the values they picked — reflect those back warmly and help them find one small values-aligned step.',
      })
    );

    this.registerTool(
      'start_fear_ladder',
      {
        type: 'function',
        name: 'start_fear_ladder',
        description: 'Open a fear-ladder builder on the participant\'s screen: they list situations they avoid and rate the distress of each. Use when working on avoidance or planning graded exposure. You will receive the ranked ladder (easiest to hardest) when they finish.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async () => ({
        success: true,
        guidance: 'A fear-ladder builder is on the participant\'s screen. Let them fill it in. When they finish you\'ll receive their situations ranked easiest to hardest — affirm the effort and, only if they\'re willing, offer the lowest rung as a first step.',
      })
    );

    // Tool 29: Follow-through check on last session's assigned practice
    // (ai-therapist-67). Consent-gated like recall_previous_sessions.
    this.registerTool(
      'review_practice',
      {
        type: 'function',
        name: 'review_practice',
        description: "Look up what the participant was asked to practice or work on after their last session — a thought record, a safety plan, or similar — so you can ask how it went. Only works for logged-in participants with session memory on.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const { getSession, getUserMemoryEnabled, getUserLatestThoughtRecord, getUserLatestSafetyPlan, listUserAssignments } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (!userId) return { available: false, reason: 'Participant is anonymous — no session history exists.' };
        if (!(await getUserMemoryEnabled(userId))) {
          return { available: false, reason: 'Participant has not opted into session memory. Do not press them about it.' };
        }
        const [thoughtRecord, safetyPlan, openAssignments] = await Promise.all([
          getUserLatestThoughtRecord(userId),
          getUserLatestSafetyPlan(userId),
          listUserAssignments(userId, { status: 'assigned', limit: 5 }),
        ]);
        if (!thoughtRecord && !safetyPlan && openAssignments.length === 0) {
          return { available: true, practice: null, note: 'No recorded practice from a previous session — do not invent one.' };
        }
        return {
          available: true,
          thought_record: thoughtRecord?.record.balanced_thought
            ? { balanced_thought: thoughtRecord.record.balanced_thought, when: thoughtRecord.created_at.toISOString().slice(0, 10) }
            : null,
          has_safety_plan: !!safetyPlan,
          // Assigned via assign_practice and not yet marked done by the participant.
          open_assignments: openAssignments.map(a => ({
            title: a.title,
            kind: a.kind,
            suggested_frequency: a.suggested_frequency,
            assigned: a.assigned_at.toISOString().slice(0, 10),
          })),
          note: 'Ask how it went in your own warm words. Do not read this back verbatim or claim more detail than shown here.',
        };
      }
    );

    // Tool 32b: forward-looking practice (ai-therapist-123) — the counterpart
    // to review_practice. Stores a small agreed between-session practice that
    // the participant sees on their progress home and can mark done there;
    // open ones resurface in the next session's prompt block.
    this.registerTool(
      'assign_practice',
      {
        type: 'function',
        name: 'assign_practice',
        description: 'Assign a small, concrete between-session practice the participant agreed to. Only after discussing it with them. One assignment per topic.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short name for the practice, in plain words (e.g. "Two-minute breathing before bed").' },
            description: { type: 'string', description: 'What to actually do, phrased close to how you agreed on it together. One or two sentences.' },
            kind: { type: 'string', enum: ['worksheet', 'exercise', 'observation', 'custom'], description: 'What kind of practice this is.' },
            suggested_frequency: { type: 'string', description: 'How often, if you agreed on one (e.g. "daily", "when the worry shows up").' },
          },
          required: ['title', 'description'],
        },
        channel: 'both',
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const title = typeof args['title'] === 'string' ? args['title'].trim().substring(0, 200) : '';
        const description = typeof args['description'] === 'string' ? args['description'].trim().substring(0, 1000) : '';
        if (!title || !description) return { error: 'title and description are both required' };
        const kinds = ['worksheet', 'exercise', 'observation', 'custom'] as const;
        const kind = kinds.find(k => k === args['kind']) ?? 'custom';
        const suggestedFrequency = typeof args['suggested_frequency'] === 'string'
          ? args['suggested_frequency'].trim().substring(0, 200) || null
          : null;

        const { getSession, insertPracticeAssignment } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (!userId) {
          return { assigned: false, reason: 'Participant is anonymous — practice assignments need an account. Suggest the practice verbally instead.' };
        }
        await insertPracticeAssignment({
          userId,
          sessionId: ctx.sessionId,
          title,
          description,
          kind,
          suggestedFrequency,
        });
        return { assigned: true, title };
      }
    );

    // Tool 30: This session's PHQ-2/GAD-2 vs their previous one (ai-therapist-69).
    this.registerTool(
      'compare_screener_trend',
      {
        type: 'function',
        name: 'compare_screener_trend',
        description: 'Compare this session\'s PHQ-2/GAD-2 screener result (after administer_scale finishes) to the participant\'s previous one, with direction. Only works for logged-in participants with session memory on.',
        parameters: {
          type: 'object',
          properties: {
            scale: { type: 'string', enum: ['phq2', 'gad2'], description: 'Which screener to compare.' },
          },
          required: ['scale'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const scale = args['scale'] as string;
        if (scale !== 'phq2' && scale !== 'gad2') return { error: 'Unknown scale', available: ['phq2', 'gad2'] };

        const { getSession, getUserMemoryEnabled, getSessionScaleResponses, getUserLatestScaleScore } = await import('../db/index.js');
        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (!userId) return { available: false, reason: 'Participant is anonymous — no prior screeners on record.' };
        if (!(await getUserMemoryEnabled(userId))) {
          return { available: false, reason: 'Participant has not opted into session memory. Do not press them about it.' };
        }

        const thisSessionResponses = (await getSessionScaleResponses(ctx.sessionId)).filter(r => r.scale === scale);
        const current = thisSessionResponses[thisSessionResponses.length - 1];
        if (!current) {
          return { available: false, reason: `No ${scale.toUpperCase()} response recorded yet this session — call administer_scale first.` };
        }
        const previous = await getUserLatestScaleScore(userId, scale, ctx.sessionId);
        if (!previous) {
          return { available: true, current_score: current.score, previous_score: null, direction: null, note: 'First time this screener has been recorded — no trend yet.' };
        }
        const delta = current.score - previous.score;
        const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';
        return {
          available: true,
          scale,
          current_score: current.score,
          previous_score: previous.score,
          direction,
          note: 'These are screeners, not diagnoses — respond supportively in plain language, never announce a "diagnosis".',
        };
      }
    );

    // Tool 31: Surface an existing safety plan mid-session (ai-therapist-72),
    // e.g. when risk appears to be rising, before offering to build a new one.
    this.registerTool(
      'retrieve_safety_plan',
      {
        type: 'function',
        name: 'retrieve_safety_plan',
        description: 'Check whether the participant already has a safety plan — from this session or (for logged-in, memory-consented participants) a previous one — before offering to build a new one with create_safety_plan.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async (_args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };
        const { getSession, getSessionSafetyPlan, getUserMemoryEnabled, getUserLatestSafetyPlan } = await import('../db/index.js');

        const own = await getSessionSafetyPlan(ctx.sessionId);
        if (own) {
          return { available: true, source: 'this_session', plan: own.plan, created_at: own.created_at.toISOString().slice(0, 10) };
        }

        const session = await getSession(ctx.sessionId);
        const userId = session?.user_id;
        if (userId && (await getUserMemoryEnabled(userId))) {
          const prior = await getUserLatestSafetyPlan(userId);
          if (prior) {
            return { available: true, source: 'previous_session', plan: prior.plan, created_at: prior.created_at.toISOString().slice(0, 10) };
          }
        }
        return { available: false, reason: 'No safety plan exists yet. If risk is elevated, consider building one together with create_safety_plan.' };
      }
    );

    // Tool 32: Personalized worksheet generation within a vetted template's
    // structure (ai-therapist-73). find_worksheet retrieves the template
    // (structure + evidence base); this tool lets the model personalize the
    // wording while the handler enforces the template's section
    // count/types so the model cannot invent structure outside the vetted
    // corpus. The client renders it like start_thought_record; the
    // generated instance is stored for researcher review/promotion.
    this.registerTool(
      'create_custom_worksheet',
      {
        type: 'function',
        name: 'create_custom_worksheet',
        description:
          'Generate a worksheet personalized to what the participant just told you, WITHIN the structure of a vetted template retrieved from find_worksheet. Call find_worksheet first to get a template_id. Keep the same number and kind of sections as the template — only wording (title, intro, prompt labels) may be personalized. After calling this, the worksheet opens on the participant\'s screen; you will receive their answers when they finish.',
        parameters: {
          type: 'object',
          properties: {
            template_id: { type: 'number', description: 'The template_id returned by find_worksheet.' },
            title: { type: 'string', description: 'Personalized worksheet title (short).' },
            intro: { type: 'string', description: 'One or two warm sentences introducing the worksheet, referencing what they told you.' },
            sections: {
              type: 'array',
              description: 'Ordered prompts/sections, matching the template\'s structure exactly in count and type.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['text', 'textarea', 'scale'], description: 'Input type: text = short answer, textarea = longer writing, scale = 0-100 slider.' },
                  label: { type: 'string', description: 'The personalized prompt/question for this section.' },
                  placeholder: { type: 'string', description: 'Optional short example/placeholder text.' },
                },
                required: ['type', 'label'],
              },
            },
          },
          required: ['template_id', 'title', 'sections'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };

        const templateId = Number(args['template_id']);
        if (!Number.isFinite(templateId)) return { error: 'template_id is required — call find_worksheet first to get one' };

        const title = typeof args['title'] === 'string' ? args['title'].trim().substring(0, 200) : '';
        const intro = typeof args['intro'] === 'string' ? args['intro'].trim().substring(0, 500) : null;
        if (!title) return { error: 'title is required' };

        const rawSections = Array.isArray(args['sections']) ? args['sections'] : [];
        const ALLOWED_TYPES = new Set(['text', 'textarea', 'scale']);
        const sections = rawSections
          .map((s) => {
            if (typeof s !== 'object' || s === null) return null;
            const rec = s as Record<string, unknown>;
            const type = typeof rec['type'] === 'string' ? rec['type'] : '';
            const label = typeof rec['label'] === 'string' ? rec['label'].trim().substring(0, 300) : '';
            const placeholder = typeof rec['placeholder'] === 'string' ? rec['placeholder'].trim().substring(0, 150) : undefined;
            if (!ALLOWED_TYPES.has(type) || !label) return null;
            return { type: type as 'text' | 'textarea' | 'scale', label, ...(placeholder ? { placeholder } : {}) };
          })
          .filter((s): s is { type: 'text' | 'textarea' | 'scale'; label: string; placeholder?: string } => s !== null);

        if (sections.length === 0) {
          return { error: 'At least one valid section (type + label) is required' };
        }

        try {
          const { getKnowledgeChunkById, insertWorksheetInstance } = await import('../db/index.js');
          const template = await getKnowledgeChunkById(templateId);
          if (!template || template.kind !== 'worksheet' || !template.active) {
            return { error: 'Unknown or inactive worksheet template. Call find_worksheet again to get a valid template_id.' };
          }

          // Enforce the vetted template's structure: the model may personalize
          // wording, never invent sections beyond what the template specifies.
          const meta = (template.metadata ?? {}) as { sections?: Array<{ type?: string }>; max_sections?: number };
          if (Array.isArray(meta.sections) && meta.sections.length > 0) {
            if (sections.length !== meta.sections.length) {
              return {
                error: `This template has exactly ${meta.sections.length} section(s); you supplied ${sections.length}. Match the template's structure — only personalize the wording.`,
              };
            }
            for (let i = 0; i < sections.length; i++) {
              const expectedType = meta.sections[i]?.type;
              if (expectedType && sections[i].type !== expectedType) {
                return {
                  error: `Section ${i + 1} must be type "${expectedType}" per the template; got "${sections[i].type}". Only wording may be personalized, not structure.`,
                };
              }
            }
          } else {
            // No structured metadata on this template — fall back to generic
            // sane bounds so an unstructured/legacy template can't be abused
            // into an arbitrarily long or oddly-typed form.
            const maxSections = meta.max_sections ?? 6;
            if (sections.length > maxSections) {
              return { error: `Too many sections (max ${maxSections} for this template).` };
            }
          }

          const instanceId = await insertWorksheetInstance({
            sessionId: ctx.sessionId,
            templateChunkId: template.chunk_id,
            templateTitle: template.title,
            title,
            intro,
            sections,
          });

          if (global.io) {
            void broadcastAdminEventForSession(global.io, 'session:worksheet-created', {
              sessionId: ctx.sessionId, instanceId, templateId: template.chunk_id, createdAt: new Date(),
            }, ctx.sessionId);
          }

          return {
            success: true,
            instance_id: instanceId,
            title,
            intro,
            sections,
            guidance: 'The personalized worksheet is now on the participant\'s screen. Stay quiet or offer brief encouragement while they fill it in; when they finish you will receive their answers — respond to what they wrote, not the form itself.',
          };
        } catch (error) {
          console.error('[ToolRegistry] create_custom_worksheet failed:', error);
          return { error: 'Could not create the personalized worksheet right now. Fall back to find_worksheet\'s standard render tool instead.' };
        }
      }
    );

    // Tool 33: Explicit laddered risk assessment logging (ai-therapist-71).
    // The C-SSRS-style laddered guidance already exists as sideband instruction
    // (crisisIntervention.service SAFETY_PROTOCOL_GUIDANCE); this tool gives the
    // study clean, structured data on how far an assessment progressed and what
    // band it resolved to. It complements — never replaces — the automatic
    // crisis-detection pipeline (crisisDetection.service.ts).
    this.registerTool(
      'run_risk_check',
      {
        type: 'function',
        name: 'run_risk_check',
        description:
          'Log one step of a structured, C-SSRS-style safety assessment ladder (ideation → plan → means → timeframe → intent, or protective_factors) after asking the participant that question directly. Use during a safety assessment to record clean data on assessment progression — this does not replace your clinical judgment or the automatic crisis protocol, only documents it. Ask one question at a time; call this after each answer.',
        parameters: {
          type: 'object',
          properties: {
            step: {
              type: 'string',
              enum: ['ideation', 'plan', 'means', 'timeframe', 'intent', 'protective_factors'],
              description: 'Which ladder question this answer is for.',
            },
            answer: { type: 'string', description: "The participant's answer, close to their own words." },
            risk_band: {
              type: 'string',
              enum: ['none', 'low', 'moderate', 'high', 'imminent'],
              description: 'Your clinical read of risk after this answer.',
            },
          },
          required: ['step', 'answer', 'risk_band'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { error: 'No session context available' };

        const STEPS = new Set(['ideation', 'plan', 'means', 'timeframe', 'intent', 'protective_factors']);
        const BANDS = new Set(['none', 'low', 'moderate', 'high', 'imminent']);
        const step = typeof args['step'] === 'string' ? args['step'] : '';
        const riskBand = typeof args['risk_band'] === 'string' ? args['risk_band'] : '';
        const answer = typeof args['answer'] === 'string' ? args['answer'].trim().substring(0, 1000) : '';

        if (!STEPS.has(step)) return { error: 'step must be one of ideation, plan, means, timeframe, intent, protective_factors' };
        if (!BANDS.has(riskBand)) return { error: 'risk_band must be one of none, low, moderate, high, imminent' };
        if (!answer) return { error: 'answer text is required' };

        try {
          const { insertRiskCheckStep, getRiskCheckSteps, getLatestCrisisEventId } = await import('../db/index.js');
          const [priorSteps, crisisEventId] = await Promise.all([
            getRiskCheckSteps(ctx.sessionId),
            getLatestCrisisEventId(ctx.sessionId),
          ]);

          await insertRiskCheckStep({
            sessionId: ctx.sessionId,
            crisisEventId,
            step: step as 'ideation' | 'plan' | 'means' | 'timeframe' | 'intent' | 'protective_factors',
            answer,
            riskBand: riskBand as 'none' | 'low' | 'moderate' | 'high' | 'imminent',
            sequence: priorSteps.length + 1,
          });

          if (global.io) {
            void broadcastAdminEventForSession(global.io, 'session:risk-check-step', {
              sessionId: ctx.sessionId, step, riskBand, loggedAt: new Date(),
            }, ctx.sessionId);
          }

          return {
            success: true,
            logged: { step, risk_band: riskBand },
            guidance: 'Step logged. Continue the ladder gently, one question at a time, or if you have enough information, move to safety planning or your crisis protocol as clinically indicated.',
          };
        } catch (error) {
          console.error('[ToolRegistry] run_risk_check failed:', error);
          return { error: 'Could not log this step right now. Continue the assessment verbally and follow your crisis protocol.' };
        }
      }
    );

    // Tool 34: Uninterruptible moment (ai-therapist-102). Does NOT mute the
    // participant's microphone — it only disables server-side turn detection
    // over the sideband for a few seconds, so their speech won't cancel the
    // model's response while it delivers something important. Refused while a
    // high-severity crisis flag is active (the participant must always be able
    // to interrupt during a crisis) and outside realtime sessions (no sideband).
    this.registerTool(
      'hold_floor',
      {
        type: 'function',
        name: 'hold_floor',
        description:
          "Briefly prevent your speech from being interrupted while you deliver something important (a safety message, a key insight). The participant's microphone stays on; their speech simply won't cut you off. Use sparingly.",
        parameters: {
          type: 'object',
          properties: {
            seconds: { type: 'number', description: 'How long to hold the floor, 1-20 seconds.' },
            reason: { type: 'string', description: 'One short sentence: why this moment must not be interrupted.' },
          },
          required: ['seconds', 'reason'],
        },
      },
      async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx.sessionId) return { held: false, reason: 'not-available' };

        // Realtime only: without a live sideband there is no turn detection to
        // suppress (chat sessions, or the sideband dropped).
        const { sidebandManager } = await import('./sidebandManager.service.js');
        if (!sidebandManager.isConnected(ctx.sessionId)) {
          return { held: false, reason: 'not-available' };
        }

        const rawSeconds = Number(args['seconds']);
        const seconds = Math.min(Math.max(Number.isFinite(rawSeconds) ? rawSeconds : 10, 1), 20);

        // Never hold the floor during an active high-severity crisis — the
        // participant must always be able to interrupt. A failed lookup also
        // refuses: err on the side of interruptibility.
        try {
          const { getSessionCrisisState } = await import('../db/index.js');
          const crisis = await getSessionCrisisState(ctx.sessionId);
          if (crisis?.crisis_flagged && crisis.crisis_severity === 'high') {
            return { held: false, reason: 'crisis-active' };
          }
        } catch (error) {
          console.error('[ToolRegistry] hold_floor crisis check failed (refusing hold):', error);
          return { held: false, reason: 'not-available' };
        }

        try {
          await sidebandManager.holdFloor(ctx.sessionId, seconds);
        } catch (error) {
          console.error('[ToolRegistry] hold_floor failed:', error);
          return { held: false, reason: 'not-available' };
        }

        return {
          held: true,
          seconds,
          guidance: `You have the floor for about ${seconds} seconds — the participant's speech will not cut you off, but they can still hear and speak. Deliver the important message calmly, then pause and invite their response; normal turn-taking resumes automatically.`,
        };
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
