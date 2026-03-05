# Plan: Speed Up Redaction for Live Admin Monitoring

## Context
Redaction currently uses GPT-5 with `reasoning: { effort: "low" }` and runs **two sequential API calls per message** (double-pass). With a sequential queue (one message at a time), this means:
- Per message: ~4–8 seconds
- If 5 messages queue up: ~20–40 seconds before the last one is redacted

Researchers watching live sessions see `content_redacted: null` until their messages are processed. The fix is purely performance — RBAC (therapist sees `content`, researcher sees `content_redacted`) stays unchanged.

## Changes

### 1. `src/server/services/redaction.service.js` — Model + Single Pass

**What changes:**
- Model: `gpt-5` → `gpt-4o-mini` (uses existing OpenAI key, no new secrets)
- Remove `reasoning: { effort: "low" }` (not supported on mini)
- Switch API: `client.responses.create()` → `client.chat.completions.create()` (standard chat format)
- Remove double-pass: delete `redactPHI` wrapper that calls `redactPHISinglePass` twice; export the single-pass function directly

**Result:** ~0.3–0.8s per message instead of 4–8s

**Key diff:**
```js
// Before:
const response = await client.responses.create({
  model: "gpt-5",
  reasoning: { effort: "low" },
  instructions: prompt,
  input: input,
});
return response.output_text;

// After:
const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: prompt },
    { role: "user", content: input }
  ],
  temperature: 0,
});
return response.choices[0].message.content;
```

And remove the double-pass wrapper — just export `redactPHISinglePass` as `redactPHI`.

### 2. `src/server/services/redactionQueue.service.js` — Concurrent Workers

**What changes:**
- Replace the `isProcessing` boolean + sequential `while` loop with a concurrent worker pool
- `CONCURRENCY_LIMIT = 5` (5 messages redacted simultaneously)
- Extract job processing into a `processJob(job)` async function
- `processQueue()` launches workers up to the limit; each worker calls `processQueue()` again when done to pick up remaining jobs
- `getQueueStatus()` now also returns `activeWorkers` count

**Result:** Under normal load (1–3 active sessions), all messages are processed immediately with no queue buildup.

**Key diff:**
```js
// Before: isProcessing flag, sequential while loop
let isProcessing = false;
async function processQueue() {
  isProcessing = true;
  while (redactionQueue.length > 0) { await processOneJob(); }
  isProcessing = false;
}

// After: concurrent pool
const CONCURRENCY_LIMIT = 5;
let activeWorkers = 0;

function processQueue() {
  while (redactionQueue.length > 0 && activeWorkers < CONCURRENCY_LIMIT) {
    const job = redactionQueue.shift();
    activeWorkers++;
    processJob(job).finally(() => {
      activeWorkers--;
      processQueue(); // pick up next job if available
    });
  }
}
```

## Files Modified
- `src/server/services/redaction.service.js`
- `src/server/services/redactionQueue.service.js`

## Files NOT Modified
- `SessionDetail.jsx` — RBAC logic untouched
- `index.js` / `logs.routes.js` — Socket emission logic untouched
- `secrets.js` — same OpenAI key, no new secrets needed

## Verification
1. Start the server, open a session as a researcher role
2. Send a message — `content_redacted` should populate in under 1 second
3. Check server logs: `🔒 Redacting message X...` and `Message X redacted successfully` should appear nearly immediately
4. With multiple simultaneous sessions, confirm messages from different sessions are processed concurrently (check log timestamps)
