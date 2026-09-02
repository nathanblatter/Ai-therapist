// Overnight quiet-hours screen (ai-therapist-152). The Phase 2 IRB
// application and consent form promise the app blocks NEW sessions from
// 10:00 PM to 6:00 AM Mountain Time and shows crisis and support resources
// instead — this is that screen. It renders as a blocking overlay (same
// layering as ConsentScreen) whenever GET /api/config/quiet-hours reports the
// window active; the server middleware enforces the same rule on /token and
// /api/chat/start, so this is presentation, not the security boundary.
import { Moon, Phone, MessageSquare } from 'react-feather';

interface QuietHoursScreenProps {
  /** Denver wall-clock hours from the server status payload. */
  startHour: number;
  endHour: number;
}

function hourLabel(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  return `${h}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}

export default function QuietHoursScreen({ startHour, endHour }: QuietHoursScreenProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-[60]" aria-hidden="true" />
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quiet-hours-title"
      >
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-indigo-50 rounded-full p-3">
              <Moon size={22} className="text-indigo-600" aria-hidden="true" />
            </div>
            <h2 id="quiet-hours-title" className="text-lg font-semibold text-gray-800">
              The app is resting overnight
            </h2>
          </div>

          <p className="text-sm text-gray-700 mb-4">
            New sessions are paused between {hourLabel(startHour)} and {hourLabel(endHour)}{' '}
            Mountain Time as part of the study design. The app will be available again
            at {hourLabel(endHour)}.
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
                  Crisis Text Line — text HELLO to{' '}
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
