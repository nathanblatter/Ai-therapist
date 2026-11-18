// CRAWL's "prior conversation history" seam.
//
// OpenAI's "GPT-Live evaluation guide" (CRAWL, "Using prior conversation
// history") tests a critical point mid-conversation without replaying it:
// prior user and assistant turns go in as TEXT in the startup `session.input`,
// and only the current request is streamed as audio. It restores text context
// only, not pending work or hidden session state.
//
// Our product mints GPT-Live sessions server-side (POST /api/live/session ->
// buildLiveSessionConfig) and never passes history for a new participant
// session, and this harness must not change product code. The server runs
// in-process, so the harness wraps the global fetch for exactly one mint
// call and adds `session.input` to the body OpenAI receives. Everything else
// in the minted config (instructions, delegation backend, tools, voice) is the
// product's own. The item shape is the one finalizeSession builds
// (liveSessionConfig.ts), which is also the guide's shape.
//
// Limits of the seam, stated in docs/redteam.md: the server's own records
// (messages, risk_score_history) do not contain the seeded turns, so the
// crisis detector scores the spoken request alone, as it would the first
// turn of a session. The voice model and the delegated backend see the
// history; the server's sweep does not.

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';

/** The `session.input` items for a history (same shape as the product's). */
export function historyItems(history: HistoryTurn[]): Array<Record<string, unknown>> {
  return history
    .filter((h) => h.content.trim())
    .map((h) => ({
      type: 'message',
      role: h.role,
      content: [
        h.role === 'assistant' ? { type: 'output_text', text: h.content } : { type: 'input_text', text: h.content },
      ],
    }));
}

/** Rewrite a mint request body to carry `history` (pure; unit-tested). Throws
 *  when the product already seeded history: the seam must never silently
 *  replace real context. */
export function withHistoryBody(body: string, history: HistoryTurn[]): string {
  const parsed = JSON.parse(body) as { session?: Record<string, unknown> };
  if (!parsed.session) throw new Error('mint body has no session object');
  if (parsed.session.input) throw new Error('the product already seeded session.input; refusing to overwrite it');
  parsed.session.input = historyItems(history);
  return JSON.stringify(parsed);
}

/**
 * Run `fn` (which performs exactly one POST /api/live/session) with the
 * global fetch wrapped so the next GPT-Live mint carries `history`. The
 * wrapper removes itself after that one call or when `fn` settles.
 */
export async function withSeededHistory<T>(history: HistoryTurn[] | undefined, fn: () => Promise<T>): Promise<T> {
  if (!history || history.length === 0) return fn();
  const original = globalThis.fetch;
  let used = false;
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!used && url === LIVE_SESSIONS_URL && init && typeof init.body === 'string') {
      used = true;
      return original(input, { ...init, body: withHistoryBody(init.body, history) });
    }
    return original(input, init);
  };
  globalThis.fetch = wrapped;
  try {
    const out = await fn();
    if (!used) throw new Error('seeded history was never applied: no GPT-Live mint went through fetch');
    return out;
  } finally {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  }
}
