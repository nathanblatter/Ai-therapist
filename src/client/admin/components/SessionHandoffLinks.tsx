// Session Detail: the text hand-off links on this session (ai-therapist-356),
// so a reviewer can follow voice call -> vendor cut -> typed chat (-> voice
// again) across session ids. Backed by GET
// /admin/api/sessions/:sessionId/handoff-links (session ids, enums, times).
import { useEffect, useState } from 'react';
import { CornerDownRight, Link2 } from 'react-feather';
import { getJson } from '../../shared/http';
import CopyButton from '../../shared/components/CopyButton';

export interface HandoffLink {
  at: string;
  event: 'voice_cut_text_handoff' | 'voice_resumed_from_text';
  role: string | null;
  from: string | null;
  to: string | null;
  unlinkedFrom: string | null;
  reason: string | null;
  kind: string | null;
  severity: string | null;
  participantSeverity: string | null;
  source: string | null;
}

const REASON: Record<string, string> = {
  content: "the voice service's content filter",
  expired: "the voice service's session time limit",
};

const KIND: Record<string, string> = {
  crisis: 'crisis question (Yes / No / Not sure)',
  ceiling: 'time-limit message',
  checkin: 'check-in (earlier high flag in another session)',
  neutral: 'neutral message',
};

/** One line describing a link row, from this session's point of view. */
export function describeHandoffLink(link: HandoffLink): { text: string; other: string | null } {
  const reason = REASON[link.reason ?? ''] ?? 'the voice service';
  if (link.event === 'voice_resumed_from_text') {
    return { text: 'Voice call started again from the hand-off chat', other: link.from };
  }
  if (link.role === 'cut_session') {
    return { text: `Ended by ${reason}; the conversation continued in typed chat`, other: link.to };
  }
  const details = [
    link.kind ? `first message: ${KIND[link.kind] ?? link.kind}` : null,
    link.severity ? `risk in that call: ${link.severity}` : null,
    link.participantSeverity ? `participant, last 2 h: ${link.participantSeverity}` : null,
    link.source === 'client_fallback' ? 'recorded from the browser fallback' : null,
  ]
    .filter(Boolean)
    .join('; ');
  if (link.from) {
    return { text: `Typed-chat continuation of a voice call ended by ${reason} (${details})`, other: link.from };
  }
  return {
    text: `Typed-chat continuation (${details}); the ended call was not linked (not this participant's session)`,
    other: link.unlinkedFrom,
  };
}

export default function SessionHandoffLinks({ sessionId }: { sessionId: string }) {
  const [links, setLinks] = useState<HandoffLink[] | null>(null);

  useEffect(() => {
    let live = true;
    getJson<{ links: HandoffLink[] }>(`/admin/api/sessions/${encodeURIComponent(sessionId)}/handoff-links`)
      .then((data) => live && setLinks(data.links ?? []))
      .catch((err) => {
        console.error('Failed to fetch hand-off links:', err);
        if (live) setLinks([]);
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (!links || links.length === 0) return null;

  return (
    <div className="mb-4 bg-white border border-gray-200 rounded-lg p-3" data-testid="session-handoff-links">
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={16} className="text-navy" aria-hidden="true" />
        <span className="font-semibold text-navy">Linked sessions (text hand-off)</span>
      </div>
      <ul className="space-y-2">
        {links.map((link, i) => {
          const { text, other } = describeHandoffLink(link);
          return (
            <li key={`${link.at}-${i}`} className="flex items-start gap-2 text-sm">
              <CornerDownRight size={14} className="mt-1 flex-shrink-0 text-gray-400" aria-hidden="true" />
              <div>
                <p className="text-gray-800">{text}</p>
                <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                  {new Date(link.at).toLocaleString()}
                  {other && (
                    <>
                      <code className="bg-gray-100 px-1.5 py-0.5 rounded">{other}</code>
                      <CopyButton textToCopy={other} />
                    </>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
