// Dev-only fixture harness for the mobile audit screenshots (docs/mobile-audit).
// Loaded by scripts/mobile-audit/screenshots.ts through the dev server's Vite
// /@fs path; it is never bundled into the app. It renders the three screens
// no browser-side mock can reach (they are driven by server socket events or
// server clocks) with fixture props, exactly as App.tsx mounts them.
//
// The `handoff-*` screens are the text hand-off after a vendor cut of a voice
// session (ai-therapist-356). Reaching it for real needs the voice vendor to
// end a call, so the chat view is composed here from the same components, in
// the same wrappers and classes App.tsx uses, with fixture messages. No model
// and no server call is involved.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import ChatLog, { type ChatMessage } from '../../src/client/main/components/ChatLog';
import { HandoffReplyBar, PinnedCrisisCard } from '../../src/client/main/components/CrisisHandoffPanel';
import Header from '../../src/client/main/components/Header';
import ModerationRecoveryScreen from '../../src/client/main/components/ModerationRecoveryScreen';
import QuietHoursScreen from '../../src/client/main/components/QuietHoursScreen';
import SessionControls from '../../src/client/main/components/SessionControls';
import StudyStatusScreen from '../../src/client/main/components/StudyStatusScreen';
import {
  HANDOFF_CRISIS_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE,
  HANDOFF_QUICK_REPLIES,
  type HandoffKind,
} from '../../src/shared/textHandoff';

const screen = new URLSearchParams(window.location.search).get('screen');
const crisisContact = { hotline: '988 Suicide & Crisis Lifeline', phone: '988', text: 'HOME to 741741' };

const msg = (role: string, text: string, i: number): ChatMessage => ({ id: `m${i}`, role, text });

// The voice captions stay on screen and the first message follows them.
const CRISIS_VOICE: Array<[string, string]> = [
  ['assistant', 'That sounds exhausting. What has been keeping you up?'],
  ['user', "Honestly it's been terrible. I can't sleep and I feel like a burden."],
  ['assistant', 'Thank you for telling me that.'],
  ['user', "I've been thinking about killing myself."],
];
const NEUTRAL_VOICE: Array<[string, string]> = [
  ['assistant', "There's a breathing circle on your screen now. Breathe in gently as it grows, for four counts."],
  ['assistant', 'Breathe out as it shrinks for four. And pause for four.'],
  ['user', 'Wait, stop.'],
];

interface HandoffFixture {
  kind: HandoffKind;
  messages: ChatMessage[];
  quickReplies: string[];
  awaitingReply: boolean;
  voiceReturnAllowed: boolean;
}

const HANDOFF: Record<string, HandoffFixture> = {
  // The first screen after a crisis cut: nothing typed yet.
  'handoff-crisis': {
    kind: 'crisis',
    messages: [...CRISIS_VOICE, ['assistant', HANDOFF_CRISIS_FIRST_MESSAGE] as [string, string]].map(([r, t], i) =>
      msg(r, t, i),
    ),
    quickReplies: [...HANDOFF_QUICK_REPLIES],
    awaitingReply: false,
    voiceReturnAllowed: false,
  },
  // One tap later: "Yes" is sent and the reply is being written.
  'handoff-crisis-sent': {
    kind: 'crisis',
    messages: [
      ...CRISIS_VOICE,
      ['assistant', HANDOFF_CRISIS_FIRST_MESSAGE] as [string, string],
      ['user', 'Yes'] as [string, string],
    ].map(([r, t], i) => msg(r, t, i)),
    quickReplies: [],
    awaitingReply: true,
    voiceReturnAllowed: false,
  },
  // A cut with no risk signal: the neutral wording, the voice offer.
  'handoff-neutral': {
    kind: 'neutral',
    messages: [...NEUTRAL_VOICE, ['assistant', HANDOFF_NEUTRAL_FIRST_MESSAGE] as [string, string]].map(([r, t], i) =>
      msg(r, t, i),
    ),
    quickReplies: [],
    awaitingReply: false,
    voiceReturnAllowed: true,
  },
};

function HandoffChat({ fixture }: { fixture: HandoffFixture }) {
  return (
    <>
      <Header sessionId="chat_1795093264257_fixture" timeRemaining={null} />
      <PinnedCrisisCard crisisContact={crisisContact} kind={fixture.kind} onMoreResources={() => undefined} />
      <main className="flex-1 flex flex-col items-center overflow-hidden">
        <div className="w-full flex-1 overflow-y-auto px-4 py-2 sm:p-4">
          <ChatLog messages={fixture.messages} assistantStream="" followLatest />
        </div>
        <div className="w-full max-w-4xl px-3 pt-2 sm:px-4">
          <HandoffReplyBar
            quickReplies={fixture.quickReplies}
            onQuickReply={() => undefined}
            awaitingReply={fixture.awaitingReply}
            voiceReturnAllowed={fixture.voiceReturnAllowed}
            onReturnToVoice={() => undefined}
            returningToVoice={false}
          />
        </div>
        <div className="w-full max-w-4xl px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-4">
          <SessionControls
            startSession={() => undefined}
            stopSession={() => undefined}
            sendTextMessage={() => undefined}
            isSessionActive
            localStream={null}
            onOpenSettings={() => undefined}
            chatEnabled
            sessionType="chat"
          />
        </div>
      </main>
    </>
  );
}

function Harness() {
  const handoff = screen ? HANDOFF[screen] : undefined;
  return (
    <div data-harness-ready className="flex flex-col h-dvh bg-gray-50">
      {screen === 'moderation' && (
        <ModerationRecoveryScreen stage="failed" crisisContact={crisisContact} onRetry={() => undefined} />
      )}
      {screen === 'moderation-text' && (
        <ModerationRecoveryScreen stage="text" crisisContact={crisisContact} onRetry={() => undefined} />
      )}
      {screen === 'quiet' && <QuietHoursScreen startHour={22} endHour={6} />}
      {screen === 'status' && <StudyStatusScreen status="paused" />}
      {handoff && (
        // Header navigates; nothing here leaves the page.
        <MemoryRouter>
          <HandoffChat fixture={handoff} />
        </MemoryRouter>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
