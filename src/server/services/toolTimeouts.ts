/**
 * Per-tool execution timeouts (ai-therapist-364).
 *
 * Every model-requested tool runs through ToolRegistry.executeTool, on the
 * voice path (GPT-Live sideband, Grok proxy) and on the typed-chat path alike.
 * Until 2026-11-19 nothing bounded a handler, and on the voice path the
 * delegation watchdog (sidebandManager, DELEGATION_STALL_MS) pauses while one
 * of our tools runs, so a hung handler meant a participant waiting in silence
 * for good. Now a handler that has not settled within its limit is answered
 * with a ToolTimeoutError; the caller returns that to the model as an ordinary
 * tool error, so it can say it could not do that, and the watch resumes.
 *
 * A timed-out handler cannot be cancelled (handlers take no abort signal) and
 * keeps running: a write it was making may still land. Its late result or
 * error is logged and discarded; the call has already been answered once and
 * is never answered again.
 *
 * The limits are generous on purpose. A false timeout on a tool that was about
 * to finish is worse than a few more seconds of waiting, and on the voice path
 * the participant also waits through the backend's own quiet period after it.
 */

/** Local database work: reads, inserts, config lookups. */
export const TOOL_TIMEOUT_DEFAULT_MS = 5_000;

/**
 * Tools that do more than local database work. One table, one default:
 *  - embeddings (text-embedding call with its own retry/backoff), a vector
 *    search and, for the retrieval tools, an LLM rerank with its own hard
 *    2.5 s timeout (rerank.service.ts): 10 s;
 *  - escalate_to_human at high urgency flags the session and runs the
 *    graduated crisis response, which pages the on-call: 20 s. If it times
 *    out the page may still go out; the model is told to stay with the
 *    participant either way.
 */
export const TOOL_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  retrieve_psychoeducation: 10_000,
  find_worksheet: 10_000,
  suggest_modality_technique: 10_000,
  recall_relevant_history: 10_000,
  remember_this: 10_000,
  escalate_to_human: 20_000,
};

export function toolTimeoutMs(name: string): number {
  return TOOL_TIMEOUT_OVERRIDES_MS[name] ?? TOOL_TIMEOUT_DEFAULT_MS;
}

/** What a tool that did not finish returns to the model (as the error of its result). */
export function toolTimeoutMessage(name: string): string {
  return (
    `The ${name} tool did not finish in time and returned nothing. Do not say it worked. If the participant ` +
    'asked for this, tell them plainly that you could not do it just now. Stay with the participant; if they are ' +
    'talking about their safety, follow your crisis protocol.'
  );
}

/** A tool handler that did not settle within toolTimeoutMs(name). */
export class ToolTimeoutError extends Error {
  readonly code = 'tool_timeout' as const;
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(toolTimeoutMessage(toolName));
    this.name = 'ToolTimeoutError';
  }
}

/** Duck-typed so callers whose tests mock the registry module still recognise it. */
export function isToolTimeoutError(err: unknown): err is ToolTimeoutError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'tool_timeout';
}

/**
 * Settle with the handler's outcome, or reject with ToolTimeoutError after
 * `timeoutMs`, whichever comes first: exactly once. A handler that settles
 * after the timeout is logged and otherwise ignored.
 */
export function runWithToolTimeout<T>(
  name: string,
  work: () => Promise<T>,
  timeoutMs: number = toolTimeoutMs(name),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn('[ToolRegistry] tool timed out', JSON.stringify({ tool: name, timeoutMs }));
      reject(new ToolTimeoutError(name, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    const late = (outcome: 'result' | 'error') =>
      console.warn('[ToolRegistry] late tool outcome discarded', JSON.stringify({ tool: name, outcome, timeoutMs }));
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => {
        if (done) return late('result');
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (done) return late('error');
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
