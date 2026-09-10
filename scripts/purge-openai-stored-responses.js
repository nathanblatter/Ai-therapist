/* ============================================================================
 * PURGE STORED OPENAI RESPONSES  (ai-therapist-188)  — browser console snippet
 * ============================================================================
 * Deletes the /v1/responses records that accumulated while the Responses API
 * `store` param defaulted to true — including every redaction pass, which
 * carried RAW PRE-REDACTION participant transcripts. The leak was fixed in
 * f4c0234 and verified stopped; this clears the backlog.
 *
 * WHY IT CLONES THE APP'S OWN REQUEST
 * -----------------------------------
 * There is no server-side path (verified 2026-09-09): project keys are told
 * "must be made with a session key ... only from the browser", and admin keys
 * — even unrestricted — fail with "Missing scopes: api.responses.read", which
 * is not an admin scope at all. So it has to run in the logged-in tab.
 *
 * Two earlier attempts failed for instructive reasons, both now handled:
 *   v1  credentials:'include'  -> 401. The console does NOT use cookies for
 *       api.openai.com; it sends Authorization: Bearer <session token>. The
 *       401 carried no CORS headers, so Chrome reported the confusing
 *       "blocked by CORS policy" instead of an auth error.
 *   v2  borrowed the token but sent my own URL (?limit=100) -> "Found 0".
 *       The listing evidently needs the app's exact parameter set; the console
 *       actually calls
 *         /v1/responses?include[]=message.input_image.image_url
 *                      &input_item_limit=1&output_item_limit=1
 *       with no `limit` at all, and may add project-scoping headers.
 *
 * v3 therefore clones the real thing: it wraps window.fetch, waits for the app
 * to issue its own /v1/responses list call, and captures that URL *and* every
 * header it used. It then replays that exact request, only adding pagination.
 * Nothing is guessed. The token never leaves the tab; window.fetch is restored
 * on every exit path.
 *
 * HOW TO RUN
 * ----------
 *  1. https://platform.openai.com/logs  (logged in), DevTools console
 *     (Cmd+Option+J). If prompted, type:  allow pasting
 *  2. Paste this whole file, press Enter.
 *  3. When it says "waiting", make the page reload its list — switch the tab
 *     Responses -> Completions -> Responses, or change a filter. It continues
 *     by itself.
 *  4. Keep the tab OPEN and FOCUSED until DONE (background tabs throttle).
 *
 * DRY RUN by default. Confirm the sample, then set DRY_RUN = false and paste
 * again. Deletion is irreversible; re-running is safe (404 counts as done).
 * ========================================================================= */

(async () => {
  const DRY_RUN     = true;   // <-- set false to actually delete
  const CONCURRENCY = 6;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const origFetch = window.fetch;
  let captured = null;        // { url, headers }

  // ---- 1. clone the app's own list request ---------------------------------
  const headersToObject = (h, input) => {
    const out = {};
    try {
      if (h) {
        if (typeof h.get === 'function' && typeof h.forEach === 'function') {
          h.forEach((v, k) => { out[k] = v; });
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) out[k] = v;
        } else {
          Object.assign(out, h);
        }
      }
      if (input && input.headers && typeof input.headers.forEach === 'function') {
        input.headers.forEach((v, k) => { if (!(k in out)) out[k] = v; });
      }
    } catch { /* best effort */ }
    return out;
  };

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      // the LIST call, not a single /responses/{id} fetch
      if (!captured && /\/v1\/responses(\?|$)/.test(url)) {
        const hdrs = headersToObject(init && init.headers, input);
        const hasAuth = Object.keys(hdrs).some(k => k.toLowerCase() === 'authorization');
        if (hasAuth) captured = { url, headers: hdrs };
      }
    } catch { /* never break the page */ }
    return origFetch.apply(this, arguments);
  };

  const restore = () => { window.fetch = origFetch; };

  console.log('%cWaiting for the page to issue its own list request…',
    'color:#0af;font-weight:bold',
    '\nSwitch the Logs tab (Responses -> Completions -> Responses) or change a filter.');

  for (let i = 0; i < 120 && !captured; i++) await sleep(500);   // up to 60s
  if (!captured) {
    restore();
    console.error('%cNothing captured.', 'color:red;font-weight:bold',
      '\nRe-paste, then interact with the Logs list so it refetches.');
    return;
  }

  console.log('%cCaptured the app request:', 'color:green;font-weight:bold');
  console.log('  ' + captured.url.replace(/([?&])/g, '\n    $1'));
  console.log('  headers: ' + Object.keys(captured.headers).join(', '));

  // Reuse the captured URL verbatim, only swapping the pagination cursor.
  const base = captured.url.split('#')[0];
  const withAfter = id => {
    if (!id) return base;
    return base + (base.includes('?') ? '&' : '?') + 'after=' + encodeURIComponent(id);
  };
  const opts = { headers: captured.headers };
  const API_ROOT = 'https://api.openai.com/v1/responses';

  // ---- 2. enumerate ---------------------------------------------------------
  console.log('%cCollecting response ids…', 'font-weight:bold');
  const ids = [], sample = [];
  let after = null, guard = 0;
  for (;;) {
    if (++guard > 5000) { console.warn('pagination guard hit'); break; }
    const res = await origFetch(withAfter(after), opts);
    if (res.status === 429) { await sleep(3000); continue; }
    if (!res.ok) {
      console.error('List stopped at', ids.length, '—', res.status,
        (await res.text().catch(() => '')).slice(0, 300));
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
    const last = rows[rows.length - 1].id;
    if (last === after) break;              // no forward progress
    after = last;
    if (ids.length % 500 < rows.length) console.log(`  …${ids.length} collected`);
    if (page.has_more === false) break;
  }

  console.log(`%cFound ${ids.length} stored responses.`, 'font-weight:bold');
  console.table(sample);
  if (!ids.length) {
    restore();
    console.warn('Still 0. Paste this and send me the output:\n' +
      '  copy(JSON.stringify({url: ' + JSON.stringify(base) +
      ', keys: ' + JSON.stringify(Object.keys(captured.headers)) + '}))');
    return;
  }

  if (DRY_RUN) {
    restore();
    console.log('%cDRY RUN — nothing deleted.', 'color:orange;font-weight:bold',
      '\nConfirm the sample is your data, set DRY_RUN = false, paste again.');
    return;
  }

  // ---- 3. delete ------------------------------------------------------------
  console.log('%cDeleting…', 'color:red;font-weight:bold');
  let done = 0, failed = 0;
  const queue = ids.slice();
  const worker = async () => {
    while (queue.length) {
      const id = queue.pop();
      try {
        const res = await origFetch(`${API_ROOT}/${id}`, { method: 'DELETE', ...opts });
        if (res.status === 429) { queue.push(id); await sleep(2000); continue; }
        if (res.ok || res.status === 404) done++; else failed++;   // 404 = already gone
      } catch { failed++; }
      const n = done + failed;
      if (n % 250 === 0) console.log(`  ${n}/${ids.length}  deleted=${done} failed=${failed}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---- 4. verify rather than trust the counter ------------------------------
  const check = await origFetch(base, opts);
  const left = check.ok ? ((await check.json()).data || []).length : '?';
  restore();
  console.log(`%cDONE — deleted ${done}, failed ${failed}. Still on first page: ${left}`,
    'color:green;font-weight:bold');
  if (failed || left) console.log('Paste again to sweep stragglers (idempotent).');
})();
