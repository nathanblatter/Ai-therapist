#!/usr/bin/env python3
"""
Purge stored OpenAI /v1/responses records (ai-therapist-188).

WHY THIS EXISTS
---------------
The Responses API defaults `store` to true. Our redaction passes never set it
false, so every redaction call — the one payload in the system that is by
definition RAW, PRE-REDACTION participant transcript — was retained as
application state on OpenAI's side. The leak was fixed in commit f4c0234 and
verified stopped; this script removes what had already accumulated.

WHY IT NEEDS ITS OWN KEY
------------------------
Listing stored responses rejects an ordinary project key outright:
    "must be made with a session key ... it can only be made from the browser"
But an ADMIN key gets a different, far more useful error:
    "Missing scopes: api.responses.read ... if you're using a restricted API
     key, that it has the necessary scopes."
So a *restricted* admin key carrying `api.responses.read` (list) and
`api.responses.write` (delete) can do the whole job over plain HTTPS — no
browser scripting, no session-token handling.

CREATE THE KEY
--------------
  platform.openai.com/settings/organization/admin-keys -> Create new admin key
    Permissions: Restricted
    Enable:      api.responses.read   AND   api.responses.write
  This key is powerful and single-purpose: DELETE IT when the purge is done.
  Do NOT reuse the app's OPENAI_ADMIN_KEY — that one is read-only billing on
  purpose and should never be able to mutate anything.

USAGE
-----
  python3 scripts/purge-openai-stored-responses.py --key-file /tmp/purge-key
  python3 scripts/purge-openai-stored-responses.py            # hidden prompt

  --dry-run     list and sample only, delete nothing  (DEFAULT)
  --execute     actually delete
  --workers N   parallel deletes (default 8)

Re-running is safe: ids already gone return 404 and count as done.
"""
import argparse
import concurrent.futures as futures
import getpass
import json
import sys
import threading
import time
import urllib.error
import urllib.request

API = "https://api.openai.com/v1/responses"


def call(method, url, key, timeout=60):
    """Return (status, parsed_body_or_text). Never raises on HTTP errors."""
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except Exception as e:                     # network-level
        return 0, str(e)


def preflight(key):
    """Fail loudly and specifically rather than half-running."""
    status, body = call("GET", f"{API}?limit=1", key)
    if status == 200:
        return
    msg = ""
    if isinstance(body, dict):
        msg = body.get("error", {}).get("message", "")
    if "session key" in msg:
        sys.exit(
            "ERROR: that looks like a PROJECT key. Listing needs an ADMIN key with\n"
            "       the api.responses.read scope. See the header of this file."
        )
    if "Missing scopes" in msg:
        sys.exit(
            f"ERROR: key is missing a required scope.\n       {msg}\n"
            "       Recreate it as Restricted with api.responses.read AND\n"
            "       api.responses.write."
        )
    sys.exit(f"ERROR: preflight failed (HTTP {status}): {str(msg or body)[:300]}")


def collect(key):
    """Page through every stored response id."""
    ids, sample, after = [], [], None
    while True:
        url = f"{API}?limit=100" + (f"&after={after}" if after else "")
        status, body = call("GET", url, key)
        if status == 429:
            time.sleep(3)
            continue
        if status != 200:
            print(f"  ! list stopped at {len(ids)} ids (HTTP {status}): "
                  f"{str(body)[:200]}", file=sys.stderr)
            break
        rows = body.get("data") or []
        if not rows:
            break
        for row in rows:
            ids.append(row["id"])
            if len(sample) < 6:
                created = row.get("created_at")
                sample.append({
                    "id": row["id"],
                    "model": row.get("model"),
                    "created": time.strftime("%Y-%m-%d %H:%M",
                                             time.localtime(created)) if created else "?",
                })
        after = rows[-1]["id"]
        print(f"  ...{len(ids)} collected", flush=True)
        if not body.get("has_more"):
            break
    return ids, sample


def purge(ids, key, workers):
    done = failed = 0
    lock = threading.Lock()
    total = len(ids)

    def one(rid):
        nonlocal done, failed
        for _ in range(6):
            status, _body = call("DELETE", f"{API}/{rid}", key)
            if status == 429:
                time.sleep(2)
                continue
            # 404 == already gone; count it so re-runs converge cleanly.
            with lock:
                if status in (200, 204, 404):
                    done += 1
                else:
                    failed += 1
                n = done + failed
                if n % 250 == 0 or n == total:
                    print(f"  {n}/{total}  deleted={done} failed={failed}", flush=True)
            return
        with lock:
            failed += 1

    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, ids))
    return done, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-file", help="file containing the scoped admin key")
    ap.add_argument("--execute", action="store_true", help="actually delete")
    ap.add_argument("--dry-run", action="store_true", default=None)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    if args.key_file:
        key = open(args.key_file).read().strip()
    else:
        key = getpass.getpass("Paste the scoped admin key (hidden): ").strip()
    if not key.startswith("sk-admin-"):
        sys.exit("ERROR: expected an admin key (sk-admin-...).")

    print("==> preflight")
    preflight(key)
    print("    OK - key can list stored responses.")

    print("==> collecting ids")
    ids, sample = collect(key)
    print(f"\nFound {len(ids)} stored responses.")
    for s in sample:
        print(f"    {s['id']}  {s['model']}  {s['created']}")
    if not ids:
        print("Nothing to delete.")
        return

    if not args.execute:
        print("\nDRY RUN - nothing deleted. Re-run with --execute to purge.")
        return

    print(f"\n==> deleting {len(ids)} records with {args.workers} workers")
    done, failed = purge(ids, key, args.workers)
    print(f"\nDeleted {done}, failed {failed}.")

    # Verify rather than trust.
    print("==> verifying")
    remaining, _ = collect(key)
    print(f"Remaining stored responses: {len(remaining)}")
    if remaining:
        print("Re-run to clear the stragglers (deletes are idempotent).")
        sys.exit(1)
    print("All stored responses purged.")


if __name__ == "__main__":
    main()
