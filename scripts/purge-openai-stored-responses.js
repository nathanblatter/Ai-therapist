/* ============================================================================
 * PURGE STORED OPENAI RESPONSES  (ai-therapist-188)  — browser console snippet
 * ============================================================================
 * Deletes the /v1/responses records that accumulated while the Responses API
 * `store` param defaulted to true — including every redaction pass, which
 * carried RAW PRE-REDACTION participant transcripts. The leak itself was fixed
 * in commit f4c0234 and verified stopped; this clears the backlog.
 *
 * WHY THIS MUST RUN IN THE BROWSER
 * --------------------------------
 * Verified exhaustively on 2026-09-09 — there is no server-side path:
 *   - project key (sk-proj-), every header/param variant:
 *       "must be made with a session key (that is, it can only be made from
 *        the browser)"
 *   - admin key (sk-admin-) with UNRESTRICTED permissions, every variant:
 *       "Missing scopes: api.responses.read"
 *     Unrestricted already grants every admin scope, so a Restricted key
 *     cannot have more: api.responses.* is not an admin scope at all.
 *   - the console Logs UI has no delete affordance (no trash, no bulk select)
 *   - we never persisted the resp_... ids, so DELETE (which a project key CAN
 *     call) has nothing to iterate over
 * Listing is session-only by design. Hence: run it in the logged-in tab.
 *
 * HOW TO RUN
 * ----------
 *  1. Open  https://platform.openai.com/logs   (logged in)
 *  2. DevTools console:  Cmd+Option+J
 *  3. Paste this entire file, press Enter
 *  4. Keep the tab OPEN and FOCUSED until it prints DONE — background tabs get
 *     throttled and this will crawl.
 *
 * It runs a DRY RUN first and deletes nothing. Read the sample it prints, then
 * set DRY_RUN = false at the top and paste again to actually purge.
 *
 * If you see a 401: the console is using a bearer token rather than cookies.
 *   DevTools > Network > click the `responses?include[]=...` request >
 *   Headers > copy the `authorization:` value > set AUTH_OVERRIDE below.
 *   That token is a live credential — keep it out of chats, tickets, commits.
 *
 * Deletion is irreversible and these records exist nowhere else. Re-running is
 * safe: already-deleted ids return 404 and count as done, so it converges.
 * ========================================================================= */

(async () => {
  const DRY_RUN       = true;   // <-- set false to actually delete
  const AUTH_OVERRIDE = null;   // <-- 'Bearer sess-...' only if you get a 401
  const CONCURRENCY   = 6;
  const PAGE_SIZE     = 100;

  const API  = 'https://api.openai.com/v1/responses';
  const opts = {
    credentials: 'include',
    headers: AUTH_OVERRIDE ? { authorization: AUTH_OVERRIDE } : {},
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- preflight -----------------------------------------------------------
  const probe = await fetch(`${API}?limit=1`, opts);
  if (probe.status === 401 || probe.status === 403) {
    console.error('%cAuth failed (' + probe.status + ')',
      'color:red;font-weight:bold',
      '\nSet AUTH_OVERRIDE — see the header comment.');
    return;
  }
  if (!probe.ok) {
    console.error('Unexpected status', probe.status,
      (await probe.text()).slice(0, 300));
    return;
  }

  // ---- enumerate -----------------------------------------------------------
  console.log('%cCollecting response ids…', 'font-weight:bold');
  const ids = [], sample = [];
  let after = null;
  for (;;) {
    const res = await fetch(
      `${API}?limit=${PAGE_SIZE}${after ? `&after=${after}` : ''}`, opts);
    if (res.status === 429) { await sleep(3000); continue; }
    if (!res.ok) {
      console.error('List stopped at', ids.length, 'ids —', res.status,
        (await res.text()).slice(0, 200));
      break;
    }
    const page = await res.json();
    const rows = page.data || [];
    if (!rows.length) break;
    for (const row of rows) {
      ids.push(row.id);
      if (sample.length < 6) sample.push({
        id: row.id,
        model: row.model,
        created: row.created_at
          ? new Date(row.created_at * 1000).toLocaleString() : '?',
      });
    }
    after = rows[rows.length - 1].id;
    console.log(`  …${ids.length} collected`);
    if (!page.has_more) break;
  }

  console.log(`%cFound ${ids.length} stored responses.`, 'font-weight:bold');
  console.table(sample);
  if (!ids.length) { console.log('Nothing to do.'); return; }

  if (DRY_RUN) {
    console.log('%cDRY RUN — nothing deleted.', 'color:orange;font-weight:bold',
      '\nConfirm the sample above is your data, then set DRY_RUN = false and re-paste.');
    return;
  }

  // ---- delete --------------------------------------------------------------
  console.log('%cDeleting…', 'color:red;font-weight:bold');
  let done = 0, failed = 0;
  const queue = ids.slice();
  const worker = async () => {
    while (queue.length) {
      const id = queue.pop();
      try {
        const res = await fetch(`${API}/${id}`, { method: 'DELETE', ...opts });
        if (res.status === 429) { queue.push(id); await sleep(2000); continue; }
        if (res.ok || res.status === 404) done++; else failed++;  // 404 = already gone
      } catch { failed++; }
      const n = done + failed;
      if (n % 250 === 0) console.log(`  ${n}/${ids.length}  deleted=${done} failed=${failed}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---- verify rather than trust the counter --------------------------------
  const check = await fetch(`${API}?limit=1`, opts);
  const left  = check.ok ? ((await check.json()).data || []).length : '?';
  console.log(`%cDONE — deleted ${done}, failed ${failed}. Remaining on first page: ${left}`,
    'color:green;font-weight:bold');
  if (failed || left) console.log('Re-paste to sweep stragglers (deletes are idempotent).');
})();
