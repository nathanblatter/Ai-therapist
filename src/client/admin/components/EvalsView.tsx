import EvalDriftPanel from './EvalDriftPanel';
import PairwiseEvalPanel from './PairwiseEvalPanel';
import EvalCalibrationPanel from './EvalCalibrationPanel';
import SimulationRunsPanel from './SimulationRunsPanel';

// Thin research-only view composing the eval panels, moved out of the
// Analytics single-scroll dashboard (ai-therapist-120). The panels own their
// data fetching; nothing here beyond composition. onViewSession opens
// SessionDetail (transcript + recording) from a simulation-run result row.
export default function EvalsView({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold">Evals</h2>
      <SimulationRunsPanel onViewSession={onViewSession} />
      <EvalDriftPanel />
      <PairwiseEvalPanel />
      <EvalCalibrationPanel />
    </div>
  );
}
