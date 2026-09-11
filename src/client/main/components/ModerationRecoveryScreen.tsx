// Content-filter recovery screen.
//
// Incident 2026-09-11: a participant in a GPT-Live voice session disclosed
// suicidal intent. The assistant had begun the right response ("Hey, I'm really
// glad you told me.") when OpenAI's own content filter terminated the session
// mid-sentence. Our crisis pipeline behaved correctly (risk 100, flagged,
// on-call paged) — but the participant was dropped onto the generic
// post-session screen. We hung up on someone in crisis.
//
// This screen is what they see instead: a short, calm hold with crisis resources
// on it while the client brings the VOICE agent straight back on a crisis-support
// prompt and puts them back into the conversation, still talking. It is up for
// seconds, not minutes. Text is only reached after the voice attempts are spent.
//
// The recovery session carries no history by design — restating the disclosure
// that tripped the filter is the most likely way to trip it again — so this
// screen's copy is what tells the participant the drop was not their fault.
// It is presentation only; the recovery itself lives in App.tsx.
import { Heart, Loader, Phone, MessageSquare, AlertTriangle, RefreshCw } from 'react-feather';
import type { CrisisContact } from '../../../shared/systemConfig';

export type ModerationRecoveryStage =
  /** Bringing the voice agent back. The expected path, and the common one. */
  | 'voice'
  /** Voice attempts are spent; falling back to continuing in text. */
  | 'text'
  /** Everything failed. Resources stay up; the participant can retry. */
  | 'failed'
  /** No modality left to continue in (text disabled for this deployment). */
  | 'unavailable';

interface ModerationRecoveryScreenProps {
  stage: ModerationRecoveryStage;
  /** Configured crisis contact; the 988/741741/911 defaults are the fallback. */
  crisisContact: CrisisContact;
  onRetry: () => void;
}

const DEFAULT_HOTLINE = '988 Suicide & Crisis Lifeline';
const DEFAULT_PHONE = '988';
const DEFAULT_TEXT = 'HOME to 741741';

/** Digits only, for tel:/sms: hrefs. Falls back when a label has no number. */
function dialable(value: string, fallback: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : fallback;
}

export default function ModerationRecoveryScreen({
  stage,
  crisisContact,
  onRetry,
}: ModerationRecoveryScreenProps) {
  // The admin-configured contact wins when it is enabled; otherwise (and for any
  // blank field) the national defaults are used. A crisis screen must never
  // render without a number on it.
  const enabled = crisisContact.enabled !== false;
  const hotline = (enabled && crisisContact.hotline) || DEFAULT_HOTLINE;
  const phone = (enabled && crisisContact.phone) || DEFAULT_PHONE;
  const textLine = (enabled && crisisContact.text) || DEFAULT_TEXT;

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-[70]" aria-hidden="true" />
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="moderation-recovery-title"
      >
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-indigo-50 rounded-full p-3">
              <Heart size={22} className="text-indigo-600" aria-hidden="true" />
            </div>
            <h2 id="moderation-recovery-title" className="text-lg font-semibold text-gray-800">
              I&apos;m still here
            </h2>
          </div>

          <p className="text-sm text-gray-700 mb-2">
            The connection dropped — that wasn&apos;t your fault, and nothing you said was wrong.
          </p>

          {stage === 'voice' && (
            <p className="text-sm text-gray-700 mb-4 flex items-center gap-2" role="status">
              <Loader size={14} className="animate-spin text-indigo-600 flex-shrink-0" aria-hidden="true" />
              I&apos;m coming right back — hold on, just a few seconds.
            </p>
          )}

          {stage === 'text' && (
            <p className="text-sm text-gray-700 mb-4 flex items-center gap-2" role="status">
              <Loader size={14} className="animate-spin text-indigo-600 flex-shrink-0" aria-hidden="true" />
              The call won&apos;t hold right now, so I&apos;m bringing us back in writing instead.
              Stay with me.
            </p>
          )}

          {stage === 'failed' && (
            <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-3" role="alert">
              <p className="text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  I couldn&apos;t get us reconnected just now. You haven&apos;t done anything wrong.
                  You can try again below — and the numbers underneath are staffed right now, tonight,
                  whatever time it is.
                </span>
              </p>
            </div>
          )}

          {stage === 'unavailable' && (
            <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-3" role="alert">
              <p className="text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  I can&apos;t continue this conversation here right now. Please use one of the
                  numbers below — a real person will pick up, any time of day.
                </span>
              </p>
            </div>
          )}

          <div className="bg-red-50 rounded-xl p-4 mb-4">
            <p className="text-sm font-semibold text-red-900 mb-2">
              If you need someone right now, these are available 24/7:
            </p>
            <ul className="space-y-2 text-sm text-red-900">
              <li className="flex items-center gap-2">
                <Phone size={14} className="text-red-500 flex-shrink-0" aria-hidden="true" />
                <span>
                  <a href={`tel:${dialable(phone, DEFAULT_PHONE)}`} className="font-semibold underline">
                    {phone}
                  </a>{' '}
                  — {hotline} (call or text)
                </span>
              </li>
              <li className="flex items-center gap-2">
                <MessageSquare size={14} className="text-red-500 flex-shrink-0" aria-hidden="true" />
                <span>
                  Crisis Text Line — text{' '}
                  <a href={`sms:${dialable(textLine, '741741')}`} className="font-semibold underline">
                    {textLine}
                  </a>
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Phone size={14} className="text-red-500 flex-shrink-0" aria-hidden="true" />
                <span>
                  If you are in immediate danger, call{' '}
                  <a href="tel:911" className="font-semibold underline">911</a>
                </span>
              </li>
            </ul>
          </div>

          {stage === 'failed' && (
            <button
              type="button"
              onClick={onRetry}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl px-4 py-3"
            >
              <RefreshCw size={16} aria-hidden="true" />
              Try to reconnect
            </button>
          )}
        </div>
      </div>
    </>
  );
}
