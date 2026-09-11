// Which voices have a bundled preview clip.
//
// The voice picker offers a play button so participants can hear a voice before
// committing to a session with it. Preview audio is checked into
// assets/audio/voices as <voice>.mp3 — but only for the ten Realtime-era
// voices. The twelve voices introduced with gpt-live-1 ship no clip, so the
// picker has to know which buttons to render rather than offering one that 404s.
//
// The directory is scanned once at startup and cached. These are static repo
// assets that cannot change while the process runs, so an fs.existsSync per
// voice per request would be pure overhead.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/server/utils -> repo root -> assets/audio/voices
const VOICES_DIR = path.resolve(__dirname, '../../../assets/audio/voices');

let previewCache: Set<string> | null = null;

function loadPreviews(): Set<string> {
  const available = new Set<string>();
  try {
    for (const file of fs.readdirSync(VOICES_DIR)) {
      if (file.endsWith('.mp3')) available.add(path.basename(file, '.mp3'));
    }
  } catch (err) {
    // A missing assets directory is not fatal: every voice simply reports no
    // preview and the picker hides the play controls.
    console.warn('[Voices] Could not read voice preview directory:', err);
  }
  return available;
}

/** Whether a preview clip is bundled for this voice. */
export function voicePreviewExists(voice: string): boolean {
  if (!previewCache) previewCache = loadPreviews();
  return previewCache.has(voice);
}

/** Every voice with a bundled preview clip. */
export function voicesWithPreviews(): string[] {
  if (!previewCache) previewCache = loadPreviews();
  return Array.from(previewCache).sort();
}

/** Test hook: drop the cached scan. */
export function _resetPreviewCacheForTests(): void {
  previewCache = null;
}
