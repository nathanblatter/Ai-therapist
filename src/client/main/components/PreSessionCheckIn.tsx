// Pre-session check-in (ai-therapist-40): a short optional prompt before the
// session starts. Whatever the participant shares is injected into the AI's
// instructions so it opens the conversation relevantly, and is stored with the
// session for research. Fully skippable.
import { useState } from 'react';
import { X } from 'react-feather';

export interface CheckinData {
  mood?: number;
  topic?: string;
  goal?: string;
}

interface PreSessionCheckInProps {
  isOpen: boolean;
  onCancel: () => void;
  /** Called with the check-in (or null when skipped); caller starts the session. */
  onStart: (checkin: CheckinData | null) => void;
}

const MOOD_LABELS: Record<number, string> = {
  1: 'Really struggling',
  3: 'Not great',
  5: 'Okay',
  7: 'Pretty good',
  10: 'Great',
};

function moodLabel(mood: number): string {
  const keys = Object.keys(MOOD_LABELS).map(Number).sort((a, b) => a - b);
  let label = MOOD_LABELS[keys[0]];
  for (const k of keys) {
    if (mood >= k) label = MOOD_LABELS[k];
  }
  return label;
}

export default function PreSessionCheckIn({ isOpen, onCancel, onStart }: PreSessionCheckInProps) {
  const [mood, setMood] = useState(5);
  const [moodTouched, setMoodTouched] = useState(false);
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');

  if (!isOpen) return null;

  const handleStart = () => {
    const checkin: CheckinData = {};
    if (moodTouched) checkin.mood = mood;
    if (topic.trim()) checkin.topic = topic.trim();
    if (goal.trim()) checkin.goal = goal.trim();
    onStart(Object.keys(checkin).length > 0 ? checkin : null);
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-40 transition-opacity"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkin-modal-title"
      >
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-fadeIn">
          <header className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 id="checkin-modal-title" className="text-lg font-semibold text-gray-800">
              Before we start…
            </h2>
            <button
              onClick={onCancel}
              className="p-1.5 hover:bg-gray-100 rounded-full transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Close check-in"
            >
              <X size={20} className="text-gray-500" />
            </button>
          </header>

          <div className="px-6 py-6 space-y-6">
            <p className="text-sm text-gray-500">
              A quick optional check-in helps the conversation start where you are. Skip anything you like.
            </p>

            <div>
              <label htmlFor="checkin-mood" className="block text-sm font-medium text-gray-700 mb-2">
                How are you feeling right now?
                {moodTouched && (
                  <span className="ml-2 text-gray-500 font-normal">
                    {mood}/10 — {moodLabel(mood)}
                  </span>
                )}
              </label>
              <input
                id="checkin-mood"
                type="range"
                min={1}
                max={10}
                value={mood}
                onChange={(e) => { setMood(Number(e.target.value)); setMoodTouched(true); }}
                className="w-full accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>Struggling</span>
                <span>Great</span>
              </div>
            </div>

            <div>
              <label htmlFor="checkin-topic" className="block text-sm font-medium text-gray-700 mb-2">
                What&apos;s on your mind today?
              </label>
              <input
                id="checkin-topic"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={300}
                placeholder="e.g. stress about exams, a difficult conversation…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="checkin-goal" className="block text-sm font-medium text-gray-700 mb-2">
                Anything you&apos;d like to get out of today&apos;s conversation?
              </label>
              <input
                id="checkin-goal"
                type="text"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={300}
                placeholder="e.g. feel a bit calmer, think through options…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <footer className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-between items-center">
            <button
              onClick={() => onStart(null)}
              className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2"
            >
              Skip
            </button>
            <button
              onClick={handleStart}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
            >
              Start session
            </button>
          </footer>
        </div>
      </div>
    </>
  );
}
