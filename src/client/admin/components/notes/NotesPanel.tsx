// Care notes panel (caseworker portal slice B), embedded in
// ParticipantProfile (integration wiring). Lists the client's notes visible
// to the viewer (server enforces the visibility matrix: therapists see all
// care-team notes; caseworkers see case notes, shared progress notes, and
// their own drafts), with drill-down to NoteDetail and drafting via
// NoteEditor. Caseworkers author case notes only.
import { useMemo, useState } from "react";
import { Edit3, FileText, Lock, Plus, Share2 } from "react-feather";
import useAdminFetch from "../../hooks/useAdminFetch";
import useAuth from "../../hooks/useAuth";
import Badge from "../../../shared/components/Badge";
import NoteEditor from "./NoteEditor";
import NoteDetail from "./NoteDetail";
// Canonical note shapes live in the server data layer (type-only import,
// erased at build time). content is Record<string, unknown> there; narrow
// locally where specific keys are read.
import type {
  CareNoteRow,
  CareNoteType,
  CaseNoteKind,
  CareNoteStatus,
} from "../../../../server/db/careNotes.queries";

export type { CareNoteType, CaseNoteKind, CareNoteStatus };
export type CareNote = CareNoteRow;

/** Narrow a content field to a display string (server types it unknown). */
function contentText(content: CareNote["content"], key: string): string {
  const value = content[key];
  return typeof value === "string" ? value : "";
}

export function noteHeadline(note: CareNote): string {
  if (note.note_type === "case") {
    const kind = note.case_note_kind ? note.case_note_kind.replace(/_/g, " ") : "case";
    const narrative = contentText(note.content, "narrative");
    return `${kind[0].toUpperCase()}${kind.slice(1)} note${narrative ? ` — ${narrative}` : ""}`;
  }
  const lead =
    contentText(note.content, "assessment") ||
    contentText(note.content, "subjective") ||
    contentText(note.content, "plan");
  return `Progress note${lead ? ` — ${lead}` : ""}`;
}

export function NoteStatusBadge({ status }: { status: CareNoteStatus }) {
  if (status === "signed") {
    return (
      <Badge tone="green">
        <Lock size={11} aria-hidden="true" /> Signed
      </Badge>
    );
  }
  if (status === "amended") {
    return <Badge tone="gray">Amended</Badge>;
  }
  return (
    <Badge tone="yellow">
      <Edit3 size={11} aria-hidden="true" /> Draft
    </Badge>
  );
}

interface NotesPanelProps {
  clientId: number;
  userRole: string | null;
}

type PanelMode = { kind: "list" } | { kind: "edit"; note: CareNote | null } | { kind: "detail"; note: CareNote };

export default function NotesPanel({ clientId, userRole }: NotesPanelProps) {
  const [mode, setMode] = useState<PanelMode>({ kind: "list" });
  const [typeFilter, setTypeFilter] = useState<"all" | CareNoteType>("all");
  const { userId: currentUserId } = useAuth();

  const { data, loading, error, refetch } = useAdminFetch<{ notes: CareNote[] }>(
    `/admin/api/users/${clientId}/notes`
  );
  const notes = useMemo(() => {
    const all = data?.notes ?? [];
    return typeFilter === "all" ? all : all.filter((n) => n.note_type === typeFilter);
  }, [data, typeFilter]);

  if (mode.kind === "edit") {
    return (
      <NoteEditor
        clientId={clientId}
        userRole={userRole}
        note={mode.note}
        onSaved={() => {
          refetch();
        }}
        onDone={() => {
          setMode({ kind: "list" });
          refetch();
        }}
      />
    );
  }

  if (mode.kind === "detail") {
    return (
      <NoteDetail
        note={mode.note}
        currentUserId={currentUserId}
        onBack={() => {
          setMode({ kind: "list" });
          refetch();
        }}
        onEditDraft={(note) => setMode({ kind: "edit", note })}
      />
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-4" role="region" aria-label="Care notes">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
          <FileText size={14} aria-hidden="true" /> Notes
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="Note type filter">
            {(
              [
                ["all", "All"],
                ["progress", "Progress"],
                ["case", "Case"],
              ] as ["all" | CareNoteType, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={typeFilter === value}
                onClick={() => setTypeFilter(value)}
                className={`px-2.5 py-1 rounded-full text-xs ${
                  typeFilter === value ? "bg-royal text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMode({ kind: "edit", note: null })}
            className="px-3 py-1.5 bg-royal text-white rounded-md hover:bg-blue-700 flex items-center gap-1 text-sm min-h-[36px]"
          >
            <Plus size={14} aria-hidden="true" /> New note
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 mb-2" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-gray-500">Loading notes...</p>}
      {!loading && notes.length === 0 && (
        <p className="text-sm text-gray-500">
          No notes yet.
          {userRole === "caseworker" ? " Record contacts, referrals, and coordination as case notes." : ""}
        </p>
      )}

      <ul className="divide-y divide-gray-100">
        {notes.map((note) => (
          <li key={note.note_id}>
            <button
              type="button"
              onClick={() => setMode({ kind: "detail", note })}
              className="w-full text-left py-2.5 hover:bg-gray-50 rounded px-2 -mx-2"
              aria-label={`Open note ${note.note_id}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <NoteStatusBadge status={note.status} />
                <span className="text-xs text-gray-500 capitalize">{note.note_type}</span>
                {note.note_type === "progress" && note.shared_with_care_team && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-blue-700"
                    title="Shared with the care team"
                  >
                    <Share2 size={11} aria-hidden="true" /> shared
                  </span>
                )}
                <span className="text-xs text-gray-400 ml-auto">
                  {note.signed_at
                    ? `signed ${new Date(note.signed_at).toLocaleDateString()}`
                    : `updated ${new Date(note.updated_at).toLocaleDateString()}`}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-gray-800 line-clamp-2">{noteHeadline(note)}</p>
              <p className="text-xs text-gray-400">
                {note.author_name} ({note.author_role})
                {note.seed_source === "ai_soap" ? " · seeded from AI SOAP draft" : ""}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
