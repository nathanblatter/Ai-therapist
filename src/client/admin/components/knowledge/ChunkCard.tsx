import { useState } from 'react';
import { CheckCircle, Clock, Trash2, ExternalLink, Edit2, ChevronDown, ChevronUp, Award, Moon, AlertTriangle } from 'react-feather';
import { type Chunk, type ChunkUsage, formatDate, formatDateTime } from './types';

const PREVIEW_CHARS = 240;

interface Props {
  chunk: Chunk;
  usage: ChunkUsage | null;
  /** chosen_count at or above this (and > 0) marks a workhorse (top decile). */
  workhorseThreshold: number | null;
  busy: boolean;
  onApprove: () => void;
  onUnapprove: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** One chunk row in the curation list: status/kind badges, collapsed content
 *  preview, usage stats + dead-weight/workhorse badges, provenance line, and
 *  the approve/edit/delete actions. */
export default function ChunkCard({ chunk: c, usage, workhorseThreshold, busy, onApprove, onUnapprove, onEdit, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);

  const needsPreview = c.content.length > PREVIEW_CHARS;
  const shownContent = expanded || !needsPreview ? c.content : `${c.content.slice(0, PREVIEW_CHARS)}…`;

  const retrieved = usage?.retrieved_count ?? 0;
  const chosen = usage?.chosen_count ?? 0;
  const deadWeight = c.active && chosen === 0;
  const workhorse = workhorseThreshold !== null && chosen > 0 && chosen >= workhorseThreshold;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${c.active ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {c.active ? <CheckCircle size={12} /> : <Clock size={12} />}
              {c.active ? 'Active' : 'Pending'}
            </span>
            <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 capitalize">{c.kind}</span>
            {c.topic && <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{c.topic}</span>}
            {c.modality && <span className="px-2 py-0.5 rounded text-xs bg-indigo-100 text-indigo-700 uppercase">{c.modality}</span>}
            {workhorse && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-100 text-sky-700 font-medium" title="Top decile by times chosen">
                <Award size={12} /> Workhorse
              </span>
            )}
            {deadWeight && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500" title="Active but never chosen by retrieval">
                <Moon size={12} /> Dead weight
              </span>
            )}
            {!c.has_embedding && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-100 text-red-700 font-medium" title="No embedding: this chunk can never be retrieved">
                <AlertTriangle size={12} /> No embedding
              </span>
            )}
          </div>

          <p className="font-semibold text-gray-900 mt-2">{c.title ?? '(untitled)'}</p>
          <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{shownContent}</p>
          {needsPreview && (
            <button onClick={() => setExpanded(v => !v)}
              className="text-xs text-royal mt-1 inline-flex items-center gap-0.5 hover:underline">
              {expanded ? <>Show less <ChevronUp size={12} /></> : <>Show full content <ChevronDown size={12} /></>}
            </button>
          )}

          <p className="text-xs text-gray-400 mt-2 flex items-center gap-1 flex-wrap">
            <span>{c.source}</span>
            {c.source_url && (
              <a href={c.source_url} target="_blank" rel="noreferrer" className="text-royal inline-flex items-center gap-0.5 hover:underline">
                source <ExternalLink size={10} />
              </a>
            )}
            {c.license && <span>· {c.license}</span>}
          </p>

          {/* Usage: how this chunk actually performs in retrieval. */}
          <p className="text-xs text-gray-500 mt-1">
            {usage && (retrieved > 0 || chosen > 0) ? (
              <>Retrieved {retrieved}x · chosen {chosen}x{usage.last_used && <> · last used {formatDate(usage.last_used)}</>}</>
            ) : (
              <>Never retrieved</>
            )}
          </p>

          {/* Provenance */}
          <p className="text-xs text-gray-400 mt-1">
            Added {formatDateTime(c.created_at)}
            {c.updated_at && c.updated_at !== c.created_at && <> · updated {formatDateTime(c.updated_at)}</>}
          </p>
          {c.active && c.approved_by && (
            <p className="text-xs text-gray-500 mt-1">
              Approved by <strong>{c.approved_by}</strong>
              {c.approved_at && ` · ${formatDate(c.approved_at)}`}
              {c.approval_note && <span className="italic text-gray-400"> — {c.approval_note}</span>}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          {c.active ? (
            <button onClick={onUnapprove} disabled={busy}
              className="px-3 py-1.5 text-xs rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40">
              Unapprove
            </button>
          ) : (
            <button onClick={onApprove} disabled={busy}
              className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">
              Approve
            </button>
          )}
          <button onClick={onEdit} disabled={busy}
            className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50 inline-flex items-center justify-center gap-1 disabled:opacity-40">
            <Edit2 size={12} /> Edit
          </button>
          <button onClick={onDelete} disabled={busy}
            className="px-3 py-1.5 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 inline-flex items-center justify-center gap-1 disabled:opacity-40">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}
