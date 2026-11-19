// Vitest setup file: run the suite with the wall clock moved, to find tests
// that only pass on the day they were written (date time-bombs).
//
// Off unless one of these is set, so a normal `npm test` is untouched:
//   TEST_CLOCK_SHIFT_DAYS=8                 the real clock plus 8 days (may be fractional or negative)
//   TEST_CLOCK_AT=2027-01-01T03:00:00       start the clock at this instant (a bare local time follows TZ)
//
// The shifted clock keeps ticking: it replaces the global Date with one that
// adds a fixed offset to the real time, so code that measures elapsed time
// still sees time pass (a frozen Date, which vi.setSystemTime alone gives,
// makes timeout and latency code misbehave in ways no real day would).
// Tests that install fake timers start from the shifted time, and
// vi.useRealTimers() hands back the shifted clock, not the real one.
// Explicit vi.setSystemTime() calls still win, as they should.
// Timers, performance.now() and process.hrtime() are not touched.

function offsetMs(): number | null {
  const at = process.env.TEST_CLOCK_AT;
  if (at) {
    const target = new Date(at).getTime();
    if (Number.isNaN(target)) throw new Error(`TEST_CLOCK_AT is not a date: ${at}`);
    return target - Date.now();
  }
  const days = process.env.TEST_CLOCK_SHIFT_DAYS;
  if (days) {
    const n = Number(days);
    if (!Number.isFinite(n)) throw new Error(`TEST_CLOCK_SHIFT_DAYS is not a number: ${days}`);
    return Math.round(n * 86_400_000);
  }
  return null;
}

const PATCHED = Symbol.for('ai-therapist.shiftedClock');
const offset = offsetMs();
const g = globalThis as typeof globalThis & { [PATCHED]?: true };

if (offset !== null && !g[PATCHED]) {
  g[PATCHED] = true;
  const RealDate = Date;
  const now = () => RealDate.now() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args: unknown[], newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
    },
    apply() {
      // Date() called as a function returns the current time as a string.
      return new RealDate(now()).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(target, prop, receiver);
    },
  });
}
