/**
 * Fire-and-forget work on the crisis path (a page requested through a dynamic
 * import, the record-side work of a high turn) is started without the caller
 * waiting for it: the participant's reply must not wait on an SMS. Tests do
 * need to wait for it, or one test's page lands in the next test's mocks.
 *
 * `trackBackground` registers such a promise; `_settleBackgroundForTests`
 * resolves once every registered promise (including any started while it
 * waits) has settled. Tracking changes nothing about the work itself: the
 * promise is the one the caller already started, and an entry leaves the set
 * as soon as it settles.
 */
const inFlight = new Set<Promise<unknown>>();

/** Register a fire-and-forget promise. Callers keep their own .catch, which
 *  is where a failure is logged; tracking only notes when it has settled. */
export function trackBackground(work: Promise<unknown>): void {
  inFlight.add(work);
  const done = (): void => {
    inFlight.delete(work);
  };
  void work.then(done, done);
}

/** Test hook: resolves when every tracked promise has settled. */
export async function _settleBackgroundForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
