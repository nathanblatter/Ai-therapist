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

/**
 * Persistent line under the orb while the assistant's voice is muted. One
 * compact row (text left, button right) at every width: while muted the
 * captions below are the only channel, so this takes as little of the chat
 * log as it can.
 */
export function AgentVoiceMutedNotice({ onUnmute }: { onUnmute: () => void }) {
  return (
    <div
      className="mx-3 mb-1 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 py-1 pl-2 pr-1 text-amber-900 sm:gap-3 sm:px-3"
      role="status"
    >
      <VolumeX size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 text-xs leading-tight sm:text-sm sm:leading-snug">
        {SPEAKER_MUTE_COPY.mutedStatus}
      </span>
      <ListenButton onUnmute={onUnmute} />
    </div>
  );
}

/**
 * Pinned at the top of the crisis resource card while the voice is muted
 * (the crisis rule in lib/speakerMute.ts: never unmuted for the participant).
 * One compact row, so the crisis numbers below it move down as little as
 * possible.
 */
export function CrisisListenPrompt({ onUnmute }: { onUnmute: () => void }) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl border-2 border-amber-500 bg-amber-50 py-1 pl-2 pr-1 text-amber-900"
      role="status"
    >
      <VolumeX size={14} aria-hidden="true" className="shrink-0" />
      <p className="min-w-0 flex-1 text-xs font-medium leading-tight sm:text-sm sm:leading-snug">
        {SPEAKER_MUTE_COPY.cardMutedStatus}
      </p>
      <ListenButton onUnmute={onUnmute} />
    </div>
  );
}

// Narrow on phones (label on two short lines inside the 44 px target, no
// icon) so the status text beside it keeps most of the row.
// Hover dims rather than switching to amber-800: the dark theme flips the
// amber ramp, so hover:bg-amber-800 put white text on pale yellow there.
function ListenButton({ onUnmute }: { onUnmute: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnmute}
      className="min-h-[44px] max-w-[8rem] shrink-0 inline-flex items-center justify-center gap-1.5 rounded-full bg-amber-700 px-3 py-1 text-left text-xs font-semibold leading-tight text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-offset-2 focus-visible:ring-brand sm:max-w-none sm:text-sm"
    >
      <Volume2 size={14} aria-hidden="true" className="hidden shrink-0 sm:block" />
      <span>{SPEAKER_MUTE_COPY.listenPrompt}</span>
    </button>
  );
}
