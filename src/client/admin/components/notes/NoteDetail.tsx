// Care-note detail (caseworker portal slice B): read view with provenance
// ("Drafted by AI, edited and signed by ..."), sign-hash display, the
// author-only actions (edit/sign for drafts, amend + share toggle for signed
// progress notes), and the amendment chain link. Signed content is immutable
// — the server 409s any edit and the DB trigger backstops it.
//
// Copy and Print (ai-therapist-199) let a clinician get the note out: plain
// structured text to the clipboard, or a standalone printable document (the
// browser's Save as PDF covers PDF). Both are client-side renderings of a
// note the viewer already fetched, so no new data leaves the server.
import { useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, Cpu, Edit3, FileText, Lock, Printer, Share2 } from "react-feather";
import { NoteStatusBadge, type CareNote } from "./NotesPanel";
import { postJson } from "../../../shared/http";
import { CASE_ORDER, SOAP_ORDER, copyText, fieldLabel, noteToPlainText, printNote, type NoteExportContext } from "./noteExport";

interface NoteDetailProps {
  note: CareNote;
  currentUserId: number | null;
  onBack: () => void;
  /** Open the editor for a draft (the note itself, or a fresh amendment). */
  onEditDraft: (note: CareNote) => void;
  /** Client reference + session date for the copy/print header. */
  exportContext?: NoteExportContext;
}


export default function NoteDetail({ note: initialNote, currentUserId, onBack, onEditDraft, exportContext }: NoteDetailProps) {
  const [note, setNote] = useState<CareNote>(initialNote);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    const ok = await copyText(noteToPlainText(note, exportContext));
    setCopied(ok ? "ok" : "fail");
  };

  const isAuthor = currentUserId !== null && note.author_id === currentUserId;
  const order = note.note_type === "progress" ? SOAP_ORDER : CASE_ORDER;

  const post = async (path: string, body?: Record<string, unknown>): Promise<CareNote | null> => {
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ note: CareNote }>(`/admin/api/notes/${note.note_id}/${path}`, body);
      return data.note;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleAmend = async () => {
    const amendment = await post("amend");
    if (amendment) onEditDraft(amendment);
  };

  const handleShareToggle = async () => {
    const updated = await post("share", { shared: !note.shared_with_care_team });
    if (updated) setNote(updated);
  };

  return (
    <div className="bg-white rounded-lg shadow p-4" role="region" aria-label="Note detail">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="text-royal hover:text-blue-700 flex items-center gap-1 min-h-[36px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Notes
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="px-2.5 py-1.5 text-xs rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-1 min-h-[36px]"
            title="Copy the note as plain text"
            aria-label="Copy note as plain text"
          >
            {copied === "ok" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => printNote(note, exportContext)}
            className="px-2.5 py-1.5 text-xs rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-1 min-h-[36px]"
            title="Open a printable version (use Save as PDF in the print dialog)"
            aria-label="Print note"
          >
            <Printer size={13} aria-hidden="true" /> Print
          </button>
          <NoteStatusBadge status={note.status} />
        </div>
      </div>

      <h4 className="text-base font-semibold text-gray-900 flex items-center gap-2 mb-1">
        <FileText size={16} aria-hidden="true" />
        {note.note_type === "progress" ? "Progress note" : "Case note"}
        {note.case_note_kind && (
          <span className="text-xs font-normal text-gray-500 capitalize">
            {note.case_note_kind.replace(/_/g, " ")}
          </span>
        )}
      </h4>

      {/* Provenance line */}
      <p className="text-xs text-gray-500 mb-3 flex items-center gap-1.5 flex-wrap">
        {note.seed_source === "ai_soap" ? (
          <>
            <Cpu size={12} aria-hidden="true" />
            Drafted by AI{note.seed_model ? ` (${note.seed_model})` : ""}, edited
            {note.status === "draft" ? " by" : " and signed by"} {note.author_name}
          </>
        ) : (
          <>
            Written by {note.author_name} ({note.author_role})
          </>
        )}
        {note.signed_at && <span>on {new Date(note.signed_at).toLocaleString()}</span>}
        {note.session_id && <span>· session {note.session_id}</span>}
      </p>

      {note.amends_note_id != null && (
        <p className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          This note amends note #{note.amends_note_id}.
        </p>
      )}
      {note.status === "amended" && (
        <p className="mb-3 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-3 py-2">
          This note has been superseded by a signed amendment.
        </p>
      )}

      <div className="space-y-3">
        {order.map((key) => {
          // content is Record<string, unknown> server-side; only render string fields.
          const value = note.content[key];
          return typeof value === "string" && value ? (
            <div key={key}>
              <h5 className="text-sm font-semibold text-gray-700">{fieldLabel(key)}</h5>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{value}</p>
            </div>
          ) : null;
        })}
      </div>

      {note.sign_hash && (
        <p className="mt-4 text-xs text-gray-400 flex items-center gap-1 break-all">
          <Lock size={11} aria-hidden="true" /> Signature hash: {note.sign_hash}
        </p>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {isAuthor && (
        <div className="mt-4 flex gap-2 flex-wrap">
          {note.status === "draft" && (
            <button
              type="button"
              onClick={() => onEditDraft(note)}
              className="px-4 py-2 bg-royal text-white rounded-md hover:bg-blue-700 flex items-center gap-1.5 min-h-[44px]"
            >
              <Edit3 size={15} aria-hidden="true" /> Edit draft
            </button>
          )}
          {note.status === "signed" && (
            <button
              type="button"
              onClick={handleAmend}
              disabled={busy}
              className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:opacity-50 min-h-[44px]"
            >
              Amend
            </button>
          )}
          {note.note_type === "progress" && note.status !== "amended" && (
            <button
              type="button"
              onClick={handleShareToggle}
              disabled={busy}
              className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
              title="Shared progress notes are visible to caseworkers on the care team"
            >
              <Share2 size={15} aria-hidden="true" />
              {note.shared_with_care_team ? "Unshare from care team" : "Share with care team"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
