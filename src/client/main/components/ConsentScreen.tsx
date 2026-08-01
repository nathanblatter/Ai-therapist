// Participant consent screen (IRB requirement, ai-therapist-24). Blocks
// session start until the participant explicitly acknowledges recording,
// transcription, live admin monitoring, data retention, and the
// crisis-protocol disclosure. The stable disclosure copy is now served from
// the versioned consent_documents table (migration 047, ai-therapist-94) and
// rendered from the `body` prop; the recording-disclosure bullet stays
// client-rendered because it varies with features.session_recording_enabled.
// Acceptance is recorded server-side (timestamp + version + body hash) via
// POST /api/consent/accept.
import { useState } from 'react';

interface ConsentScreenProps {
  isOpen: boolean;
  /** Whether features.session_recording_enabled is currently on — changes the
   * recording disclosure's wording (and whether it's shown as active at all). */
  recordingEnabled: boolean;
  consentVersion: string;
  /** Stable consent copy (markdown) from GET /api/consent/status. */
  body: string;
  /** True when the participant previously accepted an OLDER version. */
  reconsentRequired: boolean;
  onCancel: () => void;
  onAccept: () => void;
}

/** Minimal renderer for the consent body: `## heading`, `- **bold** rest`
 *  bullets, and plain paragraphs. The copy is authored/controlled server-side. */
function renderConsentBody(body: string) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: JSX.Element[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="space-y-3 text-sm text-gray-700 mb-5">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{renderInline(b)}</span>
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flushBullets();
      blocks.push(
        <h2 key={`h-${blocks.length}`} className="text-xl font-semibold text-gray-900 mb-1">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
    } else if (line.trim() === '') {
      flushBullets();
    } else {
      flushBullets();
      blocks.push(
        <p key={`p-${blocks.length}`} className="text-sm text-gray-500 mb-4">
          {renderInline(line)}
        </p>
      );
    }
  }
  flushBullets();
  return blocks;
}

/** Render **bold** spans within a line of consent copy. */
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>
  );
}

export default function ConsentScreen({ isOpen, recordingEnabled, consentVersion, body, reconsentRequired, onCancel, onAccept }: ConsentScreenProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAccept = async () => {
    if (!acknowledged || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/consent/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ consentVersion }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      onAccept();
    } catch (err) {
      console.error('[Consent] Failed to record acceptance:', err);
      setError('Something went wrong recording your acceptance. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-40" aria-hidden="true" />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-heading"
      >
        <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
          {reconsentRequired && (
            <div className="mb-4 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
              Our consent terms have been updated since you last agreed. Please review and re-accept to continue.
            </div>
          )}

          <div id="consent-heading">{renderConsentBody(body)}</div>

          {recordingEnabled && (
            <ul className="space-y-3 text-sm text-gray-700 mb-5 -mt-2">
              <li className="flex gap-2">
                <span aria-hidden="true">🎙️</span>
                <span>
                  <strong>Audio recording.</strong> This session's audio (your microphone and the
                  assistant's voice) is recorded and stored securely for the duration of the retention
                  period below.
                </span>
              </li>
            </ul>
          )}

          <label className="flex items-start gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span className="text-sm text-gray-800">
              I have read and understand the above, and I consent to participate under these terms.
            </span>
          </label>

          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={!acknowledged || submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Recording...' : 'I agree, start session'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
