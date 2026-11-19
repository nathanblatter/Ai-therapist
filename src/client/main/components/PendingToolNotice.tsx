// Shown while a voice screener, worksheet or safety plan waits for the
// server's confirmation (lib/voiceOverlayGate.ts). Usually that is a fraction
// of a second, so the notice fades in only after 400 ms (base.css
// .pending-notice-in). It never blocks the screen: no backdrop, no focus
// change, no pointer events, and it goes away when the overlay opens or the
// gate gives up. Not used for the crisis-resource card, which never waits.
import { Loader } from 'react-feather';

export const PENDING_TOOL_NOTICE_TEXT = 'Getting that ready for you…';

export default function PendingToolNotice({ pending }: { pending: boolean }) {
  if (!pending) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pending-notice-in fixed inset-x-4 bottom-28 z-30 flex justify-center pointer-events-none"
    >
      <p className="flex max-w-full items-center gap-2 rounded-full bg-gray-900/80 px-4 py-2 text-sm text-white shadow-lg">
        <Loader size={16} className="shrink-0 animate-spin" aria-hidden="true" />
        <span>{PENDING_TOOL_NOTICE_TEXT}</span>
      </p>
    </div>
  );
}
