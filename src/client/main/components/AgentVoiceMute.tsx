// The participant's "mute the assistant's voice" control for voice sessions:
// the state hook App uses, the speaker button that sits next to the mic
// button (SessionControls), the status line under the orb, and the prompt
// pinned on the crisis resource card. Rules and the reasons for them are in
// lib/speakerMute.ts.
import { useState } from 'react';
import { Volume2, VolumeX } from 'react-feather';
import { createSpeakerMuteController, type SpeakerMuteApi } from '../lib/speakerMute';

/** Mute state for the current voice session. A new session always starts from `begin`. */
export function useSpeakerMute(): { muted: boolean; api: SpeakerMuteApi } {
  const [muted, setMuted] = useState(false);
  const [api] = useState(() =>
    createSpeakerMuteController({
      onChange: setMuted,
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    }),
  );
  return { muted, api };
}

/** Button label, tooltip and status wording. Participant-facing: tracked for the IRB. */
export const SPEAKER_MUTE_COPY = {
  ariaLabel: "Mute the assistant's voice",
  titleOn: "Mute the assistant's voice",
  titleMuted: "Unmute the assistant's voice",
  shortOn: 'Speaker On',
  shortMuted: 'Speaker Off',
  mutedStatus: "The assistant's voice is muted. What it says still appears below.",
  listenPrompt: 'Tap to hear the assistant',
  cardMutedStatus: "The assistant's voice is muted.",
} as const;

/**
 * The speaker button, next to the mic button. A toggle button: the label names
 * the action and aria-pressed says whether it is in effect (muted).
 */
export function SpeakerMuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={muted}
      aria-label={SPEAKER_MUTE_COPY.ariaLabel}
      title={muted ? SPEAKER_MUTE_COPY.titleMuted : SPEAKER_MUTE_COPY.titleOn}
      className={`p-3 sm:px-4 sm:py-2 rounded-full min-h-[48px] min-w-[48px] sm:min-h-[44px] flex items-center justify-center gap-2 shrink-0 border-2 focus:outline-none focus-visible:ring-4 focus-visible:ring-offset-2 focus-visible:ring-brand ${
        muted
          ? 'bg-amber-100 border-amber-600 text-amber-900 hover:bg-amber-200'
          : 'bg-surface border-gray-300 text-ink hover:bg-surface-muted'
      }`}
    >
      {muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
      <span className="hidden sm:inline text-sm font-medium">
        {muted ? SPEAKER_MUTE_COPY.shortMuted : SPEAKER_MUTE_COPY.shortOn}
      </span>
    </button>
  );
}

/** Persistent line under the orb while the assistant's voice is muted. */
export function AgentVoiceMutedNotice({ onUnmute }: { onUnmute: () => void }) {
  return (
    <div
      className="mx-3 mb-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900"
      role="status"
    >
      <VolumeX size={16} aria-hidden="true" className="shrink-0" />
      <span className="text-center">{SPEAKER_MUTE_COPY.mutedStatus}</span>
      <ListenButton onUnmute={onUnmute} />
    </div>
  );
}

/**
 * Pinned at the top of the crisis resource card while the voice is muted
 * (the crisis rule in lib/speakerMute.ts: never unmuted for the participant).
 */
export function CrisisListenPrompt({ onUnmute }: { onUnmute: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-xl border-2 border-amber-500 bg-amber-50 p-3 text-amber-900"
      role="status"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <VolumeX size={16} aria-hidden="true" className="shrink-0" />
        {SPEAKER_MUTE_COPY.cardMutedStatus}
      </p>
      <ListenButton onUnmute={onUnmute} wide />
    </div>
  );
}

// Hover dims rather than switching to amber-800: the dark theme flips the
// amber ramp, so hover:bg-amber-800 put white text on pale yellow there.
function ListenButton({ onUnmute, wide = false }: { onUnmute: () => void; wide?: boolean }) {
  return (
    <button
      type="button"
      onClick={onUnmute}
      className={`${wide ? 'w-full' : ''} min-h-[44px] inline-flex items-center justify-center gap-2 rounded-full bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-offset-2 focus-visible:ring-brand`}
    >
      <Volume2 size={16} aria-hidden="true" />
      {SPEAKER_MUTE_COPY.listenPrompt}
    </button>
  );
}
