// The typed-chat therapy model (system_config.chat_model).
//
// Mirrors live_backend_model: a bare JSON string in system_config, read at
// session start, with a code default used when the row is missing or blank.
// Making it config rather than a constant turns a model change into a dated,
// admin-visible config edit instead of a deploy, and the value a session
// started with is stamped into session_configurations.ai_model so analysis
// can always tell which model produced a chat session's replies.
//
// Changing it mid-enrollment changes the intervention: record the change date
// in the study log (docs/model-pinning.md).

import { getSystemConfig } from './sessionHelpers.js';

/** Code default. Changing this changes every deployment's chat model; prefer the config key. */
export const CHAT_DEFAULT_MODEL = 'gpt-5.2';

/** Pure resolution from an already-loaded system config. */
export function chatModelFromConfig(config: Record<string, unknown> | null | undefined): string {
  const raw = config?.chat_model;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : CHAT_DEFAULT_MODEL;
}

/** The chat model new sessions should start on. Never throws. */
export async function resolveChatModel(): Promise<string> {
  try {
    return chatModelFromConfig(await getSystemConfig());
  } catch {
    return CHAT_DEFAULT_MODEL;
  }
}
