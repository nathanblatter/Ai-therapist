// Care-note editor (caseworker portal slice B): drafts a new note or edits an
// existing draft (including amendment drafts). Therapists write SOAP progress
// notes or case notes; caseworkers write case notes only (the server 400s
// anything else). Drafts autosave (debounced) once created; signing asks for
// confirmation because signed notes are immutable (amend-only from there).
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Check, Edit3, Trash2 } from "react-feather";
import type { CareNote, CareNoteType, CaseNoteKind } from "./NotesPanel";

const CASE_KINDS: { value: CaseNoteKind; label: string }[] = [
  { value: "contact", label: "Contact" },
  { value: "referral", label: "Referral" },
  { value: "coordination", label: "Coordination" },
  { value: "safety_check", label: "Safety check" },
  { value: "other", label: "Other" },
];

const SOAP_FIELDS: { key: "subjective" | "objective" | "assessment" | "plan"; label: string }[] = [
  { key: "subjective", label: "Subjective" },
  { key: "objective", label: "Objective" },
  { key: "assessment", label: "Assessment" },
  { key: "plan", label: "Plan" },
];

interface NoteEditorProps {
  clientId: number;
  userRole: string | null;
  /** Existing draft to edit; null starts a new note. */
  note: CareNote | null;
  /** Fired after any successful persist (create/autosave/sign/delete). */
  onSaved?: (note: CareNote | null) => void;
  /** Leave the editor (back to the list). */
  onDone: () => void;
}

export default function NoteEditor({ clientId, userRole, note, onSaved, onDone }: NoteEditorProps) {
  const isCaseworker = userRole === "caseworker";
  const [noteId, setNoteId] = useState<number | null>(note?.note_id ?? null);
  const [noteType, setNoteType] = useState<CareNoteType>(note?.note_type ?? (isCaseworker ? "case" : "progress"));
  const [caseKind, setCaseKind] = useState<CaseNoteKind>(note?.case_note_kind ?? "contact");
  const [fields, setFields] = useState<Record<string, string>>({
    subjective: String(note?.content.subjective ?? ""),
    objective: String(note?.content.objective ?? ""),
    assessment: String(note?.content.assessment ?? ""),
    plan: String(note?.content.plan ?? ""),
    narrative: String(note?.content.narrative ?? ""),
    contact_method: String(note?.content.contact_method ?? ""),
    referral_to: String(note?.content.referral_to ?? ""),
    outcome: String(note?.content.outcome ?? ""),
  });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirmSign, setConfirmSign] = useState(false);
  const [busy, setBusy] = useState(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const buildContent = useCallback((): Record<string, string> => {
    const content: Record<string, string> = {};
    const keys =
      noteType === "progress"
        ? (["subjective", "objective", "assessment", "plan"] as const)
        : (["narrative", "contact_method", "referral_to", "outcome"] as const);
    for (const key of keys) {
      const value = fields[key]?.trim();
      if (value) content[key] = value;
    }
    return content;
  }, [fields, noteType]);

  const hasContent = Object.keys(buildContent()).length > 0 && (noteType === "progress" || !!fields.narrative.trim());

  const persist = useCallback(async (): Promise<CareNote | null> => {
    const content = buildContent();
    if (Object.keys(content).length === 0) return null;
    setSaveState("saving");
    setError(null);
    try {
      const res = noteId === null
        ? await fetch(`/admin/api/users/${clientId}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              note_type: noteType,
              case_note_kind: noteType === "case" ? caseKind : undefined,
              content,
            }),
          })
        : await fetch(`/admin/api/notes/${noteId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              content,
              case_note_kind: noteType === "case" ? caseKind : undefined,
            }),
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save the draft");
      }
      const data = await res.json();
      const saved: CareNote = data.note;
      setNoteId(saved.note_id);
      setSaveState("saved");
      dirty.current = false;
      onSaved?.(saved);
      return saved;
    } catch (err: unknown) {
      setSaveState("idle");
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [buildContent, caseKind, clientId, noteId, noteType, onSaved]);

  // Debounced autosave once a draft row exists (or once there is signable
  // content) — matches the "autosave drafts" spec line.
  useEffect(() => {
    if (!dirty.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      if (dirty.current && hasContent) void persist();
    }, 1500);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [fields, caseKind, hasContent, persist]);

  const setField = (key: string, value: string) => {
    dirty.current = true;
    setSaveState("idle");
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const handleSign = async () => {
    setBusy(true);
    setError(null);
    try {
      let id = noteId;
      if (dirty.current || id === null) {
        const saved = await persist();
        if (!saved) return;
        id = saved.note_id;
      }
      const res = await fetch(`/admin/api/notes/${id}/sign`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to sign the note");
      }
      const data = await res.json();
      onSaved?.(data.note);
      onDone();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmSign(false);
    }
  };

  const handleDelete = async () => {
    if (noteId === null) {
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/admin/api/notes/${noteId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete the draft");
      }
      onSaved?.(null);
      onDone();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-4" role="region" aria-label="Note editor">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onDone}
          className="text-royal hover:text-blue-700 flex items-center gap-1 min-h-[36px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Notes
        </button>
        <span className="text-xs text-gray-400 flex items-center gap-1">
          {saveState === "saving" && "Saving draft..."}
          {saveState === "saved" && (
            <>
              <Check size={12} aria-hidden="true" /> Draft saved
            </>
          )}
        </span>
      </div>

      {note?.amends_note_id != null && (
        <p className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Amendment of note #{note.amends_note_id}. Signing this amendment supersedes the original.
        </p>
      )}

      {!isCaseworker && noteId === null && note === null && (
        <div className="mb-3 flex gap-1" role="tablist" aria-label="Note type">
          {(
            [
              ["progress", "Progress (SOAP)"],
              ["case", "Case note"],
            ] as [CareNoteType, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={noteType === value}
              onClick={() => setNoteType(value)}
              className={`px-3 py-1.5 rounded-full text-sm ${
                noteType === value ? "bg-royal text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {isCaseworker && (
        <p className="mb-3 text-xs text-gray-500">Case note (caseworkers document contacts and coordination).</p>
      )}

      {noteType === "case" && (
        <div className="mb-3">
          <label htmlFor="case-kind" className="block text-sm font-medium text-gray-700 mb-1">
            Kind
          </label>
          <select
            id="case-kind"
            value={caseKind}
            onChange={(e) => {
              dirty.current = true;
              setCaseKind(e.target.value as CaseNoteKind);
            }}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]"
          >
            {CASE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {noteType === "progress" ? (
        <div className="space-y-3">
          {SOAP_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label htmlFor={`soap-${key}`} className="block text-sm font-medium text-gray-700 mb-1">
                {label}
              </label>
              <textarea
                id={`soap-${key}`}
                value={fields[key]}
                onChange={(e) => setField(key, e.target.value)}
                rows={key === "subjective" || key === "assessment" ? 3 : 2}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal"
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="case-narrative" className="block text-sm font-medium text-gray-700 mb-1">
              Narrative
            </label>
            <textarea
              id="case-narrative"
              value={fields.narrative}
              onChange={(e) => setField("narrative", e.target.value)}
              rows={4}
              placeholder="What happened, who was contacted, next steps..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(
              [
                ["contact_method", "Contact method"],
                ["referral_to", "Referral to"],
                ["outcome", "Outcome"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label htmlFor={`case-${key}`} className="block text-sm font-medium text-gray-700 mb-1">
                  {label}
                </label>
                <input
                  id={`case-${key}`}
                  type="text"
                  value={fields[key]}
                  onChange={(e) => setField(key, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal min-h-[40px]"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600 flex items-center gap-1" role="alert">
          <AlertCircle size={14} aria-hidden="true" /> {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void persist()}
          disabled={busy || !hasContent}
          className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
        >
          <Edit3 size={15} aria-hidden="true" /> Save draft
        </button>
        {!confirmSign ? (
          <button
            type="button"
            onClick={() => setConfirmSign(true)}
            disabled={busy || !hasContent}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 min-h-[44px]"
          >
            Sign note
          </button>
        ) : (
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-700">Signed notes are permanent (amend-only). Sign?</span>
            <button
              type="button"
              onClick={handleSign}
              disabled={busy}
              className="px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 min-h-[36px]"
            >
              Confirm sign
            </button>
            <button
              type="button"
              onClick={() => setConfirmSign(false)}
              className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 min-h-[36px]"
            >
              Cancel
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          className="ml-auto px-3 py-2 text-red-600 hover:text-red-800 disabled:opacity-50 flex items-center gap-1 min-h-[44px]"
        >
          <Trash2 size={15} aria-hidden="true" /> {noteId === null ? "Discard" : "Delete draft"}
        </button>
      </div>
    </div>
  );
}
