// Dev-only fixture renderer for scripts/mobile-audit/screenshots.ts. Never
// bundled: the screenshot script serves an HTML shell that loads this file
// through the dev server's Vite /@fs path. It renders participant screens that
// no browser-side mock can reach (they are driven by server socket events or
// server clocks) with fixture props, exactly as App.tsx mounts them.
import { createRoot } from 'react-dom/client';
import ModerationRecoveryScreen from '../../src/client/main/components/ModerationRecoveryScreen';
import QuietHoursScreen from '../../src/client/main/components/QuietHoursScreen';
import StudyStatusScreen from '../../src/client/main/components/StudyStatusScreen';

const screen = new URLSearchParams(window.location.search).get('screen');
const crisisContact = { hotline: '988 Suicide & Crisis Lifeline', phone: '988', text: 'HOME to 741741' };

function Harness() {
  return (
    <div data-harness-ready className="flex flex-col h-dvh bg-gray-50">
      {screen === 'moderation' && (
        <ModerationRecoveryScreen stage="failed" crisisContact={crisisContact} onRetry={() => undefined} />
      )}
      {screen === 'quiet' && <QuietHoursScreen startHour={22} endHour={6} />}
      {screen === 'status' && <StudyStatusScreen status="paused" />}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
