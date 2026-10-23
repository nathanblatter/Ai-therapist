// Weekly digest panel (eval spec WP7): the archive of PI-facing weekly
// digests for the researcher's org, a Generate control for any complete week,
// the weekly schedule (evals.digest_schedule) and a rendered preview of the
// selected digest's markdown. Self-fetching; SimulationRunsPanel pattern.
//
// The preview uses renderMarkdownLite below rather than a markdown library:
// the digest's markdown is a known, narrow dialect (headings, paragraphs,
// bullet lists, pipe tables, bold, horizontal rule) and React escapes every
// text node, so nothing in a digest can reach the page as HTML.
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { getJson, postJson } from '../../shared/http';
import { FileText, Download, RefreshCw, Save, Calendar } from 'react-feather';
import { toast } from '../../shared/components/Toast';

interface DigestSummary {
  id: number;
  org_id: number;
  week_ending: string;
  generated_at: string;
  generated_by: string;
}

interface DigestSchedule {
  enabled: boolean;
  weekday: number;
  hour_utc: number;
}

interface DigestDetail extends DigestSummary {
  markdown: string;
  data: { meta?: { git_sha?: string } };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// Minimal, safe markdown rendering (text nodes only; no HTML pass-through)
// ---------------------------------------------------------------------------

/** Inline: **bold** only. Everything else is literal text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={`${keyPrefix}-b${i++}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (line: string): boolean => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);

export function renderMarkdownLite(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const cls = level === 1 ? 'text-xl font-bold mt-2' : level === 2 ? 'text-lg font-semibold mt-4' : 'font-semibold mt-3';
      const Tag = (`h${Math.min(level + 2, 6)}`) as keyof JSX.IntrinsicElements;
      out.push(<Tag key={key++} className={cls}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(line)) { out.push(<hr key={key++} className="my-3 border-gray-200" />); i++; continue; }
    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        <div key={key++} className="overflow-x-auto my-2">
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr>{headers.map((h, hi) => <th key={hi} className="text-left px-2 py-1 border-b border-gray-300 font-medium">{renderInline(h, `th${key}-${hi}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="odd:bg-gray-50">
                  {headers.map((_, ci) => <td key={ci} className="px-2 py-1 border-b border-gray-100 align-top">{renderInline(r[ci] ?? '', `td${key}-${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push(<ul key={key++} className="list-disc pl-6 my-2 space-y-1 text-sm">{items.map((it, ii) => <li key={ii}>{renderInline(it, `li${key}-${ii}`)}</li>)}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s/.test(lines[i]) && !isTableRow(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*-{3,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(<p key={key++} className="my-2 text-sm leading-relaxed">{renderInline(para.join(' '), `p${key}`)}</p>);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function WeeklyDigestPanel() {
  const [digests, setDigests] = useState<DigestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weekEnding, setWeekEnding] = useState('');
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<DigestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [schedule, setSchedule] = useState<DigestSchedule>({ enabled: false, weekday: 1, hour_utc: 6 });
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getJson<{ digests?: DigestSummary[]; schedule?: DigestSchedule; default_week_ending?: string }>('/admin/api/evals/digests', { fallback: 'Failed to fetch digests' })
      .then(data => {
        setDigests(data.digests ?? []);
        if (data.schedule) setSchedule(data.schedule);
        setWeekEnding(prev => prev || data.default_week_ending || '');
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = (id: number) => {
    setDetailLoading(true);
    getJson<{ digest: DigestDetail }>(`/admin/api/evals/digests/${id}`, { fallback: 'Failed to fetch digest' })
      .then(data => setSelected(data.digest))
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to fetch digest'))
      .finally(() => setDetailLoading(false));
  };

  const generate = () => {
    setGenerating(true);
    postJson<{ digest: DigestDetail }>('/admin/api/evals/digests/generate', { week_ending: weekEnding || undefined }, { fallback: 'Failed to generate digest' })
      .then(data => {
        toast.success(`Digest generated for week ending ${data.digest.week_ending}`);
        setSelected(data.digest);
        load();
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to generate digest'))
      .finally(() => setGenerating(false));
  };

  const saveSchedule = () => {
    setSavingSchedule(true);
    postJson<{ schedule: DigestSchedule }>('/admin/api/evals/digests/schedule', schedule, { method: 'PUT', fallback: 'Failed to save schedule' })
      .then(data => { setSchedule(data.schedule); toast.success('Digest schedule saved'); })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to save schedule'))
      .finally(() => setSavingSchedule(false));
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><FileText size={18} /> Weekly digest</h3>
        <button type="button" onClick={load} className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        A PI-ready markdown summary of the week: sessions evaluated, score trends, judge agreement, drift alerts,
        harness pass rates, crisis events and calibration status. Aggregates only. Nothing is emailed: download and forward it.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">Week ending (Sunday, UTC)</span>
          <input type="date" value={weekEnding} onChange={e => setWeekEnding(e.target.value)} className="border rounded px-2 py-1" />
        </label>
        <button type="button" onClick={generate} disabled={generating}
          className="px-3 py-1.5 rounded bg-[#0047BA] text-white text-sm disabled:opacity-50 flex items-center gap-1">
          <Calendar size={14} /> {generating ? 'Generating...' : 'Generate'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-6 text-sm border-t pt-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={schedule.enabled} onChange={e => setSchedule(s => ({ ...s, enabled: e.target.checked }))} />
          Generate automatically
        </label>
        <label>
          <span className="block text-gray-600 mb-1">Weekday</span>
          <select value={schedule.weekday} onChange={e => setSchedule(s => ({ ...s, weekday: Number(e.target.value) }))} className="border rounded px-2 py-1">
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </label>
        <label>
          <span className="block text-gray-600 mb-1">Hour (UTC)</span>
          <input type="number" min={0} max={23} value={schedule.hour_utc} onChange={e => setSchedule(s => ({ ...s, hour_utc: Number(e.target.value) }))} className="border rounded px-2 py-1 w-20" />
        </label>
        <button type="button" onClick={saveSchedule} disabled={savingSchedule}
          className="px-3 py-1.5 rounded border text-sm disabled:opacity-50 flex items-center gap-1">
          <Save size={14} /> Save schedule
        </button>
        <span className="text-gray-500">Covers the week ending the Sunday before the run; stage only.</span>
      </div>

      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}

      <div className="grid gap-6 md:grid-cols-[minmax(0,16rem)_1fr]">
        <div>
          {loading && digests.length === 0 ? (
            <div className="text-sm text-gray-500">Loading...</div>
          ) : digests.length === 0 ? (
            <div className="text-sm text-gray-500">No digests yet. Generate one above.</div>
          ) : (
            <ul className="divide-y text-sm">
              {digests.map(d => (
                <li key={d.id} className={`py-2 flex items-center justify-between gap-2 ${selected?.id === d.id ? 'font-semibold' : ''}`}>
                  <button type="button" onClick={() => open(d.id)} className="text-left hover:underline">
                    Week ending {d.week_ending}
                    <span className="block text-xs text-gray-500 font-normal">{new Date(d.generated_at).toLocaleString()} ({d.generated_by})</span>
                  </button>
                  <a href={`/admin/api/evals/digests/${d.id}.md`} className="text-gray-600 hover:text-gray-900" title="Download markdown" download>
                    <Download size={14} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 border rounded p-4 bg-gray-50">
          {detailLoading ? (
            <div className="text-sm text-gray-500">Loading digest...</div>
          ) : selected ? (
            <div>
              <div className="flex justify-end mb-2">
                <a href={`/admin/api/evals/digests/${selected.id}.md`} download className="text-sm text-[#0047BA] hover:underline flex items-center gap-1">
                  <Download size={14} /> Download .md
                </a>
              </div>
              <div className="prose-sm max-w-none">{renderMarkdownLite(selected.markdown)}</div>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Select a digest to preview it.</div>
          )}
        </div>
      </div>
    </div>
  );
}
