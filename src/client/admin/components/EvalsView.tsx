import EvalDriftPanel from './EvalDriftPanel';
import PairwiseEvalPanel from './PairwiseEvalPanel';
import EvalCalibrationPanel from './EvalCalibrationPanel';

// Thin research-only view composing the three eval panels, moved out of the
// Analytics single-scroll dashboard (ai-therapist-120). The panels own their
// data fetching; nothing here beyond composition.
export default function EvalsView() {
  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold">Evals</h2>
      <EvalDriftPanel />
      <PairwiseEvalPanel />
      <EvalCalibrationPanel />
    </div>
  );
}
