// GPT-Live session forking.
//
// A stored Live session can be branched: `wss://api.openai.com/v1/live/sessions/
// {id}/fork` starts a NEW session (new id) from the source's saved state. The
// fork inherits the source configuration, but `session.start` may override the
// Responses delegation settings — and that override is the whole point here.
// It lets us ask a question that was unanswerable under the Realtime API:
// holding the conversation and the voice layer fixed, what would a DIFFERENT
// reasoning backend have said at this moment?
//
// Constraints, all from the fork reference and the session guide:
//   - The source session must have been created with `store: true`. Storage
//     defaults to false and must be enabled for the project.
//   - Recordings expire after 30 days, so a session is only forkable for that
//     window.
//   - Under Zero Data Retention, `store` is treated as false and forks are
//     unavailable outright.
//   - A fork does NOT inherit the source audio format. PCM16 at 24 kHz is the
//     default and what we use.
//   - Do not supply a new voice `model` on the fork. Only the delegated backend
//     is swappable.
//   - Wait for `session.started` before sending anything else.
//
// This service is eval-only. Nothing on the participant path forks a session.

import WebSocket from 'ws';

export interface ForkOptions {
  /** Stored source session id (opaque; pass through unchanged). */
  sourceSessionId: string;
  apiKey: string;
  /** Backend model to run this branch on — the counterfactual lever. */
  backendModel: string;
  /** Backend prompt. Omit to inherit the source session's. */
  backendInstructions?: string;
  /** Participant utterance to probe the branch with. */
  probeText: string;
  /** Hard cap on the whole fork lifecycle. */
  timeoutMs?: number;
}

export interface ForkResult {
  forkSessionId: string | null;
  /** Delegated backend output — the reasoning under test. */
  responseText: string;
  /** What the voice model actually said. GPT-Live paraphrases, so these differ. */
  spokenText: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  /** Voice seconds the fork itself billed. */
  voiceSeconds: number | null;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Fork a stored session onto a different backend and probe it with one
 * utterance.
 *
 * Always resolves — a rejected model, a missing recording or a timeout comes
 * back as `error` rather than throwing, because the caller is sweeping many
 * candidates and one unsupported model must not abort the sweep. OpenAI
 * publishes no allowlist of valid delegation backends, so discovering the
 * unsupported set IS part of what this harness is for.
 */
export async function forkAndProbe(opts: ForkOptions): Promise<ForkResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(opts.sourceSessionId)}/fork`;

  const result: ForkResult = {
    forkSessionId: null,
    responseText: '',
    spokenText: '',
    tokensIn: null,
    tokensOut: null,
    latencyMs: 0,
    voiceSeconds: null,
    error: null,
  };

  return new Promise<ForkResult>(resolve => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });

    let settled = false;
    let probeSentAt = 0;
    // Set once the backend response completes. The fork is closed from there
    // rather than on first audio, because the delegated output is the signal.
    let gotResponse = false;

    const finish = (error?: string | null) => {
      if (settled) return;
      settled = true;
      if (error && !result.error) result.error = error;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(gotResponse ? null : `fork timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    ws.on('open', () => {
      // Override ONLY the delegation block. Omitted settings are inherited,
      // and supplying a voice `model` is explicitly rejected.
      const responses: Record<string, unknown> = { model: opts.backendModel };
      if (opts.backendInstructions) responses.instructions = opts.backendInstructions;

      ws.send(JSON.stringify({
        type: 'session.start',
        session: {
          delegation: { type: 'responses', responses },
          // A WebSocket fork does not inherit the source audio format; set it
          // explicitly rather than relying on the default staying PCM16/24k.
          audio: { format: { type: 'audio/pcm', rate: 24000 } },
          // Never store the branch itself. These are throwaway eval sessions
          // and storing them would pile up recordings for no purpose.
          store: false,
        },
      }));
    });

    ws.on('message', raw => {
      let event: { type?: string; [k: string]: unknown };
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (event.type) {
        case 'session.started': {
          const session = event.session as { id?: string } | undefined;
          result.forkSessionId = session?.id ?? null;
          probeSentAt = Date.now();
          // Queue the participant utterance for the backend, then run it.
          // response.create uses the session's configured backend — it must not
          // carry a request body or a model override.
          ws.send(JSON.stringify({
            type: 'response.item.create',
            event_id: 'probe_item',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: opts.probeText }],
            },
          }));
          ws.send(JSON.stringify({ type: 'response.create', event_id: 'probe_run' }));
          break;
        }

        // What the voice model says. Fragments, concatenated exactly as
        // received.
        case 'session.output_transcript.delta':
          result.spokenText += String(event.delta ?? '');
          break;

        // Nested Responses events arrive wrapped; dispatch on the INNER type.
        case 'response.event': {
          const inner = event.event as { type?: string; [k: string]: unknown } | undefined;
          if (!inner?.type) break;

          if (inner.type === 'response.output_text.delta') {
            result.responseText += String(inner.delta ?? '');
          } else if (inner.type === 'response.completed') {
            const response = inner.response as {
              usage?: { input_tokens?: number; output_tokens?: number };
            } | undefined;
            result.tokensIn = response?.usage?.input_tokens ?? null;
            result.tokensOut = response?.usage?.output_tokens ?? null;
            result.latencyMs = probeSentAt ? Date.now() - probeSentAt : 0;
            gotResponse = true;
            // Close gracefully so session.closed reports final voice usage.
            ws.send(JSON.stringify({ type: 'session.close', event_id: 'probe_close' }));
          } else if (inner.type === 'response.failed' || inner.type === 'response.incomplete') {
            const response = inner.response as { status_details?: { reason?: string } } | undefined;
            finish(`backend response ${inner.type}: ${response?.status_details?.reason ?? 'unknown'}`);
          }
          break;
        }

        case 'session.usage.updated': {
          const usage = event.usage as { seconds?: number } | undefined;
          // Cumulative snapshot — assign, never accumulate.
          if (typeof usage?.seconds === 'number') result.voiceSeconds = usage.seconds;
          break;
        }

        case 'session.closed': {
          const usage = event.usage as { seconds?: number } | undefined;
          if (typeof usage?.seconds === 'number') result.voiceSeconds = usage.seconds;
          finish();
          break;
        }

        case 'error': {
          const err = event.error as { message?: string; code?: string } | undefined;
          // An invalid backend model surfaces here. Record and stop — this is
          // the expected outcome for a model that is not a supported
          // delegation backend.
          finish(`${err?.code ?? 'error'}: ${err?.message ?? 'unknown API error'}`);
          break;
        }

        default:
          break;
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        // 404 here usually means the source session was never stored, its
        // 30-day recording window has expired, or the project is ZDR.
        finish(`fork rejected: HTTP ${res.statusCode} — ${body.slice(0, 300) || '(empty body)'}`);
      });
    });

    ws.on('error', err => finish(`socket error: ${err.message}`));
    ws.on('close', () => finish(gotResponse ? null : 'socket closed before the backend responded'));
  });
}
