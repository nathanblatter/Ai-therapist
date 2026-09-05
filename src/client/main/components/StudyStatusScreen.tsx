// Blocking screen for withdrawn/paused participants (UX-audit fix). The
// server middleware (middleware/studyStatus.ts) refuses new sessions with
// 403 {error:'study_status'}; without this screen the client fell through to
// a generic "check your connection" toast — telling a person who just
// withdrew from a mental-health study that the server is broken, with no
// crisis resources. Mirrors QuietHoursScreen: presentation only, the server
// remains the security boundary.
import { PauseCircle, Phone, MessageSquare, Mail } from 'react-feather';

interface StudyStatusScreenProps {
  status: 'paused' | 'withdrawn';
}

export default function StudyStatusScreen({ status }: StudyStatusScreenProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-[60]" aria-hidden="true" />
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="study-status-title"
      >
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-amber-50 rounded-full p-3">
              <PauseCircle size={22} className="text-amber-600" aria-hidden="true" />
            </div>
            <h2 id="study-status-title" className="text-lg font-semibold text-gray-800">
              {status === 'paused' ? 'Your participation is paused' : 'You have left the study'}
            </h2>
          </div>

          <p className="text-sm text-gray-700 mb-4">
            {status === 'paused'
              ? 'New AI sessions are closed while your study participation is paused. When you are ready to resume, contact the research team and they will reopen your access. You can still view your past sessions and download your data from your profile.'
              : 'You have withdrawn from the study, so new AI sessions are closed. You can still view your past sessions and download your data from your profile. If this was not what you intended, contact the research team.'}
          </p>

          <div className="bg-red-50 rounded-xl p-4 mb-3">
            <p className="text-sm font-semibold text-red-900 mb-2">
              If you need support right now, these are available 24/7:
            </p>
            <ul className="space-y-2 text-sm text-red-900">
              <li className="flex items-center gap-2">
                <Phone size={14} className="text-red-500 flex-shrink-0" aria-hidden="true" />
                <span>
                  <a href="tel:988" className="font-semibold underline">988</a> — Suicide &amp;
                  Crisis Lifeline (call or text)
                </span>
              </li>
              <li className="flex items-center gap-2">
                <MessageSquare size={14} className="text-red-500 flex-shrink-0" aria-hidden="true" />
                <span>
                  Crisis Text Line — text HOME to{' '}
                  <a href="sms:741741" className="font-semibold underline">741741</a>
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Phone size={14} className="text-red-500 flex-shrink-0" aria-hidden="true" />
                <span>
                  BYU CAPS after-hours crisis line via BYU Police:{' '}
                  <a href="tel:8014222222" className="font-semibold underline">801-422-2222</a>
                </span>
              </li>
            </ul>
          </div>

          {/* IRB commitment: the research team's contact information remains
              available to withdrawn/paused participants. Secondary to the
              crisis resources above. */}
          <div className="bg-gray-50 rounded-xl p-4 mb-3">
            <p className="text-sm font-semibold text-gray-800 mb-2">
              {status === 'paused'
                ? 'To resume, or with any questions, contact the research team:'
                : 'Questions, or want to talk it over? Contact the research team:'}
            </p>
            <ul className="space-y-2 text-sm text-gray-700">
              <li className="flex items-center gap-2">
                <Mail size={14} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
                <span>
                  James Gaskin, Principal Investigator —{' '}
                  <a href="mailto:james.gaskin@byu.edu" className="font-semibold underline">
                    james.gaskin@byu.edu
                  </a>
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Mail size={14} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
                <span>
                  Nathan Blatter —{' '}
                  <a href="mailto:nzb22@byu.edu" className="font-semibold underline">
                    nzb22@byu.edu
                  </a>
                </span>
              </li>
            </ul>
          </div>

          <p className="text-xs text-gray-500">
            If you are in immediate danger, call{' '}
            <a href="tel:911" className="font-semibold underline">911</a>. During the day, BYU
            Counseling and Psychological Services is at{' '}
            <a href="tel:8014223035" className="font-semibold underline">801-422-3035</a>.
          </p>
        </div>
      </div>
    </>
  );
}
