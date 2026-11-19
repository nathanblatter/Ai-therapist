// Refusal screen for a session limit or the cooldown between sessions
// (ai-therapist-324). Before this, a 429 on session start showed a generic
// toast ("Please try again later"), with no time on typed chat and no crisis
// resources anywhere, even right after a session that ended on a crisis flag.
//
// Unlike QuietHoursScreen and StudyStatusScreen this one is dismissible: the
// limit is temporary and the participant may want to look at their progress
// or messages while they wait. Wording stays plain: someone hitting the
// cooldown is usually just between sessions, so the resources are offered,
// not pressed. Presentation only; the server is the boundary.
import { Clock, Phone, MessageSquare, X } from 'react-feather';
import { sessionLimitTitle, type SessionLimitNotice } from '../lib/sessionLimitNotice';

interface SessionLimitScreenProps {
  notice: SessionLimitNotice;
  onClose: () => void;
}

export default function SessionLimitScreen({ notice, onClose }: SessionLimitScreenProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-[60]" aria-hidden="true" onClick={onClose} />
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-limit-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-4 sm:p-6 max-h-[90vh] overflow-y-auto pointer-events-auto">
          <div className="flex items-start gap-3 mb-4">
            <div className="bg-blue-50 rounded-full p-3 flex-shrink-0">
              <Clock size={22} className="text-blue-600" aria-hidden="true" />
            </div>
            <h2 id="session-limit-title" className="flex-1 text-lg font-semibold text-gray-800 self-center">
              {sessionLimitTitle(notice.reason)}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
              aria-label="Close"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <p className="text-sm text-gray-700 mb-4" role="status">
            {notice.retryText}
          </p>

          <div className="bg-gray-50 rounded-xl p-4 mb-3">
            <p className="text-sm font-semibold text-gray-800 mb-3">
              If you would like support before then, these are free and open 24/7:
            </p>
            <div className="flex flex-col gap-2">
              <a
                href="tel:988"
                className="min-h-[44px] w-full flex items-center justify-center gap-2 rounded-xl bg-royal text-white font-semibold px-4"
              >
                <Phone size={16} aria-hidden="true" />
                Call 988
              </a>
              <a
                href="sms:988"
                className="min-h-[44px] w-full flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white text-gray-800 font-semibold px-4"
              >
                <MessageSquare size={16} aria-hidden="true" />
                Text 988
              </a>
            </div>
            <p className="text-xs text-gray-600 mt-3">
              988 is the Suicide &amp; Crisis Lifeline. You can also text HOME to{' '}
              <a href="sms:741741?&body=HOME" className="font-semibold underline">
                741741
              </a>{' '}
              (Crisis Text Line).
            </p>
          </div>

          <p className="text-xs text-gray-500 mb-4">
            If you are in immediate danger, call{' '}
            <a href="tel:911" className="font-semibold underline">
              911
            </a>
            . During the day, BYU Counseling and Psychological Services is at{' '}
            <a href="tel:8014223035" className="font-semibold underline">
              801-422-3035
            </a>
            .
          </p>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] w-full rounded-xl bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold"
          >
            Okay
          </button>
        </div>
      </div>
    </>
  );
}
