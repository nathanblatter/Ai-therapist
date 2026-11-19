// The parts of the chat view that exist only after a text hand-off: the voice
// vendor ended the call and the conversation continues in writing
// (ai-therapist-356; wording and rules in shared/textHandoff.ts).
//
// Three pieces, all presentation; the hand-off itself lives in App.tsx:
//
//  - PinnedCrisisCard: one-tap Call 988 / Text 988 / Call 911, fixed above the
//    conversation for as long as the hand-off chat is open. Plain links built
//    from values already in the page: nothing here waits on a model, the
//    server or the network, so it works when everything else has failed.
//  - HandoffReplyBar: one-tap answers to the question the first message asks
//    (they send as ordinary participant messages), a "writing a reply" line
//    while the assistant's answer is on its way, and the way back to voice
//    once the server says the risk check has cleared.
//  - useVisualViewportHeight: keeps the input above the on-screen keyboard.
//
// Phone first: most participants are on phones. 16px gutters, 48px targets (docs/mobile-audit).
import { useEffect, useState } from 'react';
import { Loader, MessageSquare, Mic, Phone } from 'react-feather';
import type { CrisisContact } from '../../../shared/systemConfig';
import type { HandoffKind } from '../../../shared/textHandoff';

const DEFAULT_PHONE = '988';
const DEFAULT_TEXT_LINE = 'HOME to 741741';

/** Digits only, for tel:/sms: hrefs. Falls back when a label has no number. */
function dialable(value: string, fallback: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : fallback;
}

export interface CrisisLineActions {
  call: { label: string; href: string };
  text: { label: string; href: string };
  emergency: { label: string; href: string };
}

/**
 * The three one-tap actions, from the configured crisis contact with the
 * national lines as the fallback for anything blank or disabled: a crisis card
 * never renders without numbers on it.
 *
 * 988 takes texts as well as calls, so with the default contact both actions
 * go to 988. A deployment with its own phone line texts its configured text
 * line instead (a local number may not accept texts).
 */
export function crisisLineActions(contact: CrisisContact | null | undefined): CrisisLineActions {
  const enabled = contact != null && contact.enabled !== false;
  const phone = (enabled && contact.phone?.trim()) || DEFAULT_PHONE;
  const textLine = (enabled && contact.text?.trim()) || DEFAULT_TEXT_LINE;
  const phoneDigits = dialable(phone, DEFAULT_PHONE);
  const text =
    phoneDigits === DEFAULT_PHONE
      ? { label: `Text ${DEFAULT_PHONE}`, href: `sms:${DEFAULT_PHONE}` }
      : { label: `Text ${textLine}`, href: `sms:${dialable(textLine, '741741')}` };
  return {
    call: { label: `Call ${phone}`, href: `tel:${phoneDigits}` },
    text,
    emergency: { label: 'Call 911', href: 'tel:911' },
  };
}

interface PinnedCrisisCardProps {
  crisisContact: CrisisContact;
  /** `crisis` and `ceiling` draw the card in the alert colours; `neutral`
   *  keeps it on screen in the page's ordinary colours. */
  kind: HandoffKind;
  /** Opens the app's full resource card (campus and other lines). Optional:
   *  the three one-tap actions never depend on it. */
  onMoreResources?: () => void;
}

export function PinnedCrisisCard({ crisisContact, kind, onMoreResources }: PinnedCrisisCardProps) {
  const actions = crisisLineActions(crisisContact);
  const alert = kind !== 'neutral';
  const frame = alert ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200';
  const caption = alert ? 'text-red-900' : 'text-gray-700';
  const button = alert
    ? 'bg-white border-red-300 text-red-900 active:bg-red-100'
    : 'bg-gray-50 border-gray-300 text-gray-800 active:bg-gray-100';
  const icon = alert ? 'text-red-600' : 'text-gray-500';
  const item =
    `min-h-[48px] flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 ` +
    `text-sm font-semibold text-center leading-tight ${button}`;

  return (
    <section
      aria-label="Crisis lines"
      data-testid="pinned-crisis-card"
      className={`w-full flex-shrink-0 border-b px-4 py-2 ${frame}`}
    >
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className={`text-xs font-semibold ${caption}`}>
            {alert
              ? 'If you need a person right now, these lines answer day and night:'
              : 'Crisis lines, answered day and night:'}
          </p>
          {onMoreResources && (
            <button
              type="button"
              onClick={onMoreResources}
              className={`min-h-[48px] min-w-[44px] flex-shrink-0 px-1 text-xs font-semibold underline ${caption}`}
            >
              More
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <a href={actions.call.href} className={item}>
            <Phone size={16} className={`flex-shrink-0 ${icon}`} aria-hidden="true" />
            <span>{actions.call.label}</span>
          </a>
          <a href={actions.text.href} className={item}>
            <MessageSquare size={16} className={`flex-shrink-0 ${icon}`} aria-hidden="true" />
            <span>{actions.text.label}</span>
          </a>
          <a href={actions.emergency.href} className={item}>
            <Phone size={16} className={`flex-shrink-0 ${icon}`} aria-hidden="true" />
            <span>{actions.emergency.label}</span>
          </a>
        </div>
      </div>
    </section>
  );
}

interface HandoffReplyBarProps {
  /** One-tap answers still on offer; empty once the participant has answered. */
  quickReplies: string[];
  onQuickReply: (reply: string) => void;
  /** A participant message has been sent and the assistant's reply is not back yet. */
  awaitingReply: boolean;
  /** The server says the risk check has cleared (shared/textHandoff.ts). */
  voiceReturnAllowed: boolean;
  onReturnToVoice: () => void;
  /** A return to voice is being started. */
  returningToVoice: boolean;
}

export function HandoffReplyBar({
  quickReplies,
  onQuickReply,
  awaitingReply,
  voiceReturnAllowed,
  onReturnToVoice,
  returningToVoice,
}: HandoffReplyBarProps) {
  const showReplies = quickReplies.length > 0 && !awaitingReply;
  if (!showReplies && !awaitingReply && !voiceReturnAllowed) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="handoff-reply-bar">
      {awaitingReply && (
        <p className="flex items-center gap-2 text-sm text-gray-600 px-1" role="status">
          <Loader size={14} className="animate-spin flex-shrink-0" aria-hidden="true" />
          Writing a reply...
        </p>
      )}
      {showReplies && (
        <div role="group" aria-label="Quick replies" className="flex gap-2">
          {quickReplies.map((reply) => (
            <button
              key={reply}
              type="button"
              onClick={() => onQuickReply(reply)}
              className="flex-1 min-h-[48px] rounded-full border-2 border-royal bg-white text-royal text-base font-semibold px-3 py-2 active:bg-blue-50"
            >
              {reply}
            </button>
          ))}
        </div>
      )}
      {voiceReturnAllowed && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onReturnToVoice}
            disabled={returningToVoice || awaitingReply}
            className="min-h-[48px] w-full flex items-center justify-center gap-2 rounded-full border border-gray-300 bg-white text-gray-800 text-sm font-semibold px-4 py-2 disabled:opacity-60"
          >
            {returningToVoice ? (
              <Loader size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Mic size={16} aria-hidden="true" />
            )}
            {returningToVoice ? 'Starting a voice call...' : 'Go back to voice'}
          </button>
          <p className="text-xs text-gray-500 text-center">
            This starts a new voice call. You can also keep writing here.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Height of the visible viewport in CSS pixels while `active`, else null.
 *
 * On phones the on-screen keyboard shrinks the VISUAL viewport, not the layout
 * viewport the page is sized to, so a full-height column keeps its input
 * underneath the keyboard. Sizing the column to this value (and holding the
 * page at the top) keeps the pinned crisis card, the last messages and the
 * input all on screen while typing. Null when the browser has no
 * visualViewport: the page then keeps its ordinary height.
 */
export function useVisualViewportHeight(active: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) {
      setHeight(null);
      return;
    }
    const update = () => {
      setHeight(Math.round(viewport.height));
      // iOS scrolls the page to reveal a focused input; with the column sized
      // to the visible area there is nothing to scroll to, so hold it at 0.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [active]);
  return height;
}
