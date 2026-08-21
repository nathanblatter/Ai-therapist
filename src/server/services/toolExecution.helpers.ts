/**
 * Shared tool-execution logging for non-sideband pipelines (ai-therapist-118).
 *
 * The realtime path logs every tool call the same three ways in
 * sidebandManager.handleToolCall: a `tool_call` messages row, the
 * tool_invocations analytics row, and admin `sideband:tool-call` socket
 * events, then a `tool_response` messages row. The chat pipeline needs
 * byte-identical records so downstream consumers (session detail transcript,
 * tool analytics, dataset export) see one shape regardless of channel.
 *
 * This module deliberately mirrors those writes rather than refactoring
 * sidebandManager (which is under concurrent change); only the chat path
 * uses it for now.
 */
import { insertMessagesBatch } from '../db/index.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

export interface ExecutedToolCall {
  /** Handler result on success, or an { error, success:false } envelope on failure. */
  result: unknown;
  success: boolean;
}

/**
 * Execute one model-requested tool call via the registry, logging the same
 * message rows / invocation analytics / admin events as the sideband path.
 * Never throws: a handler failure is captured as an error-envelope result so
 * the model gets a function_call_output either way (parity with the
 * sideband's catch branch).
 */
export async function executeLoggedToolCall(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  callId: string,
  channel: 'chat' | 'realtime' = 'chat',
): Promise<ExecutedToolCall> {
  // Log the call to the transcript (same shape as sidebandManager).
  await insertMessagesBatch([{
    session_id: sessionId,
    role: 'system',
    message_type: 'tool_call',
    content: `Tool called: ${toolName}`,
    content_redacted: null,
    metadata: { tool_name: toolName, call_id: callId, arguments: args, status: 'executing', channel },
  }]).catch(err => console.error('[ToolExecution] Failed to log tool_call message:', err));

  if (global.io) {
    void broadcastAdminEventForSession(global.io, 'sideband:tool-call', {
      sessionId, callId, toolName, args, status: 'executing', channel, timestamp: new Date(),
    }, sessionId);
  }

  try {
    const { toolRegistry } = await import('./toolRegistry.service.js');
    const result = await toolRegistry.executeTool(toolName, args, { sessionId, channel });

    // Invocation analytics (ai-therapist-32), stamped with the session's
    // current risk score inside the query — same as the sideband path.
    import('../db/index.js')
      .then(db => db.insertToolInvocation(sessionId, toolName, args, true))
      .catch(err => console.error('[ToolExecution] Failed to log tool invocation:', err));

    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'system',
      message_type: 'tool_response',
      content: `Tool response: ${toolName}`,
      content_redacted: null,
      metadata: { tool_name: toolName, call_id: callId, response: result, status: 'completed', channel },
    }]).catch(err => console.error('[ToolExecution] Failed to log tool_response message:', err));

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:tool-call', {
        sessionId, callId, toolName, args, result, status: 'completed', channel, timestamp: new Date(),
      }, sessionId);
    }

    return { result, success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ToolExecution] Tool ${toolName} failed for session ${sessionId.substring(0, 12)}...:`, error);

    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'system',
      message_type: 'tool_response',
      content: `Tool error: ${toolName}`,
      content_redacted: null,
      metadata: { tool_name: toolName, call_id: callId, error: errorMessage, status: 'failed', channel },
    }]).catch(err => console.error('[ToolExecution] Failed to log tool error message:', err));

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:tool-call', {
        sessionId, callId, toolName, error: errorMessage, status: 'failed', channel, timestamp: new Date(),
      }, sessionId);
    }

    import('../db/index.js')
      .then(db => db.insertToolInvocation(sessionId, toolName, null, false))
      .catch(err => console.error('[ToolExecution] Failed to log tool invocation:', err));

    return { result: { error: errorMessage, success: false }, success: false };
  }
}
