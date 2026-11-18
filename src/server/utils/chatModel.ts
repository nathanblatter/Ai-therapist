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

import { getBackendModel } from './backendModels.js';
import { createLogger } from './logger.js';
import { getSystemConfig } from './sessionHelpers.js';

const log = createLogger('chatModel');

/** Code default. Changing this changes every deployment's chat model; prefer the config key. */
export const CHAT_DEFAULT_MODEL = 'gpt-5.2';

/**
 * Pure resolution from an already-loaded system config. A value that is not a
 * model id in the backend-model registry (utils/backendModels.ts, dated
 * snapshots included) falls back to the default with a warning: forwarded
 * as-is, a typo would fail every chat turn of every new session. A model new
 * to the registry has to be added there first, which is also what prices it.
 */
export function chatModelFromConfig(config: Record<string, unknown> | null | undefined): string {
  const raw = config?.chat_model;
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return CHAT_DEFAULT_MODEL;
  if (typeof raw !== 'string') {
    log.warn({ chat_model: raw }, `system_config.chat_model is not a string; using ${CHAT_DEFAULT_MODEL}`);
    return CHAT_DEFAULT_MODEL;
  }
  const model = raw.trim();
  if (!getBackendModel(model)) {
    log.warn(
      { chat_model: model },
      `system_config.chat_model is not a registered model (utils/backendModels.ts); using ${CHAT_DEFAULT_MODEL}`,
    );
    return CHAT_DEFAULT_MODEL;
  }
  return model;
}

/** The chat model new sessions should start on. Never throws. */
export async function resolveChatModel(): Promise<string> {
  try {
    return chatModelFromConfig(await getSystemConfig());
  } catch {
    return CHAT_DEFAULT_MODEL;
  }
}
