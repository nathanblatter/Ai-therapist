// Participant consent screen (IRB requirement, ai-therapist-24). Blocks
// session start until the participant explicitly acknowledges recording,
// transcription, live admin monitoring, data retention, and the
// crisis-protocol disclosure. Acceptance is recorded server-side (timestamp +
// consent version) via POST /api/consent/accept.
import { useState } from 'react';

interface ConsentScreenProps {
  isOpen: boolean;
  /** Whether features.session_recording_enabled is currently on — changes the
   * recording disclosure's wording (and whether it's shown as active at all). */
  recordingEnabled: boolean;
  consentVersion: string;
  onCancel: () => void;
  onAccept: () => void;
}

export default function ConsentScreen({ isOpen, recordingEnabled, consentVersion, onCancel, onAccept }: ConsentScreenProps) {
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
          <h2 id="consent-heading" className="text-xl font-semibold text-gray-900 mb-1">
            Before we begin
          </h2>
          <p className="text-sm text-gray-500 mb-4">Please review and accept to start your session.</p>

          <ul className="space-y-3 text-sm text-gray-700 mb-5">
            {recordingEnabled && (
              <li className="flex gap-2">
                <span aria-hidden="true">🎙️</span>
                <span>
                  <strong>Audio recording.</strong> This session's audio (your microphone and the
                  assistant's voice) is recorded and stored securely for the duration of the retention
                  period below.
                </span>
              </li>
            )}
            <li className="flex gap-2">
              <span aria-hidden="true">📝</span>
              <span>
                <strong>Transcription.</strong> What you say is transcribed to text so the assistant can
                respond and so your session can be reviewed as part of this study.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">👀</span>
              <span>
                <strong>Live monitoring.</strong> A researcher or therapist may be monitoring sessions in
                real time and can send messages into your conversation if needed.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">🗄️</span>
              <span>
                <strong>Data retention.</strong> Session content is retained only as long as needed for
                the study and is redacted of identifying details before long-term storage. Raw content is
                automatically deleted after the retention period.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">🚨</span>
              <span>
                <strong>Crisis protocol.</strong> If anything you say suggests you may be in danger, our
                system may show you crisis resources (e.g. the 988 Suicide &amp; Crisis Lifeline), and in
                some cases a member of our team may be notified so they can reach out to you directly.
              </span>
            </li>
          </ul>

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
