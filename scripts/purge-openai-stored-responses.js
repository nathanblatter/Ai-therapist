/* ============================================================================
 * PURGE STORED OPENAI RESPONSES  (ai-therapist-188)  — browser console snippet
 * ============================================================================
 * Deletes the /v1/responses records that accumulated while the Responses API
 * `store` param defaulted to true — including every redaction pass, which
 * carried RAW PRE-REDACTION participant transcripts. The leak was fixed in
 * commit f4c0234 and verified stopped; this clears the backlog.
 *
 * WHY THE BROWSER, AND WHY IT AUTO-CAPTURES A TOKEN
 * ------------------------------------------------
 * Verified exhaustively 2026-09-09 — there is no server-side path:
 *   - project key (sk-proj-), every header/param variant:
 *       "must be made with a session key ... only from the browser"
 *   - admin key with UNRESTRICTED permissions, every variant:
 *       "Missing scopes: api.responses.read"  (api.responses.* is not an admin
 *        scope at all, so a Restricted key cannot have more)
 *   - console Logs UI has no delete affordance
 *   - we never persisted the resp_... ids, so DELETE has nothing to iterate
 * And the console does NOT authenticate to api.openai.com with cookies — it
 * sends `Authorization: Bearer <session token>`. A plain credentials:'include'
 * fetch therefore 401s, and a 401 carries no CORS headers, which the browser
 * reports as the confusing "blocked by CORS policy" error.
 *
 * So v2 borrows the page's own token instead of asking you to copy it: it
 * wraps window.fetch, waits for the app to make any api.openai.com call, and
 * lifts the Authorization header from it. The token never leaves the tab.
 * window.fetch is restored when the run finishes.
 *
 * HOW TO RUN
 * ----------
 *  1. Open  https://platform.openai.com/logs  (logged in)
 *  2. DevTools console (Cmd+Option+J). If prompted, type: allow pasting
 *  3. Paste this whole file, press Enter
 *  4. When it says "waiting for a token", click around the Logs page — switch
 *     the tab Responses -> Completions -> Responses, or hit the refresh/filter
 *     control. Any app request will do. It proceeds automatically.
 *  5. Keep the tab OPEN and FOCUSED until it prints DONE (background tabs are
 *     throttled).
 *
 * DRY RUN by default: it lists and samples, deletes nothing. Confirm the sample
 * is your data, then set DRY_RUN = false below and paste again.
 *
 * Deletion is irreversible; these records exist nowhere else. Re-running is
 * safe — already-deleted ids return 404 and count as done, so it converges.
 * ========================================================================= */

(async () => {
  const DRY_RUN     = true;   // <-- set false to actually delete
  const CONCURRENCY = 6;
  const PAGE_SIZE   = 100;
  const API         = 'https://api.openai.com/v1/responses';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- 1. borrow the page's own Authorization header ------------------------
  const origFetch = window.fetch;
  let TOKEN = null;

  const sniff = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('api.openai.com')) return;
      let auth = null;
      const h = init && init.headers;
      if (h) {
        if (typeof h.get === 'function') auth = h.get('authorization');
        else if (Array.isArray(h)) {
          const hit = h.find(([k]) => String(k).toLowerCase() === 'authorization');
          auth = hit && hit[1];
        } else {
          auth = h.authorization || h.Authorization || null;
        }
      }
      if (!auth && input && typeof input.headers?.get === 'function') {
        auth = input.headers.get('authorization');
      }
      if (auth && /bearer/i.test(auth)) TOKEN = auth;
    } catch { /* never break the page */ }
  };

  window.fetch = function (input, init) {
    sniff(input, init);
    return origFetch.apply(this, arguments);
  };

  const restore = () => { window.fetch = origFetch; };

  console.log('%cWaiting for a token — click around the Logs page now.',
    'color:#0af;font-weight:bold',
    '\n(switch Responses -> Completions -> Responses, or hit refresh//filter)');

  for (let i = 0; i < 120 && !TOKEN; i++) await sleep(500);   // up to 60s
  if (!TOKEN) {
    restore();
    console.error('%cNo token captured.', 'color:red;font-weight:bold',
      '\nRe-paste and make sure you interact with the page so it issues a request.');
    return;
  }
  console.log('%cToken captured — proceeding.', 'color:green;font-weight:bold');

  const opts = { headers: { authorization: TOKEN } };

  // ---- 2. preflight ---------------------------------------------------------
  const probe = await origFetch(`${API}?limit=1`, opts);
  if (!probe.ok) {
    restore();
    console.error('Preflight failed', probe.status,
      (await probe.text().catch(() => '')).slice(0, 300));
    return;
  }

  // ---- 3. enumerate ---------------------------------------------------------
  console.log('%cCollecting response ids…', 'font-weight:bold');
  const ids = [], sample = [];
  let after = null;
  for (;;) {
    const res = await origFetch(
      `${API}?limit=${PAGE_SIZE}${after ? `&after=${after}` : ''}`, opts);
    if (res.status === 429) { await sleep(3000); continue; }
    if (!res.ok) {
      console.error('List stopped at', ids.length, '—', res.status,
        (await res.text().catch(() => '')).slice(0, 200));
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
  if (!ids.length) { restore(); console.log('Nothing to do.'); return; }

  if (DRY_RUN) {
    restore();
    console.log('%cDRY RUN — nothing deleted.', 'color:orange;font-weight:bold',
      '\nConfirm the sample is your data, set DRY_RUN = false, paste again.');
    return;
  }

  // ---- 4. delete ------------------------------------------------------------
  console.log('%cDeleting…', 'color:red;font-weight:bold');
  let done = 0, failed = 0;
  const queue = ids.slice();
  const worker = async () => {
    while (queue.length) {
      const id = queue.pop();
      try {
        const res = await origFetch(`${API}/${id}`, { method: 'DELETE', ...opts });
        if (res.status === 429) { queue.push(id); await sleep(2000); continue; }
        if (res.ok || res.status === 404) done++; else failed++;  // 404 = already gone
      } catch { failed++; }
      const n = done + failed;
      if (n % 250 === 0) console.log(`  ${n}/${ids.length}  deleted=${done} failed=${failed}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---- 5. verify instead of trusting the counter ---------------------------
  const check = await origFetch(`${API}?limit=1`, opts);
  const left = check.ok ? ((await check.json()).data || []).length : '?';
  restore();
  console.log(
    `%cDONE — deleted ${done}, failed ${failed}. Still on first page: ${left}`,
    'color:green;font-weight:bold');
  if (failed || left) console.log('Paste again to sweep stragglers (idempotent).');
})();
