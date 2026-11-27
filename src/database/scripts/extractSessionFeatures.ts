// Structured per-session features (ai-therapist-172): list, and optionally
// code, the eligible sessions that have no current answer under the current
// feature-set version.
//
// Usage:
//   npx tsx src/database/scripts/extractSessionFeatures.ts [--limit <n>]
//   npx tsx src/database/scripts/extractSessionFeatures.ts --extract [--limit <n>]
//   npx tsx src/database/scripts/extractSessionFeatures.ts --extract --session <id> [--force]
//
// Default is LIST ONLY: no OpenAI call and no write. It prints how many
// eligible sessions are waiting. Eligible: an ended session of an enrolled
// study participant (a participant account that is not sandbox and has not
// withdrawn; never a staff, demo, harness or anonymous session) whose
// redaction is complete. Waiting: no answer for the current feature-set
// version, an earlier attempt that errored, or a STALE answer (the transcript
// the judge may read has changed since: a late message, a re-redaction, a
// leak review). It never prints message text.
//
// --extract calls the judge: one OpenAI Decisions API call per session (input
// tokens only; none for a session under the length floor) and one row written
// to session_features per session. Only messages.content_redacted is read,
// and a message waiting for leak review is not read at all. Running this
// script is the opt-in: it does not consult system_config.session_features,
// which gates only the automatic post-session job. --force codes a session
// again that already has a current answer (with --session). A session another
// run is coding at that moment is skipped (in_progress), so this script and
// the automatic job never both pay for it; a failed re-run never replaces a
// stored answer (kept_existing).
//
// Reads DATABASE_URL and OPENAI_API_KEY like the app. Not run by CI. Do not
// leave a long run going across the mini's Friday-night restart.
import { pool } from '../../server/config/db.js';
import { getSessionsNeedingFeatures } from '../../server/db/index.js';
import { SESSION_FEATURE_SET_VERSION } from '../../server/services/sessionFeatures.js';
import {
  backfillSessionFeatures,
  extractSessionFeatures,
  type ExtractOutcome,
} from '../../server/services/sessionFeatures.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const extract = process.argv.includes('--extract');
  const force = process.argv.includes('--force');
  const sessionId = getArg('--session');
  const limitArg = getArg('--limit');
  const limit = limitArg === undefined ? null : Number(limitArg);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`[SessionFeatures] --limit must be a positive integer, got ${limitArg}`);
    process.exitCode = 1;
    return;
  }
  if (force && !sessionId) {
    console.error('[SessionFeatures] --force needs --session <id>: re-coding everything is not supported');
    process.exitCode = 1;
    return;
  }

  if (sessionId) {
    if (!extract) {
      console.log('[SessionFeatures] list only: nothing was sent or written. Add --extract to code this session.');
      return;
    }
    const result: ExtractOutcome = await extractSessionFeatures(sessionId, { force });
    if (result.outcome === 'skipped') {
      console.log(`[SessionFeatures] ${sessionId}: skipped (${result.reason})`);
    } else {
      const r = result.row;
      // Counts only: which variables came back present is not printed.
      const present = Object.values(r.features ?? {}).filter((v) => v.kind === 'predicate' && v.present).length;
      console.log(
        `[SessionFeatures] ${sessionId}: ${r.status}` +
          (r.status === 'extracted'
            ? ` (${present} variable(s) present, ${r.unknown_count} unknown)`
            : r.status === 'errored'
              ? ` (${r.error})`
              : ''),
      );
    }
    return;
  }

  const waiting = await getSessionsNeedingFeatures(SESSION_FEATURE_SET_VERSION, { limit });
  console.log(
    `[SessionFeatures] ${waiting.length} eligible session(s) with no current ${SESSION_FEATURE_SET_VERSION} answer (none, errored or stale)` +
      (limit !== null ? ` (limited to ${limit})` : ''),
  );
  if (!extract) {
    console.log('[SessionFeatures] list only: nothing was sent or written. Re-run with --extract to code them.');
    return;
  }
  if (waiting.length === 0) return;
  console.log(`[SessionFeatures] --extract: up to ${waiting.length} OpenAI call(s) now...`);
  const s = await backfillSessionFeatures({ limit });
  console.log(
    `[SessionFeatures] done: ${s.extracted} extracted, ${s.tooShort} too short to code (no model call), ` +
      `${s.errored} errored (will be listed again), ${s.skipped} skipped`,
  );
}

main()
  .catch((err) => {
    console.error('[SessionFeatures] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
