// Wave-2 tool UI surfaces, launched from AI function calls on the WebRTC data
// channel (same pattern as ExerciseOverlay): crisis resource card, CBT thought
// record, private journal, session recap, safety plan card, and PHQ-2/GAD-2
// screener form. One overlay at a time, dispatched by `kind`.
import { useState, useEffect } from 'react';
import { X, Phone, MessageSquare, CheckCircle } from 'react-feather';

// ---------- shared ----------

export type ToolUI =
  | { kind: 'resource'; resourceType: string }
  | { kind: 'thought_record' }
  | { kind: 'journal'; prompt: string }
  | { kind: 'recap'; focus: string; techniques?: string[]; takeaway: string }
  | { kind: 'safety_plan'; plan: SafetyPlanData }
  | { kind: 'scale'; scale: string };

export interface SafetyPlanData {
  warning_signs?: string[];
  coping_strategies?: string[];
  support_contacts?: string[];
  reasons_worth_living?: string[];
}

interface ToolOverlaysProps {
  ui: ToolUI | null;
  onClose: () => void;
  /** Send text into the conversation as the participant (journal "share"). */
  onShareText: (text: string) => void;
  /** Tell the model something invisibly (thought record / scale results). */
  onInvisibleMessage: (text: string) => void;
  /** Persist a structured record into the session log. */
  onLogRecord: (type: string, message: string, extras: Record<string, unknown>) => void;
  sessionId: string | null;
}

function Shell({ title, onClose, children, wide = false }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-40" aria-hidden="true" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
        <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto animate-fadeIn`}>
          <header className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
            <button onClick={onClose} aria-label="Close"
              className="p-1.5 hover:bg-gray-100 rounded-full transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center">
              <X size={20} className="text-gray-500" />
            </button>
          </header>
          {children}
        </div>
      </div>
    </>
  );
}

// ---------- resource card ----------

const RESOURCES = [
  { key: 'suicide', name: '988 Suicide & Crisis Lifeline', phone: '988', sms: { number: '988', body: '' }, note: 'Free, confidential, 24/7' },
  { key: 'mental_health', name: 'Crisis Text Line', phone: null, sms: { number: '741741', body: 'HOME' }, note: 'Text HOME to 741741, 24/7' },
  { key: 'domestic_violence', name: 'National Domestic Violence Hotline', phone: '1-800-799-7233', sms: { number: '88788', body: 'START' }, note: '24/7' },
  { key: 'substance_abuse', name: 'SAMHSA National Helpline', phone: '1-800-662-4357', sms: null, note: 'Treatment referrals, 24/7' },
];

function ResourceCard({ resourceType, onClose }: { resourceType: string; onClose: () => void }) {
  const shown = resourceType === 'all' ? RESOURCES : RESOURCES.filter(r => r.key === resourceType);
  const list = shown.length > 0 ? shown : RESOURCES;
  return (
    <Shell title="Support is available" onClose={onClose}>
      <div className="px-6 py-5 space-y-3">
        <p className="text-sm text-gray-500">You can tap any of these, any time — now or later.</p>
        {list.map(r => (
          <div key={r.key} className="border border-gray-200 rounded-xl p-4">
            <p className="font-medium text-gray-900">{r.name}</p>
            <p className="text-xs text-gray-500 mb-3">{r.note}</p>
            <div className="flex gap-2">
              {r.phone && (
                <a href={`tel:${r.phone.replace(/[^0-9+]/g, '')}`}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg">
                  <Phone size={15} /> Call {r.phone}
                </a>
              )}
              {r.sms && (
                <a href={`sms:${r.sms.number}${r.sms.body ? `?&body=${r.sms.body}` : ''}`}
                  className="flex-1 flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-medium px-4 py-2.5 rounded-lg">
                  <MessageSquare size={15} /> Text {r.sms.body || r.sms.number}
                </a>
              )}
            </div>
          </div>
        ))}
        <p className="text-xs text-gray-400 text-center pt-1">In immediate danger? Call 911.</p>
      </div>
    </Shell>
  );
}

// ---------- thought record ----------

const TR_STEPS = [
  { field: 'situation', label: 'What happened?', hint: 'The situation, briefly — where, when, who.' },
  { field: 'thought', label: 'What went through your mind?', hint: 'The automatic thought, in its own words.' },
  { field: 'feeling', label: 'What did you feel?', hint: 'Feelings and how strong they were (0-100%).' },
  { field: 'evidence_for', label: 'Evidence that the thought is true', hint: 'Facts only, not interpretations.' },
  { field: 'evidence_against', label: 'Evidence that it might not be the whole story', hint: 'Facts that don\'t fit the thought.' },
  { field: 'balanced_thought', label: 'A more balanced thought', hint: 'Considering both sides, what\'s a fairer way to see it?' },
] as const;

function ThoughtRecord({ onClose, onComplete }: { onClose: () => void; onComplete: (record: Record<string, string>) => void }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const current = TR_STEPS[step];
  const isLast = step === TR_STEPS.length - 1;
  const value = values[current.field] ?? '';

  return (
    <Shell title="Thought record" onClose={onClose} wide>
      <div className="px-6 py-5 space-y-4">
        <div className="flex gap-1.5" aria-hidden="true">
          {TR_STEPS.map((s, i) => (
            <div key={s.field} className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-blue-500' : 'bg-gray-200'}`} />
          ))}
        </div>
        <div>
          <label className="block text-base font-medium text-gray-800 mb-1">{current.label}</label>
          <p className="text-xs text-gray-500 mb-2">{current.hint}</p>
          <textarea
            value={value}
            onChange={(e) => setValues(v => ({ ...v, [current.field]: e.target.value }))}
            rows={4}
            maxLength={1000}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            autoFocus
          />
        </div>
        <div className="flex justify-between">
          <button onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
            className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <button
            onClick={() => (isLast ? onComplete(values) : setStep(step + 1))}
            disabled={!value.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-5 py-2.5 rounded-lg">
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </Shell>
  );
}

// ---------- journal ----------

function Journal({ prompt, onClose, onShare }: { prompt: string; onClose: () => void; onShare: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Shell title="A moment to write" onClose={onClose} wide>
      <div className="px-6 py-5 space-y-4">
        <p className="text-gray-700 italic">&ldquo;{prompt}&rdquo;</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          maxLength={4000}
          placeholder="This space is yours. Nothing is shared unless you choose to."
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          autoFocus
        />
        <div className="flex justify-between items-center">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
            Keep it private
          </button>
          <button
            onClick={() => onShare(text)}
            disabled={!text.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-5 py-2.5 rounded-lg">
            Share with the AI
          </button>
        </div>
        <p className="text-xs text-gray-400">&ldquo;Keep it private&rdquo; closes this without saving or sending anything.</p>
      </div>
    </Shell>
  );
}

// ---------- recap ----------

function Recap({ focus, techniques, takeaway, onClose }: { focus: string; techniques?: string[]; takeaway: string; onClose: () => void }) {
  return (
    <Shell title="Today's conversation" onClose={onClose}>
      <div className="px-6 py-5 space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">We talked about</p>
          <p className="text-gray-800">{focus}</p>
        </div>
        {techniques && techniques.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Things we tried</p>
            <div className="flex flex-wrap gap-1.5">
              {techniques.map(t => (
                <span key={t} className="bg-blue-50 text-blue-800 text-xs px-2.5 py-1 rounded-full">{t}</span>
              ))}
            </div>
          </div>
        )}
        <div className="bg-blue-50 rounded-xl p-4">
          <p className="text-xs uppercase tracking-wide text-blue-400 mb-1">Worth keeping</p>
          <p className="text-blue-900">{takeaway}</p>
        </div>
        <p className="text-xs text-gray-400 text-center">Screenshot this if you&apos;d like to keep it.</p>
      </div>
    </Shell>
  );
}

// ---------- safety plan ----------

const PLAN_SECTIONS: { key: keyof SafetyPlanData; label: string }[] = [
  { key: 'warning_signs', label: 'My early warning signs' },
  { key: 'coping_strategies', label: 'What helps me' },
  { key: 'support_contacts', label: 'People I can reach out to' },
  { key: 'reasons_worth_living', label: 'What matters to me' },
];

function SafetyPlanCard({ plan, onClose }: { plan: SafetyPlanData; onClose: () => void }) {
  return (
    <Shell title="Your safety plan" onClose={onClose} wide>
      <div className="px-6 py-5 space-y-4">
        {PLAN_SECTIONS.map(({ key, label }) => {
          const items = plan[key];
          if (!items || items.length === 0) return null;
          return (
            <div key={key}>
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">{label}</p>
              <ul className="space-y-1">
                {items.map(item => (
                  <li key={item} className="text-gray-800 text-sm flex gap-2">
                    <CheckCircle size={15} className="text-blue-500 flex-shrink-0 mt-0.5" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <div className="bg-red-50 rounded-xl p-4 space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-red-400">If things feel unsafe</p>
          <a href="tel:988" className="block text-sm text-red-900 font-medium">Call or text 988 — Suicide &amp; Crisis Lifeline</a>
          <a href="sms:741741?&body=HOME" className="block text-sm text-red-900">Text HOME to 741741 — Crisis Text Line</a>
          <p className="text-sm text-red-900">Call 911 for immediate danger</p>
        </div>
        <p className="text-xs text-gray-400 text-center">Screenshot this so it&apos;s with you when you need it.</p>
      </div>
    </Shell>
  );
}

// ---------- scale (PHQ-2 / GAD-2) ----------

interface ScaleDef {
  id: string;
  name: string;
  intro: string;
  items: string[];
  options: { label: string; value: number }[];
  max_score: number;
}

function ScaleForm({ scale, sessionId, onClose, onResult }: {
  scale: string; sessionId: string | null; onClose: () => void;
  onResult: (summary: string) => void;
}) {
  const [def, setDef] = useState<ScaleDef | null>(null);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/scales/${scale}`)
      .then(res => (res.ok ? res.json() : null))
      .then((d: ScaleDef | null) => {
        if (d) { setDef(d); setAnswers(new Array(d.items.length).fill(null)); }
        else onClose();
      })
      .catch(onClose);
  }, [scale, onClose]);

  if (!def) return null;
  const complete = answers.every(a => a !== null);

  const submit = async () => {
    if (!complete || !sessionId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/scale-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scale: def.id, answers }),
      });
      if (res.ok) {
        const data = await res.json() as { score: number; max_score: number };
        onResult(`[${def.name} completed] Score ${data.score}/${data.max_score}. Item answers: ${answers.join(', ')}. Respond supportively and naturally — do not read the score out as a verdict or diagnosis.`);
      }
    } finally {
      setSubmitting(false);
      onClose();
    }
  };

  return (
    <Shell title={def.name} onClose={onClose} wide>
      <div className="px-6 py-5 space-y-5">
        <p className="text-sm text-gray-600">{def.intro}</p>
        {def.items.map((item, i) => (
          <div key={item}>
            <p className="text-sm font-medium text-gray-800 mb-2">{item}</p>
            <div className="grid grid-cols-2 gap-2">
              {def.options.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setAnswers(a => a.map((v, j) => (j === i ? opt.value : v)))}
                  className={`text-xs px-3 py-2.5 rounded-lg border transition-colors ${
                    answers[i] === opt.value
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex justify-between items-center">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
            Skip
          </button>
          <button
            onClick={() => void submit()}
            disabled={!complete || submitting}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-5 py-2.5 rounded-lg">
            {submitting ? 'Saving…' : 'Done'}
          </button>
        </div>
        <p className="text-xs text-gray-400">A brief check-in, not a diagnosis. Answering is always optional.</p>
      </div>
    </Shell>
  );
}

// ---------- dispatcher ----------

export default function ToolOverlays({ ui, onClose, onShareText, onInvisibleMessage, onLogRecord, sessionId }: ToolOverlaysProps) {
  if (!ui) return null;

  switch (ui.kind) {
    case 'resource':
      return <ResourceCard resourceType={ui.resourceType} onClose={onClose} />;
    case 'thought_record':
      return (
        <ThoughtRecord
          onClose={onClose}
          onComplete={(record) => {
            onLogRecord('thought_record', 'Thought record completed', record);
            onInvisibleMessage(
              `[Thought record completed by participant] Situation: ${record.situation}. Automatic thought: ${record.thought}. Feeling: ${record.feeling}. Evidence for: ${record.evidence_for}. Evidence against: ${record.evidence_against}. Balanced thought: ${record.balanced_thought}. Respond warmly to their balanced thought.`
            );
            onClose();
          }}
        />
      );
    case 'journal':
      return (
        <Journal
          prompt={ui.prompt}
          onClose={() => {
            onInvisibleMessage('[The participant finished writing privately and chose not to share it. Ask gently how the writing felt — do not ask what they wrote.]');
            onClose();
          }}
          onShare={(text) => {
            onShareText(`I wrote this just now: ${text}`);
            onClose();
          }}
        />
      );
    case 'recap':
      return <Recap focus={ui.focus} techniques={ui.techniques} takeaway={ui.takeaway} onClose={onClose} />;
    case 'safety_plan':
      return <SafetyPlanCard plan={ui.plan} onClose={onClose} />;
    case 'scale':
      return <ScaleForm scale={ui.scale} sessionId={sessionId} onClose={onClose} onResult={onInvisibleMessage} />;
    default:
      return null;
  }
}
