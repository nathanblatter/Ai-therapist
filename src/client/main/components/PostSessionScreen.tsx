// Shown after a session ends (ai-therapist-25b + ai-therapist-76): a short
// optional feedback survey, and a "download my work" button that builds a
// printable recap of what the participant chose to keep — never the raw
// transcript, and nothing beyond what they explicitly entered/shared.
import { useState } from 'react';
import { Download, Check } from 'react-feather';
import type { SafetyPlanData } from './ToolOverlays';

export interface SessionRecapData {
  focus: string;
  techniques?: string[];
  takeaway: string;
}

export interface SharedWriteup {
  type: 'thought_record' | 'journal' | 'values_sort' | 'fear_ladder';
  label: string;
  summary: string;
}

export interface PostSessionData {
  sessionId: string;
  endedAt: Date;
  recap: SessionRecapData | null;
  safetyPlan: SafetyPlanData | null;
  writeups: SharedWriteup[];
}

interface PostSessionScreenProps {
  data: PostSessionData;
  onDismiss: () => void;
}

const LIKERT_LABELS = ['1', '2', '3', '4', '5'];

function LikertRow({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number) => void }) {
  return (
    <div className="mb-4">
      <p className="text-sm font-medium text-gray-700 mb-1.5">{label}</p>
      <div className="flex gap-2" role="radiogroup" aria-label={label}>
        {LIKERT_LABELS.map((n, i) => {
          const v = i + 1;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === v}
              onClick={() => onChange(v)}
              className={`w-10 h-10 rounded-full text-sm font-medium border transition-colors ${
                value === v
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-1 px-1">
        <span>Not at all</span>
        <span>Very much</span>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build a self-contained printable HTML document from only what the
 *  participant chose to keep/share — no raw transcript, no data they didn't
 *  themselves enter or approve for on-screen display. */
function buildPrintableHtml(data: PostSessionData): string {
  const dateStr = data.endedAt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const recapHtml = data.recap
    ? `<section>
        <h2>Session Recap</h2>
        <p><strong>We talked about:</strong> ${escapeHtml(data.recap.focus)}</p>
        ${data.recap.techniques && data.recap.techniques.length > 0
          ? `<p><strong>Things we tried:</strong> ${data.recap.techniques.map(escapeHtml).join(', ')}</p>`
          : ''}
        <p><strong>Worth keeping:</strong> ${escapeHtml(data.recap.takeaway)}</p>
      </section>`
    : '';

  const planSections: { key: keyof SafetyPlanData; label: string }[] = [
    { key: 'warning_signs', label: 'My early warning signs' },
    { key: 'coping_strategies', label: 'What helps me' },
    { key: 'support_contacts', label: 'People I can reach out to' },
    { key: 'reasons_worth_living', label: 'What matters to me' },
  ];
  const safetyPlanHtml = data.safetyPlan
    ? `<section>
        <h2>My Safety Plan</h2>
        ${planSections.map(({ key, label }) => {
          const items = data.safetyPlan?.[key];
          if (!items || items.length === 0) return '';
          return `<p><strong>${escapeHtml(label)}:</strong></p><ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
        }).join('')}
        <p><strong>If you're in crisis:</strong></p>
        <ul>
          <li>988 Suicide &amp; Crisis Lifeline (call or text 988)</li>
          <li>Crisis Text Line (text HOME to 741741)</li>
          <li>911 for immediate danger</li>
        </ul>
      </section>`
    : '';

  const writeupsHtml = data.writeups.length > 0
    ? `<section>
        <h2>What I Worked On</h2>
        ${data.writeups.map(w => `<div class="writeup"><h3>${escapeHtml(w.label)}</h3><p>${escapeHtml(w.summary).replace(/\n/g, '<br/>')}</p></div>`).join('')}
      </section>`
    : '';

  const body = recapHtml || safetyPlanHtml || writeupsHtml
    ? `${recapHtml}${safetyPlanHtml}${writeupsHtml}`
    : `<p>No recap, safety plan, or shared exercises were saved for this session.</p>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>My Session Summary — ${escapeHtml(dateStr)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; max-width: 700px; margin: 40px auto; padding: 0 24px; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .date { color: #6b7280; font-size: 13px; margin-bottom: 32px; }
  h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  h3 { font-size: 14px; margin-top: 16px; margin-bottom: 4px; }
  ul { margin: 4px 0; padding-left: 20px; }
  .writeup { margin-top: 12px; }
  .footer { margin-top: 40px; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <h1>My Session Summary</h1>
  <div class="date">${escapeHtml(dateStr)}</div>
  ${body}
  <div class="footer">
    This document contains only what you chose to save or share during your session — not a transcript of your conversation.
  </div>
</body>
</html>`;
}

/** Opens a new tab with the printable summary and triggers the browser print
 *  dialog (participant can "Save as PDF" from there) — no server round-trip,
 *  no PII beyond what they entered. */
function downloadMyWork(data: PostSessionData): void {
  const html = buildPrintableHtml(data);
  const win = window.open('', '_blank');
  if (!win) {
    // Popup blocked — fall back to a same-tab data URL download of the HTML.
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-session-summary.html';
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // Give the new document a tick to paint before invoking print.
  setTimeout(() => win.print(), 300);
}

export default function PostSessionScreen({ data, onDismiss }: PostSessionScreenProps) {
  const [helpfulness, setHelpfulness] = useState<number | null>(null);
  const [ease, setEase] = useState<number | null>(null);
  const [wouldReturn, setWouldReturn] = useState<number | null>(null);
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const hasAnyArtifact = Boolean(data.recap || data.safetyPlan) || data.writeups.length > 0;

  const submitFeedback = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/sessions/${data.sessionId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          helpfulness_rating: helpfulness,
          ease_rating: ease,
          would_return_rating: wouldReturn,
          comments: comments.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('Failed to submit feedback');
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-full px-4 overflow-y-auto py-8">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-semibold text-gray-800">Session complete</h2>
          <p className="text-gray-500 mt-1">Thank you for taking this time for yourself.</p>
        </div>

        {hasAnyArtifact && (
          <div className="bg-white rounded-2xl shadow p-6">
            <button
              onClick={() => downloadMyWork(data)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-lg transition-colors"
            >
              <Download size={18} /> Download my work
            </button>
            <p className="text-xs text-gray-400 text-center mt-2">
              Your session recap, anything you chose to share, and your safety plan — not the conversation itself.
            </p>
          </div>
        )}

        <div className="bg-white rounded-2xl shadow p-6">
          {submitted ? (
            <div className="flex items-center gap-2 text-green-700">
              <Check size={20} /> <span className="font-medium">Thanks for your feedback.</span>
            </div>
          ) : (
            <>
              <h3 className="text-lg font-semibold text-gray-800 mb-4">How was today&apos;s session?</h3>
              <LikertRow label="How helpful was this conversation?" value={helpfulness} onChange={setHelpfulness} />
              <LikertRow label="How easy was it to use?" value={ease} onChange={setEase} />
              <LikertRow label="How likely are you to use this again?" value={wouldReturn} onChange={setWouldReturn} />
              <div className="mb-2">
                <label htmlFor="feedback-comments" className="text-sm font-medium text-gray-700 mb-1.5 block">
                  Anything else you&apos;d like us to know? (optional)
                </label>
                <textarea
                  id="feedback-comments"
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  placeholder="Optional feedback..."
                />
              </div>
              {submitError && <p className="text-sm text-red-600 mb-2">{submitError}</p>}
              <div className="flex justify-end gap-3 mt-4">
                <button onClick={onDismiss} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
                  Skip
                </button>
                <button
                  onClick={submitFeedback}
                  disabled={submitting || (helpfulness === null && ease === null && wouldReturn === null && !comments.trim())}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-5 py-2.5 rounded-lg"
                >
                  {submitting ? 'Submitting...' : 'Submit feedback'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="text-center">
          <button onClick={onDismiss} className="text-sm text-blue-600 hover:underline">
            Return to start
          </button>
        </div>
      </div>
    </div>
  );
}
