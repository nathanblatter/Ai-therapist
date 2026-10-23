import { useState } from 'react';
import EvalDriftPanel from './EvalDriftPanel';
import PairwiseEvalPanel from './PairwiseEvalPanel';
import EvalCalibrationPanel from './EvalCalibrationPanel';
import SimulationRunsPanel from './SimulationRunsPanel';
import RatingQueuePanel from './RatingQueuePanel';
import WeeklyDigestPanel from './WeeklyDigestPanel';

// Thin research-only view composing the eval panels, moved out of the
// Analytics single-scroll dashboard (ai-therapist-120). The panels own their
// data fetching; nothing here beyond composition. onViewSession opens
// SessionDetail (transcript + recording) from a simulation-run result row or
// a rating-queue row. The Rating queue (eval program WP2) is its own tab so
// a rater can work it without scrolling past the dashboards.
type Tab = 'overview' | 'rating-queue';

export default function EvalsView({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const tabClass = (t: Tab) =>
    `px-3 py-1.5 rounded text-sm font-medium min-h-[36px] ${tab === t ? 'bg-royal text-white' : 'text-gray-700 hover:bg-gray-100'}`;
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold">Evals</h2>
        <div className="flex gap-1" role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} className={tabClass('overview')} onClick={() => setTab('overview')}>Overview</button>
          <button role="tab" aria-selected={tab === 'rating-queue'} className={tabClass('rating-queue')} onClick={() => setTab('rating-queue')}>Rating queue</button>
        </div>
      </div>
      {tab === 'overview' && (
        <>
          <SimulationRunsPanel onViewSession={onViewSession} />
          <EvalDriftPanel />
          <PairwiseEvalPanel />
          <EvalCalibrationPanel />
          <WeeklyDigestPanel />
        </>
      )}
      {tab === 'rating-queue' && <RatingQueuePanel onViewSession={onViewSession} />}
    </div>
  );
}
