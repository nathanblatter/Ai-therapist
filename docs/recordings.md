# Session recordings: tracks, lost audio and the sidecar

How a voice session's audio is recorded, what happens when audio is lost on
the way to the server, and how pause and timing analysis (prosody) must read
the participant track. Current since ai-therapist-384 (2026-11-19).

## What is stored

Gated by `features.session_recording_enabled` and the participant's latest
consent snapshot (`participant_consents.recording_enabled`). Per session, in
the recordings bucket under `sessions/<session id>/`:

| Object | What it is |
| --- | --- |
| `recording.wav` | The mix: participant mic plus assistant voice, mono PCM16, as heard (admin playback, safety review). |
| `participant.wav` | The participant's mic alone, pre-gain, mono PCM16 (migration 086). The input to prosody analysis. |
| `recording-tracks.json` | The sidecar: what each WAV contains, numbers only (below). |

Both tracks come from one Web Audio context in the browser
(`startMixedTee`, `src/client/main/lib/audioTee.ts`): every 4096-sample
callback produces one chunk for each track. Each track has its own uploader
(`src/client/main/lib/audioUploader.ts`), which numbers its chunks from 0;
the server (`src/server/services/recorder.service.ts`) appends them to a temp
file and stores the WAV when the session ends. The session row keeps each
track's key, status, duration, sample rate and size.

## Lost audio is filled with silence

Audio can be lost between the browser and the server: a batch refused or
unanswered through all its retries, the browser's waiting buffer overflowing
(it drops the oldest audio), or the unsent tail at the end of a session (the
3 s drain timed out, or the page went away and the beacon budget ran out).

The server sees every loss as a hole in the chunk numbers (`seq`) and writes
digital silence of exactly the missing length in its place: missing chunks
times the chunk size (4096 samples from the browser). A tail is filled the
same way when the client reported how many chunks it had captured (`pushed`,
sent with every batch and beacon). So:

- sample *n* of `participant.wav` is chunk-index time *n* on the client, for
  the whole session, not just up to the first loss;
- `recording.wav` and `participant.wav` stay sample-aligned with each other
  (sidecar `tracksAligned`);
- the stored duration is the full timeline, inserted silence included.

Caps, so a bogus index cannot write gigabytes: one fill is at most 60 s, and
a track's fills together at most the session's wall-clock span (first audio
arrival to now) plus 60 s. A capped fill is listed with `capped: true` and
`missingSamples`; the track's timeline is not intact after it
(`timelineIntact: false`).

Chunks whose index has already passed (a retry the server had in fact stored,
or a late arrival whose place was already filled) are dropped and counted
(`chunksStale`); the server never reorders audio.

**Inserted silence is exact zeros, exactly like a muted mic and like true
digital silence.** Nothing in the WAV tells them apart. That is what the
sidecar is for.

## The sidecar: `recording-tracks.json`

Written at finalisation next to the WAVs, deleted with them by the retention
job. Numbers only: no transcript, no audio, no identifier beyond the session
the path already names. Positions and lengths are in **samples of that
track's WAV** (divide by `sampleRate` for seconds); ranges are half-open,
`[start, start + length)`. Defined in
`src/server/services/recordingSidecar.ts`.

```json
{
  "version": 1,
  "tracksAligned": true,
  "tracks": {
    "mixed": { "...": "same fields as participant" },
    "participant": {
      "object": "participant.wav",
      "sampleRate": 48000,
      "totalSamples": 6717440,
      "sequenced": true,
      "chunkSamples": 4096,
      "chunksReceived": 1630,
      "chunksStale": 0,
      "chunksMissing": 10,
      "clientChunksPushed": 1640,
      "insertedSilenceSamples": 40960,
      "gapCount": 2,
      "gaps": [
        { "start": 0, "length": 4096, "chunks": 1, "reason": "sequence_gap" },
        { "start": 2457600, "length": 36864, "chunks": 9, "reason": "sequence_gap" }
      ],
      "gapsTruncated": false,
      "muted": [{ "start": 327680, "length": 81920 }],
      "mutedSamples": 81920,
      "mutedTruncated": false,
      "timelineIntact": true,
      "complete": false
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `sampleRate`, `totalSamples` | Of the WAV, inserted silence included. |
| `sequenced` | The client numbered its chunks (every client since PR #95). `false`: an older client; nothing was filled and losses are unknown. |
| `chunkSamples` | Chunk size used to size the fills. |
| `chunksReceived` / `chunksStale` / `chunksMissing` | Chunks of real audio written; dropped as duplicates or late; known never to have arrived (gaps and lost tail). |
| `clientChunksPushed` | The highest count of captured chunks the client reported; `null` if it reported none. |
| `gaps` | Inserted silence. `reason`: `sequence_gap` (between two chunks that arrived) or `lost_tail` (after the last one). `capped` / `missingSamples` on a capped fill. At most 5,000 listed (`gapsTruncated`); `gapCount` and `insertedSilenceSamples` cover all. |
| `muted` | Real audio recorded while the participant's mic was muted, built from the per-chunk `muted` flag the client sends with every chunk (more reliable than the `mic_timeline` toggle event). Muted stretches either side of a gap are listed separately. At most 5,000 listed (`mutedTruncated`); `mutedSamples` covers all. Empty for the mix. |
| `timelineIntact` | Sequenced and no capped fill: sample *n* is chunk-index time *n*. |
| `complete` | Sequenced, nothing missing, no server write error. `null` when not sequenced (unknown). |
| `tracksAligned` | Both tracks present, both timelines intact, same rate and chunk size. Lengths can still differ at the end (one track's tail unknown). |

Staff see it in the admin session view, under each player, as one line, for
example `2:20 long • 1.2 s of silence inserted for lost audio in 2 gaps • 30.0 s muted`
(the mix shows no muted time), and can download the whole file with
**Track data (JSON)** (`GET /admin/api/sessions/:id/recording-tracks?download=1`,
same access rules as playback). The dataset export does not carry it; the
sidecar travels with the WAVs.

## Pause and timing analysis must exclude gaps and muted stretches

Before measuring pauses, speech rate or timing on `participant.wav`, drop every
range in `gaps` and in `muted`, and treat a silent run that touches one as of
unknown length (not a pause):

```python
import json, soundfile as sf
side = json.load(open("recording-tracks.json"))["tracks"]["participant"]
audio, sr = sf.read("participant.wav", dtype="int16")
assert sr == side["sampleRate"] and len(audio) == side["totalSamples"]
excluded = sorted((r["start"], r["start"] + r["length"]) for r in side["gaps"] + side["muted"])
# keep = audio outside every excluded range; restart pause detection after each one
```

Also check `timelineIntact` (after a capped fill, positions past it are not
the client's time) and `sequenced` (an older client: losses are unknown, the
track may be short). The built-in acoustic feature job
(`acousticFeatures.service.ts`, off unless `features.telemetry_acoustic_features`)
already does this: frames touching an excluded range are left out of every
measure, a pause cut by one is not counted, and `excluded_ms` records how much
was left out. Recordings without a sidecar are measured whole.

## Client timelines and the WAVs

- `mic_timeline` (client event): mic on/off toggles as ms in the participant
  uploader's own audio time. With the gap fill, these are also positions in
  `participant.wav` (ms times `sampleRate` / 1000), except after a capped fill
  and in a tail the client never reported. The sidecar's `muted` ranges are
  the authoritative version.
- `speaker_timeline` (client event, assistant voice mute): ms on the browser's
  monotonic clock from when the voice session began setting up, before the mic
  and the connection. Wall-clock time, not audio samples, so it runs ahead of
  the WAVs by the connect time and lines up only approximately.
- A suspended page (iOS background) captures nothing on either track: no chunks
  are numbered, so nothing is filled, and both tracks are shorter than the wall
  clock alike. The participant-track check compares the received audio (track
  length minus inserted silence) with the longer of the mix and the wall clock.

## Old clients during a deploy

A browser that loaded the app before a deploy keeps its old uploader until it
reloads. Clients from before PR #95 send no `seq`, `muted` or `pushed`: their
chunks are appended exactly as before (no fill), and the sidecar says
`sequenced: false`. Clients from PR #95 send `seq` and `muted` but not `pushed`:
gaps are filled, a lost tail is not (`clientChunksPushed: null`).

## Limits

- A tail lost when no batch carrying the final count reached the server (the
  drain timed out on a stalled connection) is not filled: the track ends early
  and nothing before that point moves.
- Inserted silence is sized from the chunk size; the browser's chunks are all
  4096 samples, so this is exact.

## IRB ledger note (recordings made before these fixes)

For the study's record (no IRB instrument is changed here):

- **Every participant track recorded before PR #95 reached an environment is
  incomplete.** From 2026-09-04 (commit 0f8d19d) the browser's 64 KiB
  keepalive quota silently refused most participant-track batches, so those
  `participant.wav` files hold a fraction of a second to a few seconds of a
  session. PR #95 reached stage on 2026-11-19; prod keeps the defect until it
  is promoted (Flightdeck ai-therapist-360). These tracks cannot support
  participant-track prosody.
- Recordings made between PR #95 and this change (ai-therapist-384) have no
  sidecar, and any loss shortened the track instead of being filled: the
  positions of the losses exist only in server warn logs
  (`audio sequence gap`). Timing measures on them are valid only up to the
  first loss.
- The issue record (ai-therapist-372) names the participant track as the one
  the keepalive defect emptied; the mix (`recording.wav`) has the same pre-384
  shortening on any loss.

## Checks

- `src/server/services/recorder.service.test.ts` (fills, caps, stale chunks,
  alignment, muted ranges, old clients, the sidecar) and
  `src/client/main/lib/audioUploader.test.ts` (`pushed`, page-hide beacons
  that never span a hole in the numbering).
- `npx vitest run --config scripts/recording-gaps-check.config.ts`: the real
  uploader in headless Chromium against a local stub that feeds the real
  recorder, with batches refused on every attempt and a stalled connection
  ended by a page hide; reads back the PCM and checks length, positions and
  alignment against the sidecar. Needs `npx playwright install
  chromium-headless-shell` once; not part of `npm test`.
