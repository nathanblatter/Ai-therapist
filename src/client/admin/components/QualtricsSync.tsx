// Qualtrics Sync panel (ai-therapist-149): researcher-facing surface for the
// survey-response sync — scheduler + last-run state, per-survey linkage
// health, the finished-but-unlinked responses that need attention, and a
// manual "Sync now" button. Data: GET /admin/api/qualtrics/status (503 when
// the integration env is unset — rendered as a friendly notice, not an
// error); action: POST /admin/api/qualtrics/sync.
import { useState } from "react";
import { RefreshCw, Clock, Link as LinkIcon, AlertTriangle, Repeat } from "react-feather";
import useAdminFetch from "../hooks/useAdminFetch";
import Panel from "./ui/Panel";
import StatCard from "./ui/StatCard";
import { toast } from "../../shared/components/Toast";

interface SurveySyncResult {
  surveyRole: string;
  surveyId: string;
  fetched: number;
  upserted: number;
  linked: number;
  error?: string;
}

interface QualtricsStatus {
  configured: boolean;
  surveys: Record<string, string>;
  sync: {
    lastRunAt: string | null;
    lastRunTrigger: "manual" | "scheduled" | null;
    lastResults: SurveySyncResult[] | null;
    lastError: string | null;
    schedulerActive: boolean;
    intervalMinutes: number | null;
  };
  linkage: Array<{
    surveyRole: string;
    total: number;
    finished: number;
    linked: number;
    unlinkedFinished: number;
    lastRecordedAt: string | null;
  }>;
  unlinked: Array<{
    responseId: string;
    surveyRole: string;
    studySid: string | null;
    recordedAt: string | null;
  }>;
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

export default function QualtricsSync() {
  const { data, loading, error, refetch } = useAdminFetch<QualtricsStatus>(
    "/admin/api/qualtrics/status"
  );
  const [syncing, setSyncing] = useState(false);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/admin/api/qualtrics/sync", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { success?: boolean; results?: SurveySyncResult[]; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error || `Sync failed (HTTP ${res.status})`);
      const fetched = (body?.results ?? []).reduce((n, r) => n + r.fetched, 0);
      const linked = (body?.results ?? []).reduce((n, r) => n + r.linked, 0);
      toast.success(`Sync complete: ${fetched} response(s) fetched, ${linked} linked.`);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <p className="text-gray-500">Loading Qualtrics status...</p>;

  // The status route 503s when QUALTRICS_API_TOKEN / survey ids are unset —
  // that's an expected pre-launch state, not a failure.
  if (error) {
    return (
      <Panel title="Qualtrics Sync" icon={RefreshCw}>
        <p className="text-gray-600">
          The Qualtrics integration is not configured on this deployment
          (QUALTRICS_API_TOKEN + survey ids). Survey responses will sync here
          once BYU enables API access and the token is set.
        </p>
        <p className="text-xs text-gray-500 mt-2">({error})</p>
      </Panel>
    );
  }
  if (!data) return null;

  const { sync } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-navy">Qualtrics Sync</h2>
        <button
          onClick={runSync}
          disabled={syncing}
          className="bg-royal hover:bg-blue-800 disabled:opacity-60 text-white px-4 py-2 rounded-lg flex items-center gap-2"
        >
          <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing..." : "Sync now"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          label="Scheduler"
          value={sync.schedulerActive ? "On" : "Off"}
          sub={sync.schedulerActive ? `every ${sync.intervalMinutes} min` : "manual sync only"}
          icon={Repeat}
        />
        <StatCard
          label="Last run"
          value={sync.lastRunAt ? fmtTime(sync.lastRunAt) : "never"}
          sub={sync.lastRunTrigger ? `trigger: ${sync.lastRunTrigger}` : undefined}
          icon={Clock}
        />
        <StatCard
          label="Surveys configured"
          value={Object.keys(data.surveys).length}
          sub={Object.keys(data.surveys).join(", ")}
          icon={LinkIcon}
        />
        <StatCard
          label="Unlinked (finished)"
          value={data.unlinked.length}
          sub="responses with no participant"
          icon={AlertTriangle}
        />
      </div>

      {sync.lastError && (
        <Panel>
          <p className="text-red-600 text-sm">Last run error: {sync.lastError}</p>
        </Panel>
      )}

      <Panel title="Linkage health" icon={LinkIcon}>
        {data.linkage.length === 0 ? (
          <p className="text-gray-500 text-sm">No responses synced yet.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Survey</th>
                <th className="py-2 pr-4">Total</th>
                <th className="py-2 pr-4">Finished</th>
                <th className="py-2 pr-4">Linked</th>
                <th className="py-2 pr-4">Unlinked finished</th>
                <th className="py-2">Latest response</th>
              </tr>
            </thead>
            <tbody>
              {data.linkage.map((row) => (
                <tr key={row.surveyRole} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">{row.surveyRole}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.finished}</td>
                  <td className="py-2 pr-4">{row.linked}</td>
                  <td className={`py-2 pr-4 ${row.unlinkedFinished > 0 ? "text-amber-700 font-semibold" : ""}`}>
                    {row.unlinkedFinished}
                  </td>
                  <td className="py-2 text-gray-600">{fmtTime(row.lastRecordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {sync.lastResults && sync.lastResults.length > 0 && (
        <Panel title="Last run results" icon={Clock}>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Survey</th>
                <th className="py-2 pr-4">Fetched</th>
                <th className="py-2 pr-4">Upserted</th>
                <th className="py-2 pr-4">Linked</th>
                <th className="py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {sync.lastResults.map((r) => (
                <tr key={r.surveyId} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">{r.surveyRole}</td>
                  <td className="py-2 pr-4">{r.fetched}</td>
                  <td className="py-2 pr-4">{r.upserted}</td>
                  <td className="py-2 pr-4">{r.linked}</td>
                  <td className="py-2 text-red-600">{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Unlinked finished responses" icon={AlertTriangle}>
        {data.unlinked.length === 0 ? (
          <p className="text-gray-500 text-sm">
            Every finished response is linked to a participant.
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">
              These finished responses could not be resolved to a participant
              account (bad or missing study ID). They are unusable for analysis
              until linked — check the typed ID against the participant roster.
            </p>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 border-b">
                  <th className="py-2 pr-4">Response ID</th>
                  <th className="py-2 pr-4">Survey</th>
                  <th className="py-2 pr-4">Typed/embedded ID</th>
                  <th className="py-2">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {data.unlinked.map((r) => (
                  <tr key={r.responseId} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{r.responseId}</td>
                    <td className="py-2 pr-4">{r.surveyRole}</td>
                    <td className="py-2 pr-4">{r.studySid ?? "(none)"}</td>
                    <td className="py-2 text-gray-600">{fmtTime(r.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>
    </div>
  );
}
