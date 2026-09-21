import "dotenv/config";

/**
 * Get OpenAI API key from environment.
 * The OpenAI key must be provided via the OPENAI_API_KEY environment variable.
 * @throws {Error} If OPENAI_API_KEY is not set
 */
export async function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  return key;
}

/**
 * xAI API key for the Grok Voice backend (docs/grok-voice.md).
 *
 * Optional at boot: the key is only required once system_config.ai_model
 * names a grok-voice-* model, so a deployment that never flips the switch can
 * leave XAI_API_KEY unset. The session route fails loudly (409) when the model
 * is switched but the key is missing, rather than opening a socket that 401s.
 * @throws {Error} If XAI_API_KEY is not set
 */
export async function getXaiKey(): Promise<string> {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    throw new Error('XAI_API_KEY environment variable is not set');
  }
  return key;
}

/** Whether the Grok Voice backend can be used in this environment. */
export function hasXaiKey(): boolean {
  return Boolean(process.env.XAI_API_KEY);
}
