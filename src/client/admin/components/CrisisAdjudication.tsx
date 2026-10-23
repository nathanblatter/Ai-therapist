// Minimal crisis-event adjudication widget (eval program WP2): one verdict
// per adjudicator per event - confirmed / false positive / unclear - plus an
// optional note. Renders the existing verdicts from the event row's
// `adjudications` aggregate and PUTs the caller's verdict to
// /admin/api/crisis/events/:id/adjudication. Caseworkers see the verdicts
// read-only (the server denies them the write).
import { useState } from 'react';
import { CheckCircle, XCircle, HelpCircle } from 'react-feather';
import { postJson, HttpError } from '../../shared/http';
import { toast } from '../../shared/components/Toast';
import useAuth from '../hooks/useAuth';

export type AdjudicationVerdict = 'confirmed' | 'false_positive' | 'unclear';

export interface AdjudicationSummary {
  adjudicator_id: number;
  verdict: AdjudicationVerdict;
  adjudicated_at: string;
}

interface CrisisAdjudicationProps {
  eventId: number | string;
  adjudications?: AdjudicationSummary[] | null;
  /** Called with the new verdict list after a save so the parent can refresh its copy. */
  onSaved?: (adjudications: AdjudicationSummary[]) => void;
  compact?: boolean;
}

const VERDICTS: Array<{ id: AdjudicationVerdict; label: string; Icon: typeof CheckCircle; active: string }> = [
  { id: 'confirmed', label: 'Confirmed', Icon: CheckCircle, active: 'bg-red-100 text-red-800 border-red-300' },
  { id: 'false_positive', label: 'False positive', Icon: XCircle, active: 'bg-green-100 text-green-800 border-green-300' },
  { id: 'unclear', label: 'Unclear', Icon: HelpCircle, active: 'bg-gray-200 text-gray-800 border-gray-400' },
];

export function verdictLabel(v: AdjudicationVerdict): string {
  return VERDICTS.find(x => x.id === v)?.label ?? v;
}

export default function CrisisAdjudication({ eventId, adjudications, onSaved, compact }: CrisisAdjudicationProps) {
  const { role, userId } = useAuth();
  const canAdjudicate = role === 'therapist' || role === 'researcher';
  const list = adjudications ?? [];
  const mine = userId !== null ? list.find(a => a.adjudicator_id === userId) : undefined;
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (verdict: AdjudicationVerdict) => {
    setSaving(true);
    try {
      const data = await postJson<{ adjudication: AdjudicationSummary }>(
        `/admin/api/crisis/events/${eventId}/adjudication`,
        { verdict, note: note || undefined },
        { method: 'PUT', fallback: 'Failed to save adjudication' }
      );
      const next = [
        { adjudicator_id: data.adjudication.adjudicator_id, verdict: data.adjudication.verdict, adjudicated_at: data.adjudication.adjudicated_at },
        ...list.filter(a => a.adjudicator_id !== data.adjudication.adjudicator_id),
      ];
      onSaved?.(next);
      toast.success(`Marked ${verdictLabel(verdict).toLowerCase()}`);
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : 'Failed to save adjudication');
    } finally {
      setSaving(false);
    }
  };

  const others = list.filter(a => a.adjudicator_id !== userId);

  return (
    <div className={`${compact ? 'mt-2' : 'mt-3 pt-3 border-t border-gray-200'} text-xs`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-gray-700">Adjudication:</span>
        {canAdjudicate ? (
          VERDICTS.map(({ id, label, Icon, active }) => (
            <button
              key={id}
              type="button"
              disabled={saving}
              onClick={() => save(id)}
              aria-pressed={mine?.verdict === id}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded border transition min-h-[28px] ${
                mine?.verdict === id ? active : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              } disabled:opacity-50`}
            >
              <Icon size={12} /> {label}
            </button>
          ))
        ) : (
          <span className="text-gray-600">{mine ? verdictLabel(mine.verdict) : list.length ? '' : 'not adjudicated'}</span>
        )}
        {!mine && canAdjudicate && list.length === 0 && (
          <span className="text-gray-500">not yet adjudicated</span>
        )}
        {others.length > 0 && (
          <span className="text-gray-500">
            {others.length} other verdict{others.length === 1 ? '' : 's'}: {others.map(a => verdictLabel(a.verdict)).join(', ')}
          </span>
        )}
        {canAdjudicate && (
          <button type="button" onClick={() => setShowNote(v => !v)} className="text-royal hover:text-navy">
            {showNote ? 'hide note' : 'add note'}
          </button>
        )}
      </div>
      {showNote && canAdjudicate && (
        <input
          type="text"
          value={note}
          maxLength={2000}
          onChange={e => setNote(e.target.value)}
          placeholder="Optional note (saved with your next verdict; never exported)"
          className="mt-1 w-full text-xs border border-gray-200 rounded px-2 py-1"
        />
      )}
    </div>
  );
}
