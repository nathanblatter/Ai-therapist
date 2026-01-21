/**
 * Sideband WebSocket Manager
 * Manages server-side WebSocket connections to OpenAI Realtime API for monitoring and control
 */

import WebSocket from 'ws';
import { pool } from '../config/db.js';
import { insertMessagesBatch } from '../models/dbQueries.js';
import { getOpenAIKey } from '../config/secrets.js';

export class SidebandManager {
  constructor() {
    this.connections = new Map(); // sessionId → WebSocket
    this.reconnectAttempts = new Map(); // sessionId → attempt count
    this.maxReconnectAttempts = 3;
    this.reconnectDelayMs = 2000;
  }

  /**
   * Establish sideband WebSocket connection for a session
   * @param {string} sessionId - Therapy session ID
   * @param {string} callId - OpenAI call_id from Location header
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<WebSocket>} - The WebSocket connection
   */
  async connect(sessionId, callId, apiKey) {
    // Check if already connected
    if (this.connections.has(sessionId)) {
      console.warn(`[Sideband] Already connected for session ${sessionId.substring(0, 12)}...`);
      return this.connections.get(sessionId);
    }

    const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${callId}`;
    console.log(`[Sideband] Connecting to ${wsUrl}`);
    console.log(`[Sideband] Using call_id: ${callId}`);

    try {
      const ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      // Setup event handlers
      ws.on('open', () => this.handleOpen(sessionId, callId));
      ws.on('message', (data) => this.handleMessage(sessionId, data));
      ws.on('error', (error) => this.handleError(sessionId, error));
      ws.on('close', (code, reason) => this.handleClose(sessionId, code, reason));

      this.connections.set(sessionId, ws);
      this.reconnectAttempts.set(sessionId, 0);

      console.log(`[Sideband] Connected for session ${sessionId.substring(0, 12)}...`);
      return ws;

    } catch (error) {
      console.error(`[Sideband] Connection failed for session ${sessionId}:`, error);
      await this.logConnectionError(sessionId, error);
      throw error;
    }
  }

  /**
   * Handle WebSocket open event
   */
  async handleOpen(sessionId, callId) {
    try {
      // Update database
      await pool.query(
        `UPDATE therapy_sessions
         SET openai_call_id = $1,
             sideband_connected = TRUE,
             sideband_connected_at = CURRENT_TIMESTAMP,
             sideband_error = NULL
         WHERE session_id = $2`,
        [callId, sessionId]
      );

      // Emit to admins via Socket.io
      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:connected', {
          sessionId,
          callId,
          connectedAt: new Date()
        });
      }

      console.log(`[Sideband] Connection established for session ${sessionId.substring(0, 12)}...`);
    } catch (error) {
      console.error(`[Sideband] Error in handleOpen:`, error);
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  async handleMessage(sessionId, data) {
    try {
      const event = JSON.parse(data.toString());

      // Log event for debugging (minimal logging)
      if (event.type !== 'response.audio.delta' && event.type !== 'input_audio_buffer.speech_started') {
        console.log(`[Sideband] ${sessionId.substring(0, 12)}... Event: ${event.type}`);
      }

      // Handle specific events
      await this.handleEvent(sessionId, event);

    } catch (error) {
      console.error(`[Sideband] Message parse error:`, error);
    }
  }

  /**
   * Route events to appropriate handlers
   */
  async handleEvent(sessionId, event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        // Emit to admins (no DB logging to avoid bloat)
        if (global.io) {
          global.io.to('admin-broadcast').emit('session:openai-update', {
            sessionId,
            eventType: event.type,
            data: event
          });
        }
        break;

      case 'response.function_call_arguments.done':
        // Handle tool/function calls
        await this.handleToolCall(sessionId, event);
        break;

      case 'error':
        console.error(`[Sideband] OpenAI error for session ${sessionId}:`, event.error);
        await this.logError(sessionId, event.error);

        if (global.io) {
          global.io.to('admin-broadcast').emit('sideband:error', {
            sessionId,
            error: event.error
          });
        }
        break;

      case 'rate_limits.updated':
        // Monitor rate limits (log only, no action)
        console.log(`[Sideband] Rate limits for session ${sessionId}:`, event.rate_limits);
        break;

      default:
        // Other events - monitor in memory only
        break;
    }
  }

  /**
   * Handle tool/function call requests from OpenAI
   */
  async handleToolCall(sessionId, event) {
    const { call_id, name: toolName, arguments: argsString } = event;

    try {
      // Parse function arguments
      let args;
      try {
        args = JSON.parse(argsString);
      } catch (parseError) {
        console.error(`[Sideband] Failed to parse arguments:`, parseError);
        throw new Error(`Invalid function arguments: ${parseError.message}`);
      }

      // Log tool call to messages table
      await insertMessagesBatch([{
        sessionId,
        role: 'system',
        type: 'tool_call',
        message: `Tool called: ${toolName}`,
        metadata: {
          tool_name: toolName,
          call_id,
          arguments: args,
          status: 'executing'
        }
      }]);

      // Execute tool via registry
      const { toolRegistry } = await import('./toolRegistry.service.js');
      const result = await toolRegistry.executeTool(toolName, args);

      // Send response back to OpenAI
      const ws = this.connections.get(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Step 1: Add the function call output to the conversation
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id,
            output: JSON.stringify(result)
          }
        }));

        // Step 2: Trigger a response to process the function output
        ws.send(JSON.stringify({
          type: 'response.create'
        }));
      }

      // Log tool response to messages table
      await insertMessagesBatch([{
        sessionId,
        role: 'system',
        type: 'tool_response',
        message: `Tool response: ${toolName}`,
        metadata: {
          tool_name: toolName,
          call_id,
          response: result,
          status: 'completed'
        }
      }]);

      console.log(`[Sideband] Tool ${toolName} executed for session ${sessionId.substring(0, 12)}...`);

    } catch (error) {
      console.error(`[Sideband] Tool execution failed:`, error);

      // Send error response back to OpenAI
      const ws = this.connections.get(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Step 1: Add the error output to the conversation
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id,
            output: JSON.stringify({
              error: error.message,
              success: false
            })
          }
        }));

        // Step 2: Trigger a response to process the error output
        ws.send(JSON.stringify({
          type: 'response.create'
        }));
      }

      // Log error to messages table
      await insertMessagesBatch([{
        sessionId,
        role: 'system',
        type: 'tool_response',
        message: `Tool error: ${toolName}`,
        metadata: {
          tool_name: toolName,
          call_id,
          error: error.message,
          status: 'failed'
        }
      }]);
    }
  }

  /**
   * Update session configuration mid-session
   * @param {string} sessionId
   * @param {object} updates - { instructions?, tools?, temperature? }
   */
  async updateSession(sessionId, updates) {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Sideband connection not active');
    }

    const updateEvent = {
      type: 'session.update',
      session: updates
    };

    ws.send(JSON.stringify(updateEvent));

    console.log(`[Sideband] Session updated for ${sessionId.substring(0, 12)}...`);
  }

  /**
   * Handle WebSocket errors
   */
  async handleError(sessionId, error) {
    console.error(`[Sideband] WebSocket error for session ${sessionId.substring(0, 12)}...:`, error.message);

    await pool.query(
      `UPDATE therapy_sessions
       SET sideband_error = $1
       WHERE session_id = $2`,
      [error.message, sessionId]
    );

    // Emit error status to admin UI
    if (global.io) {
      global.io.to('admin-broadcast').emit('sideband:status-update', {
        sessionId,
        status: 'error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * Handle WebSocket close event
   */
  async handleClose(sessionId, code, reason) {
    console.log(`[Sideband] Connection closed for session ${sessionId.substring(0, 12)}...: ${code} - ${reason || 'No reason'}`);

    this.connections.delete(sessionId);

    try {
      await pool.query(
        `UPDATE therapy_sessions
         SET sideband_connected = FALSE,
             sideband_disconnected_at = CURRENT_TIMESTAMP
         WHERE session_id = $1`,
        [sessionId]
      );

      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:disconnected', {
          sessionId,
          code,
          reason: reason?.toString(),
          disconnectedAt: new Date()
        });
      }

      // Attempt reconnection if session still active and not exceeding max attempts
      const sessionStatus = await pool.query(
        'SELECT status FROM therapy_sessions WHERE session_id = $1',
        [sessionId]
      );

      // Attempt reconnection if session still active and not a normal close
      if (sessionStatus.rows[0]?.status === 'active' && code !== 1000) {
        const attempts = this.reconnectAttempts.get(sessionId) || 0;
        if (attempts < this.maxReconnectAttempts) {
          console.log(`[Sideband] Reconnection attempt ${attempts + 1}/${this.maxReconnectAttempts} for session ${sessionId.substring(0, 12)}...`);
          this.reconnectAttempts.set(sessionId, attempts + 1);

          setTimeout(async () => {
            try {
              const callIdResult = await pool.query(
                'SELECT openai_call_id FROM therapy_sessions WHERE session_id = $1',
                [sessionId]
              );
              const callId = callIdResult.rows[0]?.openai_call_id;
              if (callId) {
                // Get API key from AWS Secrets Manager
                const apiKey = await getOpenAIKey();
                await this.connect(sessionId, callId, apiKey);
              }
            } catch (error) {
              console.error('[Sideband] Reconnection failed:', error);
            }
          }, this.reconnectDelayMs * (attempts + 1));
        } else {
          console.error(`[Sideband] Max reconnection attempts reached for session ${sessionId.substring(0, 12)}...`);
        }
      }
    } catch (error) {
      console.error(`[Sideband] Error in handleClose:`, error);
    }
  }

  /**
   * Gracefully close sideband connection
   * @param {string} sessionId
   */
  async disconnect(sessionId) {
    const ws = this.connections.get(sessionId);
    if (ws) {
      console.log(`[Sideband] Disconnecting session ${sessionId.substring(0, 12)}...`);
      ws.close(1000, 'Session ended');
      this.connections.delete(sessionId);
      this.reconnectAttempts.delete(sessionId);
    }
  }

  /**
   * Log connection error to database
   */
  async logConnectionError(sessionId, error) {
    try {
      await pool.query(
        `UPDATE therapy_sessions
         SET sideband_error = $1,
             sideband_connected = FALSE
         WHERE session_id = $2`,
        [error.message, sessionId]
      );
    } catch (err) {
      console.error('[Sideband] Failed to log connection error:', err);
    }
  }

  /**
   * Log error to database
   */
  async logError(sessionId, error) {
    try {
      const errorMessage = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
      await pool.query(
        `UPDATE therapy_sessions
         SET sideband_error = $1
         WHERE session_id = $2`,
        [errorMessage, sessionId]
      );
    } catch (err) {
      console.error('[Sideband] Failed to log error:', err);
    }
  }

  /**
   * Get all active sideband connections
   * @returns {string[]} Array of session IDs with active connections
   */
  getActiveConnections() {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if session has active sideband connection
   * @param {string} sessionId
   * @returns {boolean}
   */
  isConnected(sessionId) {
    const ws = this.connections.get(sessionId);
    return ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Clean up all connections (called on server shutdown)
   */
  async shutdown() {
    console.log('[Sideband] Shutting down all sideband connections...');
    for (const [sessionId, ws] of this.connections.entries()) {
      ws.close(1000, 'Server shutdown');
      this.connections.delete(sessionId);
      this.reconnectAttempts.delete(sessionId);
    }
    console.log('[Sideband] All connections closed');
  }
}

// Singleton instance
export const sidebandManager = new SidebandManager();
