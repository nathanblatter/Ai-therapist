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
 *    graduated crisis response, which pages the on-call (the page itself is
 *    not awaited; the handler is about ten database round trips): 10 s. If it times
 *    out the flag and page are still on their way, and the model is told
 *    exactly that (toolTimeoutMessage), never that help could not be reached.
 */
export const TOOL_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  retrieve_psychoeducation: 10_000,
  find_worksheet: 10_000,
  suggest_modality_technique: 10_000,
  recall_relevant_history: 10_000,
  remember_this: 10_000,
  escalate_to_human: 10_000,
};

export function toolTimeoutMs(name: string): number {
  return TOOL_TIMEOUT_OVERRIDES_MS[name] ?? TOOL_TIMEOUT_DEFAULT_MS;
}

/**
 * Tools whose handler writes something, or changes what the participant sees,
 * after its slow step: a timed-out call of one of these may still go through,
 * so the model must not tell the participant it failed (PR #80 review). The
 * crisis tools have their own texts (CRISIS_TOOL_TIMEOUT_MESSAGES).
 */
export const TOOLS_UNCONFIRMED_ON_TIMEOUT: ReadonlySet<string> = new Set([
  'set_session_goal',
  'create_safety_plan',
  'remember_this',
  'forget_this',
  'switch_language',
  'flag_notable_moment',
  'assign_practice',
  'create_custom_worksheet',
]);

/**
 * The crisis tools and end_session: what a slow call means differs, and the
 * generic "tell them you could not do it" would be false or harmful. A
 * timed-out escalate_to_human is still running: the flag, the crisis card and
 * the page follow when it finishes, so the model must never tell a person in
 * crisis that no one could be reached, and must not call it again (a second
 * call raises a second crisis event, adverse-event draft and safety steer).
 */
const CRISIS_TOOL_TIMEOUT_MESSAGES: Readonly<Record<string, string>> = {
  escalate_to_human:
    'The alert to the monitoring team is still being sent and is not confirmed yet. Do not call escalate_to_human ' +
    'again for this. Do not tell the participant that it failed or that no one could be reached, and do not ' +
    'promise that a person will contact them or join. Stay with them. If they are talking about their safety, ' +
    'follow your crisis protocol and make sure the crisis lines are on their screen.',
  run_risk_check:
    'This step was not confirmed as logged; it may still be saved. Do not call run_risk_check again for this ' +
    'answer. It is silent: say nothing about it to the participant. Continue the assessment and follow your ' +
    'crisis protocol.',
  end_session:
    'Ending the session was not confirmed; it may still close in a few seconds. Do not call end_session again ' +
    'and do not start a new topic. If the participant is still talking, respond to them; if they are talking ' +
    'about their safety, follow your crisis protocol.',
};

/** What a tool that did not finish returns to the model (as the error of its result). */
export function toolTimeoutMessage(name: string): string {
  const crisis = CRISIS_TOOL_TIMEOUT_MESSAGES[name];
  if (crisis) return crisis;
  if (TOOLS_UNCONFIRMED_ON_TIMEOUT.has(name)) {
    return (
      `The ${name} tool did not confirm in time; it may still go through. Do not call it again now. If the ` +
      'participant asked for this, tell them you are not sure it went through: do not say it worked, and do not ' +
      'say it failed. Stay with the participant; if they are talking about their safety, follow your crisis ' +
      'protocol.'
    );
  }
  return (
    `The ${name} tool did not finish in time and returned nothing. Do not say it worked. If the participant ` +
    'asked for this, tell them plainly that you could not do it just now. Stay with the participant; if they are ' +
    'talking about their safety, follow your crisis protocol.'
  );
}

/**
 * Tools of which at most one call per session runs at a time. While one is
 * still running (including after it timed out), another call does not start a
 * second handler and is answered at once with the same timeout text.
 */
export const SINGLE_FLIGHT_TOOLS: ReadonlySet<string> = new Set(['escalate_to_human']);
const inFlight = new Set<string>();

/** A tool handler that did not settle within toolTimeoutMs(name), or a repeat of one still running. */
export class ToolTimeoutError extends Error {
  readonly code = 'tool_timeout' as const;
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
    /** True when the call never ran because an earlier one is still running (SINGLE_FLIGHT_TOOLS). */
    readonly alreadyRunning: boolean = false,
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
 * after the timeout is logged and otherwise ignored. With a `flightKey` (the
 * session id), a SINGLE_FLIGHT_TOOLS call made while an earlier one for the
 * same key is still running is answered at once and its work never starts.
 */
export function runWithToolTimeout<T>(
  name: string,
  work: () => Promise<T>,
  timeoutMs: number = toolTimeoutMs(name),
  flightKey?: string,
): Promise<T> {
  const key = flightKey && SINGLE_FLIGHT_TOOLS.has(name) ? `${name}\u0000${flightKey}` : null;
  if (key && inFlight.has(key)) {
    console.warn('[ToolRegistry] repeat call while the earlier one is still running', JSON.stringify({ tool: name }));
    return Promise.reject(new ToolTimeoutError(name, timeoutMs, true));
  }
  if (key) inFlight.add(key);
  const release = () => {
    if (key) inFlight.delete(key);
  };
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
        release();
        if (done) return late('result');
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        release();
        if (done) return late('error');
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
