// Survey Data panel (ai-therapist-149): the analysis view over synced
// Qualtrics responses — per-participant completion matrix on the protocol
// calendar (weeks 1-8 + exit + week 12), PHQ-2/GAD-2 instrument aggregates,
// and weekly mood/stress/helpfulness trends. Data: GET
// /admin/api/qualtrics/data (researcher-only; 503 until the integration env
// is configured). Scores are computed server-side from verified QID maps.
import { useState } from "react";
import { Clipboard, Check, Minus, Users, TrendingUp, AlertTriangle } from "react-feather";
import useAdminFetch from "../hooks/useAdminFetch";
import Panel from "./ui/Panel";
import StatCard from "./ui/StatCard";

interface WeeklyCell {
  responseId: string;
  recordedAt: string | null;
  mood: number | null;
  stress: number | null;
  helpfulness: number | null;
  usage: string | null;
}

interface ScoredResponse {
  responseId: string;
  recordedAt: string | null;
  phq2: number | null;
  gad2: number | null;
  phq2Positive: boolean | null;
  gad2Positive: boolean | null;
}

interface ParticipantRow {
  userId: number;
  username: string;
  enrolledAt: string;
  studyWeek: number;
  weekly: Partial<Record<number, WeeklyCell>>;
  weeklyOutOfWindow: number;
  baseline: ScoredResponse | null;
  exit: ScoredResponse | null;
  week12: ScoredResponse | null;
}

interface Overview {
  funnel: { baselineFinished: number; accountsCreated: number; unlinkedFinished: number };
  participants: ParticipantRow[];
  weeklyAggregates: Array<{
    week: number;
    n: number;
    avgMood: number | null;
    avgStress: number | null;
    avgHelpfulness: number | null;
  }>;
  instrumentAggregates: Array<{
    role: "baseline" | "exit" | "week12";
    n: number;
    avgPhq2: number | null;
    avgGad2: number | null;
    phq2Positive: number;
    gad2Positive: number;
  }>;
}

const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8];
const ROLE_LABELS = { baseline: "Baseline", exit: "Exit (Week 8)", week12: "Week 12" } as const;

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "";
}

function scoreText(s: ScoredResponse | null): string {
  if (!s) return "-";
  const phq = s.phq2 === null ? "?" : String(s.phq2);
  const gad = s.gad2 === null ? "?" : String(s.gad2);
  return `${phq} / ${gad}`;
}

/** Completion-matrix cell for one weekly slot: done, missed (window past),
 *  open (current week), or upcoming. */
function weekCell(p: ParticipantRow, week: number) {
  const cell = p.weekly[week];
  if (cell) {
    return (
      <span title={`${shortDate(cell.recordedAt)} - mood ${cell.mood ?? "?"}, stress ${cell.stress ?? "?"}`}>
        <Check size={16} className="text-green-600 inline" aria-label={`Week ${week} completed`} />
      </span>
    );
  }
  if (week < p.studyWeek || p.studyWeek > 8) {
    return <span className="text-red-500 font-semibold" title={`Week ${week} missed`}>x</span>;
  }
  if (week === p.studyWeek) {
    return <span className="text-amber-600 font-semibold" title={`Week ${week} in progress`}>due</span>;
  }
  return <Minus size={14} className="text-gray-300 inline" aria-label={`Week ${week} upcoming`} />;
}

function endpointCell(scored: ScoredResponse | null, reached: boolean) {
  if (scored) {
    return (
      <span title={`${shortDate(scored.recordedAt)} - PHQ-2 ${scored.phq2 ?? "?"}, GAD-2 ${scored.gad2 ?? "?"}`}>
        <Check size={16} className="text-green-600 inline" />
      </span>
    );
  }
  if (reached) return <span className="text-amber-600 font-semibold">due</span>;
  return <Minus size={14} className="text-gray-300 inline" />;
}

export default function SurveyData() {
  const { data, loading, error } = useAdminFetch<Overview>("/admin/api/qualtrics/data");
  const [expanded, setExpanded] = useState<number | null>(null);

  if (loading) return <p className="text-gray-500">Loading survey data...</p>;
  if (error) {
    const notConfigured = error.includes("503");
    return (
      <Panel title="Survey Data" icon={Clipboard}>
        <p className={notConfigured ? "text-gray-600" : "text-red-600"}>
          {notConfigured
            ? "The Qualtrics integration is not configured on this deployment; survey data will appear once it is."
            : `Failed to load survey data: ${error}`}
        </p>
      </Panel>
    );
  }
  if (!data) return null;

  const { participants, weeklyAggregates, instrumentAggregates } = data;
  const expectedWeekly = participants.reduce(
    (n, p) => n + Math.min(Math.max(p.studyWeek - 1, 0), 8),
    0
  );
  const completedWeekly = participants.reduce((n, p) => n + Object.keys(p.weekly).length, 0);
  const completionPct = expectedWeekly > 0 ? Math.round((completedWeekly / expectedWeekly) * 100) : null;
  const screenPositives = participants.filter(
    (p) => p.baseline?.phq2Positive || p.baseline?.gad2Positive
  ).length;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-navy">Survey Data</h2>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          label="Enrolled via survey"
          value={participants.length}
          sub={`${data.funnel.baselineFinished} finished baseline, ${data.funnel.accountsCreated} accounts`}
          icon={Users}
        />
        <StatCard
          label="Weekly completion"
          value={completionPct === null ? "-" : `${completionPct}%`}
          sub={`${completedWeekly} of ${expectedWeekly} elapsed weeks`}
          icon={TrendingUp}
        />
        <StatCard
          label="Exit surveys in"
          value={participants.filter((p) => p.exit).length}
          sub={`of ${participants.filter((p) => p.studyWeek > 8).length} eligible`}
          icon={Clipboard}
        />
        <StatCard
          label="Baseline screen positive"
          value={screenPositives}
          sub="PHQ-2 or GAD-2 at cutoff"
          icon={AlertTriangle}
        />
      </div>

      <Panel title="Completion matrix" icon={Clipboard}>
        {participants.length === 0 ? (
          <p className="text-gray-500 text-sm">No participants enrolled through the baseline survey yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 border-b">
                  <th className="py-2 pr-4">Participant</th>
                  <th className="py-2 pr-4">Enrolled</th>
                  <th className="py-2 pr-3">Wk</th>
                  {WEEKS.map((w) => (
                    <th key={w} className="py-2 px-2 text-center">W{w}</th>
                  ))}
                  <th className="py-2 px-2 text-center">Exit</th>
                  <th className="py-2 px-2 text-center">W12</th>
                  <th className="py-2 pl-3 text-right">PHQ/GAD base</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((p) => (
                  <>
                    <tr
                      key={p.userId}
                      className="border-b last:border-0 hover:bg-gray-50 cursor-pointer"
                      onClick={() => setExpanded(expanded === p.userId ? null : p.userId)}
                    >
                      <td className="py-2 pr-4 font-medium">{p.username}</td>
                      <td className="py-2 pr-4 text-gray-600">{shortDate(p.enrolledAt)}</td>
                      <td className="py-2 pr-3 text-gray-600">{Math.min(p.studyWeek, 12)}</td>
                      {WEEKS.map((w) => (
                        <td key={w} className="py-2 px-2 text-center">{weekCell(p, w)}</td>
                      ))}
                      <td className="py-2 px-2 text-center">{endpointCell(p.exit, p.studyWeek > 8)}</td>
                      <td className="py-2 px-2 text-center">{endpointCell(p.week12, p.studyWeek > 12)}</td>
                      <td className="py-2 pl-3 text-right font-mono text-xs">{scoreText(p.baseline)}</td>
                    </tr>
                    {expanded === p.userId && (
                      <tr key={`${p.userId}-detail`} className="bg-gray-50 border-b">
                        <td colSpan={14} className="py-3 px-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="font-semibold text-gray-700 mb-1">Weekly check-ins</p>
                              {Object.keys(p.weekly).length === 0 ? (
                                <p className="text-gray-500">None yet.</p>
                              ) : (
                                <table className="text-xs">
                                  <thead>
                                    <tr className="text-left text-gray-500">
                                      <th className="pr-3">Week</th>
                                      <th className="pr-3">Date</th>
                                      <th className="pr-3">Mood</th>
                                      <th className="pr-3">Stress</th>
                                      <th className="pr-3">Helpfulness</th>
                                      <th>Sessions</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {WEEKS.filter((w) => p.weekly[w]).map((w) => {
                                      const c = p.weekly[w]!;
                                      return (
                                        <tr key={w}>
                                          <td className="pr-3">W{w}</td>
                                          <td className="pr-3">{shortDate(c.recordedAt)}</td>
                                          <td className="pr-3">{c.mood ?? "-"}</td>
                                          <td className="pr-3">{c.stress ?? "-"}</td>
                                          <td className="pr-3">{c.helpfulness ?? "-"}</td>
                                          <td>{c.usage ?? "-"}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                              {p.weeklyOutOfWindow > 0 && (
                                <p className="text-amber-700 text-xs mt-1">
                                  {p.weeklyOutOfWindow} response(s) outside week windows
                                </p>
                              )}
                            </div>
                            <div>
                              <p className="font-semibold text-gray-700 mb-1">Instruments (PHQ-2 / GAD-2)</p>
                              <table className="text-xs">
                                <tbody>
                                  {(["baseline", "exit", "week12"] as const).map((role) => (
                                    <tr key={role}>
                                      <td className="pr-3 text-gray-500">{ROLE_LABELS[role]}</td>
                                      <td className="pr-3 font-mono">{scoreText(p[role])}</td>
                                      <td className="text-gray-500">{shortDate(p[role]?.recordedAt ?? null)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Weekly trends" icon={TrendingUp}>
          {weeklyAggregates.length === 0 ? (
            <p className="text-gray-500 text-sm">No weekly check-ins yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 border-b">
                  <th className="py-2 pr-4">Week</th>
                  <th className="py-2 pr-4">n</th>
                  <th className="py-2 pr-4">Avg mood (1-6)</th>
                  <th className="py-2 pr-4">Avg stress (1-5)</th>
                  <th className="py-2">Avg helpfulness (1-5)</th>
                </tr>
              </thead>
              <tbody>
                {weeklyAggregates.map((w) => (
                  <tr key={w.week} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium">W{w.week}</td>
                    <td className="py-2 pr-4">{w.n}</td>
                    <td className="py-2 pr-4">{w.avgMood ?? "-"}</td>
                    <td className="py-2 pr-4">{w.avgStress ?? "-"}</td>
                    <td className="py-2">{w.avgHelpfulness ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Instrument aggregates" icon={Clipboard}>
          {instrumentAggregates.length === 0 ? (
            <p className="text-gray-500 text-sm">No scored instrument responses yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 border-b">
                  <th className="py-2 pr-4">Survey</th>
                  <th className="py-2 pr-4">n</th>
                  <th className="py-2 pr-4">Avg PHQ-2</th>
                  <th className="py-2 pr-4">Avg GAD-2</th>
                  <th className="py-2">Screen positive</th>
                </tr>
              </thead>
              <tbody>
                {instrumentAggregates.map((a) => (
                  <tr key={a.role} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium">{ROLE_LABELS[a.role]}</td>
                    <td className="py-2 pr-4">{a.n}</td>
                    <td className="py-2 pr-4">{a.avgPhq2 ?? "-"}</td>
                    <td className="py-2 pr-4">{a.avgGad2 ?? "-"}</td>
                    <td className="py-2">
                      {a.phq2Positive} PHQ / {a.gad2Positive} GAD
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
