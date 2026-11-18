// "Your reflections" card on the between-sessions Home (ai-therapist-204): a
// look back at the participant's OWN conversations: what they talked about,
// how they rated their mood, worksheets finished, how regularly they came.
//
// Gated twice. Home only fetches /api/me/reflections when the public features
// config has participant_reflections_enabled === true, and the endpoint itself
// 404s while the flag is off, so with the flag off this component never
// mounts. Everything rendered here comes from the allow-listed payload in
// src/shared/reflections.ts; there is no clinical or risk field to show.
//
// A conversation with nothing to show (no notes yet, or notes held back
// server-side) is simply left out of the list. The card never says that
// something was withheld.
import { useState } from 'react';
import { BookOpen } from 'react-feather';
import type { ParticipantReflections, ReflectionSession } from '../../../shared/reflections';
import { TrendRow, shortDate } from './TrendRow';

const INITIAL_VISIBLE = 5;

const iso = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function hasSomethingToShow(s: ReflectionSession): boolean {
  return s.topics.length > 0 || s.techniques.length > 0 || s.checkin !== null || s.worksheets_completed > 0;
}

/** True when the card will render a mood trend (Home uses this to avoid
 *  showing the same self-rated mood line twice). */
export function reflectionsShowMood(data: ParticipantReflections | null): boolean {
  return data !== null && data.mood.length >= 2;
}

function SessionReflection({ session }: { session: ReflectionSession }) {
  return (
    <li className="py-3">
      <p className="text-xs text-gray-400">{shortDate(iso(session.date))}</p>
      {session.topics.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mt-1.5" aria-label="What you talked about">
          {session.topics.map((topic) => (
            <li key={topic} className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
              {topic}
            </li>
          ))}
        </ul>
      )}
      {session.checkin?.goal && (
        <p className="text-sm text-gray-700 mt-1.5">
          <span className="text-gray-400">You wanted to: </span>
          {session.checkin.goal}
        </p>
      )}
      {session.checkin?.topic && (
        <p className="text-sm text-gray-700 mt-1">
          <span className="text-gray-400">On your mind: </span>
          {session.checkin.topic}
        </p>
      )}
      {session.techniques.length > 0 && (
        <p className="text-sm text-gray-700 mt-1">
          <span className="text-gray-400">Things you explored: </span>
          {session.techniques.join(', ')}
        </p>
      )}
      {session.worksheets_completed > 0 && (
        <p className="text-sm text-gray-700 mt-1">
          <span className="text-gray-400">You finished: </span>
          {plural(session.worksheets_completed, 'worksheet')}
        </p>
      )}
    </li>
  );
}

export default function ReflectionsCard({ data }: { data: ParticipantReflections }) {
  const [showAll, setShowAll] = useState(false);

  const sessions = data.sessions.filter(hasSomethingToShow);
  const visible = showAll ? sessions : sessions.slice(0, INITIAL_VISIBLE);
  const mood = data.mood.slice().reverse(); // oldest -> newest, left to right
  const weeks = data.continuity.weekly_sessions;
  const activeWeeks = weeks.filter((w) => w.sessions > 0).length;

  // Nothing reflective yet (first-time participant): Home's empty state
  // already covers this, so the card stays out of the way.
  if (data.continuity.session_count === 0) return null;
  if (sessions.length === 0 && mood.length < 2) return null;

  const facts = [
    plural(data.continuity.session_count, 'conversation'),
    ...(data.worksheets.completed > 0 ? [`${plural(data.worksheets.completed, 'worksheet')} finished`] : []),
    ...(weeks.length > 0 && activeWeeks > 0 ? [`here ${activeWeeks} of the last ${plural(weeks.length, 'week')}`] : []),
  ];

  return (
    <div className="bg-white rounded-2xl shadow p-5 sm:p-6">
      <div className="flex items-center gap-2 mb-1">
        <BookOpen size={18} className="text-blue-600" aria-hidden="true" />
        <h3 className="text-base font-semibold text-gray-800">Your reflections</h3>
      </div>
      <p className="text-sm text-gray-500 mb-4">{facts.join(' · ')}</p>

      {mood.length >= 2 && (
        <div className="mb-4">
          <TrendRow
            label="How you felt"
            values={mood.map((p) => p.mood)}
            min={1}
            max={10}
            latestLabel={`${mood[mood.length - 1].mood}/10`}
            dateRange={`${shortDate(iso(mood[0].date))} – ${shortDate(iso(mood[mood.length - 1].date))}`}
          />
          <p className="text-xs text-gray-400 mt-1">Your own ratings from your check-ins.</p>
        </div>
      )}

      {sessions.length > 0 && (
        <>
          <p className="text-sm font-medium text-gray-700">What you talked about</p>
          <ul className="divide-y divide-gray-100">
            {visible.map((session, i) => (
              <SessionReflection key={`${iso(session.date)}-${i}`} session={session} />
            ))}
          </ul>
          {sessions.length > INITIAL_VISIBLE && (
            <button
              onClick={() => setShowAll((prev) => !prev)}
              className="text-sm text-royal underline hover:text-navy min-h-[44px]"
              aria-expanded={showAll}
            >
              {showAll ? 'Show fewer' : `Show ${sessions.length - INITIAL_VISIBLE} earlier`}
            </button>
          )}
        </>
      )}

      <p className="text-xs text-gray-400 mt-4">
        A short look back at themes from your conversations and your own check-ins. It is not a diagnosis or an
        assessment, and not every conversation has notes.
      </p>
    </div>
  );
}
