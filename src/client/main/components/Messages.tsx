// Participant Messages view (caseworker portal, docs/caseworker-portal.md
// section 4): thread list -> conversation with a care-team member. Styling
// matches the Home.tsx card language. Two safety fixtures are always present:
//  - a permanent "not for emergencies" banner with the crisis shortcuts
//    (numbers from /api/config/crisis, hardcoded 988/741741 fallback), and
//  - a supportive-resources banner under any message the safety scan flagged.
// Frozen threads render read-only with an explanation instead of a composer.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Clock, Info, Lock, MessageSquare, Phone, Send } from 'react-feather';
import { useMessaging, type ParticipantMessage, type ParticipantThread } from '../hooks/useMessaging';
import { timeLabel } from '../../shared/format';
import type { CrisisContact } from '../../../shared/systemConfig';

// Rendered contact always has defaults filled in, so no optional fields.
// CrisisContact.enabled is intentionally unread here: the safety banners
// always show a hotline regardless of the admin toggle.
type DisplayCrisisContact = { hotline: string; phone: string; text: string };

const DEFAULT_CRISIS: DisplayCrisisContact = {
  hotline: '988 Suicide & Crisis Lifeline',
  phone: '988',
  text: 'Text HOME to 741741',
};

function clinicianLabel(thread: ParticipantThread): string {
  const name = thread.counterpart_username || 'Your care team';
  const role = thread.clinician_role === 'caseworker' ? 'Care coordinator' : 'Therapist';
  return `${name} (${role})`;
}

/** Permanent disclaimer: messaging is asynchronous, never a crisis channel. */
function NotForEmergenciesBanner({ crisis }: { crisis: DisplayCrisisContact }) {
  return (
    <div className="bg-blue-50 rounded-2xl p-4 flex items-start gap-3">
      <Info size={16} className="text-blue-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="text-sm text-blue-900">
        <p>
          Messages are usually answered within 1&ndash;2 business days and are not monitored in
          real time. If you need help right now:
        </p>
        <p className="mt-1 font-medium">
          Call or text <a href={`tel:${crisis.phone}`} className="underline">{crisis.phone}</a>
          {' '}&mdash; the {crisis.hotline} &mdash; or {crisis.text.toLowerCase().startsWith('text') ? crisis.text : `text ${crisis.text}`}.
        </p>
      </div>
    </div>
  );
}

/** Supportive-resources note shown under a message the safety scan flagged. */
function FlaggedSupportNote({ crisis }: { crisis: DisplayCrisisContact }) {
  return (
    <div className="mt-1 bg-red-50 rounded-xl px-3 py-2 flex items-start gap-2 max-w-[85%]">
      <Phone size={14} className="text-red-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <p className="text-xs text-red-900">
        It sounds like things might be heavy right now. Your care team has been notified and will
        follow up, but they may not see this immediately. If you are in danger or need support
        right now, call or text <a href={`tel:${crisis.phone}`} className="font-semibold underline">{crisis.phone}</a> any
        time, day or night.
      </p>
    </div>
  );
}

function MessageBubble({ message, crisis }: { message: ParticipantMessage; crisis: DisplayCrisisContact }) {
  const mine = message.sender_role === 'participant';
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words ${
          mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'
        }`}
      >
        {message.body}
      </div>
      <p className="text-[11px] text-gray-400 mt-0.5 px-1">{timeLabel(message.created_at)}</p>
      {mine && message.flagged && <FlaggedSupportNote crisis={crisis} />}
    </div>
  );
}

export default function Messages() {
  const messaging = useMessaging({ active: true });
  const [crisis, setCrisis] = useState<DisplayCrisisContact>(DEFAULT_CRISIS);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config/crisis', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then((data: Partial<CrisisContact> | null) => {
        if (!cancelled && data && data.phone) {
          setCrisis({
            hotline: data.hotline || DEFAULT_CRISIS.hotline,
            phone: data.phone,
            text: data.text || DEFAULT_CRISIS.text,
          });
        }
      })
      .catch(() => { /* fallback stands */ });
    return () => { cancelled = true; };
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messaging.messages.length]);

  const send = async () => {
    if (!draft.trim() || messaging.sending) return;
    const ok = await messaging.sendMessage(draft);
    if (ok) setDraft('');
  };

  const thread = messaging.selectedThread;

  // ---------- conversation view ----------
  if (thread) {
    const frozen = thread.status === 'frozen';
    return (
      <div className="w-full max-w-2xl mx-auto px-1 sm:px-4 py-4 space-y-3 flex flex-col h-full">
        <div className="flex items-center gap-3">
          <button
            onClick={() => messaging.selectThread(null)}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Back to conversations"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-800 truncate">{clinicianLabel(thread)}</h2>
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <Clock size={12} aria-hidden="true" /> Replies within 1&ndash;2 business days
            </p>
          </div>
        </div>

        <NotForEmergenciesBanner crisis={crisis} />

        <div className="bg-white rounded-2xl shadow p-4 flex-1 overflow-y-auto min-h-[200px]">
          {messaging.loadingMessages && messaging.messages.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">Loading your conversation&hellip;</p>
          ) : messaging.messages.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">
              No messages yet. Say hello &mdash; your care team will reply here.
            </p>
          ) : (
            <div className="space-y-3">
              {messaging.messages.map(m => (
                <MessageBubble key={m.message_id} message={m} crisis={crisis} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {messaging.error && (
          <p className="text-sm text-red-600 px-1" role="alert">{messaging.error}</p>
        )}

        {frozen ? (
          <div className="bg-gray-50 rounded-2xl p-4 flex items-start gap-3">
            <Lock size={16} className="text-gray-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-gray-500">
              This conversation is closed because this member is no longer part of your care team.
              You can still read your past messages here.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow p-3 flex items-end gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              maxLength={4000}
              rows={2}
              placeholder="Write a message to your care team"
              className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 text-gray-700 resize-none"
            />
            <button
              onClick={() => void send()}
              disabled={messaging.sending || !draft.trim()}
              className="flex-shrink-0 p-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Send message"
            >
              <Send size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------- thread list ----------
  return (
    <div className="w-full max-w-2xl mx-auto px-1 sm:px-4 py-4 space-y-4">
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-gray-800">Messages</h2>
        <p className="text-sm text-gray-400 mt-1">
          A private, unhurried way to reach your care team between conversations.
        </p>
      </div>

      <NotForEmergenciesBanner crisis={crisis} />

      <div className="bg-white rounded-2xl shadow p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare size={18} className="text-blue-600" aria-hidden="true" />
          <h3 className="text-base font-semibold text-gray-800">Your conversations</h3>
        </div>
        {messaging.loadingThreads && messaging.threads.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">Loading&hellip;</p>
        ) : messaging.threads.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            You do not have any message conversations yet. When a member of your care team starts
            one, it will appear here.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {messaging.threads.map(t => (
              <li key={t.thread_id}>
                <button
                  onClick={() => messaging.selectThread(t.thread_id)}
                  className="w-full flex items-center gap-3 py-3 text-left hover:bg-gray-50 rounded-lg px-2 -mx-2 min-h-[44px]"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {clinicianLabel(t)}
                      {t.status === 'frozen' && (
                        <span className="ml-2 text-xs text-gray-400 font-normal">(closed)</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {t.last_message_preview || 'No messages yet'}
                    </p>
                  </div>
                  {(t.unread_count ?? 0) > 0 && (
                    <span className="flex-shrink-0 text-xs font-semibold text-white bg-blue-600 rounded-full px-2 py-0.5">
                      {t.unread_count}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 flex-shrink-0">{timeLabel(t.last_message_at)}</span>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
