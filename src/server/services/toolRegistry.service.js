/**
 * Tool Registry Service
 * Centralized registry for OpenAI Realtime API function/tool definitions and handlers
 */

import { pool } from '../config/db.js';

export class ToolRegistry {
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
  registerTool(name, definition, handler) {
    this.tools.set(name, { definition, handler });
    console.log(`[ToolRegistry] Registered tool: ${name}`);
  }

  /**
   * Execute a registered tool
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @returns {Promise<object>} - Tool execution result
   */
  async executeTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      console.log(`[ToolRegistry] Executing tool: ${name}`);
      const result = await tool.handler(args);
      return result;
    } catch (error) {
      console.error(`[ToolRegistry] Tool execution error for ${name}:`, error);
      throw error;
    }
  }

  /**
   * Get all tool definitions for session configuration
   * @returns {array} Array of OpenAI function definitions
   */
  getAllToolDefinitions() {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  /**
   * Get list of registered tool names
   * @returns {string[]}
   */
  getToolNames() {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool is registered
   * @param {string} name
   * @returns {boolean}
   */
  hasTool(name) {
    return this.tools.has(name);
  }

  /**
   * Register default tools
   */
  registerDefaultTools() {
    // Tool 1: Get session summary
    this.registerTool(
      'get_session_summary',
      {
        type: 'function',
        name: 'get_session_summary',
        description: 'Get a summary of the current therapy session including duration, message count, and conversation statistics.',
        parameters: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The therapy session ID to summarize'
            }
          },
          required: ['session_id']
        }
      },
      async (args) => {
        const { session_id } = args;

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
        } catch (error) {
          console.error('[ToolRegistry] Error in get_session_summary:', error);
          return {
            error: 'Failed to retrieve session summary',
            details: error.message
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
      async (args) => {
        const { resource_type = 'all' } = args;

        const resources = {
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
        } else if (resources[resource_type]) {
          return {
            message: `Here is the ${resource_type.replace('_', ' ')} support resource:`,
            resource: resources[resource_type],
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

    console.log('[ToolRegistry] Default tools registered');
  }

  /**
   * Unregister a tool
   * @param {string} name
   * @returns {boolean} - true if tool was removed, false if not found
   */
  unregisterTool(name) {
    const deleted = this.tools.delete(name);
    if (deleted) {
      console.log(`[ToolRegistry] Unregistered tool: ${name}`);
    }
    return deleted;
  }

  /**
   * Clear all registered tools
   */
  clearAll() {
    this.tools.clear();
    console.log('[ToolRegistry] All tools cleared');
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
