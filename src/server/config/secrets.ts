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
