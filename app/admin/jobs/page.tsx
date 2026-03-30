"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, query, orderBy, limit, updateDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { JobRun } from "@/types";
import { useAuth } from "@/components/shared/AuthProvider";

const JOBS = [
  { key: "tabc_ingest", label: "TABC Ingest" },
  { key: "dedup_pending", label: "Clean Up Stale Pending" },
  { key: "comptroller_update", label: "Comptroller Update" },
  { key: "google_places_refresh", label: "Google Places Refresh" },
  { key: "health_inspections", label: "Health Inspections" },
  { key: "building_permits", label: "Building Permits" },
  { key: "property_data", label: "TCAD Property Data" },
];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    success: "bg-green-900 text-green-300",
    partial: "bg-yellow-900 text-yellow-300",
    error: "bg-red-900 text-red-300",
    running: "bg-blue-900 text-blue-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? "bg-gray-700 text-gray-300"}`}>
      {status}
    </span>
  );
}

function fmtTs(ts: any) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms?: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

interface TriggerDoc {
  id: string;
  jobName: string;
  status: string;
  requestedAt: any;
}

export default function AdminJobsPage() {
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [confirmJob, setConfirmJob] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<JobRun | null>(null);
  const [county, setCounty] = useState<string>("");
  const [lookbackMonths, setLookbackMonths] = useState<number>(24);
  const [revenueMonth, setRevenueMonth] = useState<string>("");
  const [minRevenue, setMinRevenue] = useState<string>("");
  const [onlyMissingGoogle, setOnlyMissingGoogle] = useState(true);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<TriggerDoc[]>([]);
  const [clearingStuck, setClearingStuck] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    getDocs(collection(db, "system/jobRuns/items"))
      .then((snap) =>
        setRuns(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as JobRun))
            .sort((a, b) => (b.startedAt?.toMillis?.() ?? 0) - (a.startedAt?.toMillis?.() ?? 0))
        )
      )
      .finally(() => setLoading(false));
    getDocs(query(collection(db, "system/adminTriggers/items"), orderBy("requestedAt", "desc"), limit(20)))
      .then((snap) => setTriggers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TriggerDoc))));
  }, []);

  async function clearStuckTriggers() {
    setClearingStuck(true);
    try {
      const stuck = triggers.filter((t) => t.status === "queued" || t.status === "running");
      await Promise.all(
        stuck.map((t) => updateDoc(doc(db, "system/adminTriggers/items", t.id), { status: "error" }))
      );
      setTriggers((prev) =>
        prev.map((t) => (t.status === "queued" || t.status === "running" ? { ...t, status: "error" } : t))
      );
      setToast(`Cleared ${stuck.length} stuck trigger(s).`);
    } catch {
      setToast("Failed to clear stuck triggers.");
    } finally {
      setClearingStuck(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function triggerJob(jobKey: string) {
    setTriggering(jobKey);
    setConfirmJob(null);
    try {
      const token = await user?.getIdToken?.();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      headers["Content-Type"] = "application/json";

      const res = await fetch(`/api/admin/trigger/${jobKey}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          county: county.trim() || null,
          lookbackMonths,
          revenueMonth: jobKey === "google_places_refresh" ? revenueMonth.trim() || null : null,
          minRevenue: jobKey === "google_places_refresh" && minRevenue.trim() ? Number(minRevenue) : null,
          onlyMissingGoogle: jobKey === "google_places_refresh" ? onlyMissingGoogle : false,
        }),
      });
      const json = await res.json();
      if (json.queued) {
        setToast(`${jobKey} queued. Job ID: ${json.jobId}`);
      } else {
        setToast(`Error: ${json.error ?? "unknown"}`);
      }
    } catch {
      setToast("Request failed.");
    } finally {
      setTriggering(null);
      setTimeout(() => setToast(null), 5000);
    }
  }

  async function previewJob(jobKey: string) {
    setPreviewing(jobKey);
    try {
      const token = await user?.getIdToken?.();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      headers["Content-Type"] = "application/json";

      const res = await fetch(`/api/admin/trigger/${jobKey}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          county: county.trim() || null,
          lookbackMonths,
          revenueMonth: jobKey === "google_places_refresh" ? revenueMonth.trim() || null : null,
          minRevenue: jobKey === "google_places_refresh" && minRevenue.trim() ? Number(minRevenue) : null,
          onlyMissingGoogle: jobKey === "google_places_refresh" ? onlyMissingGoogle : false,
          preview: true,
        }),
      });
      const json = await res.json();
      if (res.ok && json.preview) {
        const msg = [
          `${jobKey} preview`,
          `records=${json.estimatedRecords ?? 0}`,
          `reads=${json.estimatedFirestoreReads ?? 0}`,
          `writes=${json.estimatedFirestoreWrites ?? 0}`,
          `externalCalls=${json.estimatedExternalCalls ?? 0}`,
        ].join(" | ");
        const notes = Array.isArray(json.notes) && json.notes.length ? ` | ${json.notes[0]}` : "";
        setToast(msg + notes);
      } else {
        setToast(`Preview error: ${json.error ?? "unknown"}`);
      }
    } catch {
      setToast("Preview request failed.");
    } finally {
      setPreviewing(null);
      setTimeout(() => setToast(null), 8000);
    }
  }

  return (
    <div className="p-8 max-w-6xl">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      <h1 className="text-xl font-semibold text-white mb-6">Job Monitor</h1>

      {/* Manual trigger buttons */}
      <div className="mb-8">
        <h2 className="text-xs text-gray-500 uppercase tracking-widest mb-3">Manual Triggers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <label className="text-xs text-gray-400">
            County filter (optional)
            <input
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              placeholder="e.g. Travis or Dallas"
              className="mt-1 w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-gray-400">
            Lookback months (1-24)
            <input
              type="number"
              min={1}
              max={24}
              value={lookbackMonths}
              onChange={(e) => setLookbackMonths(Math.min(24, Math.max(1, Number(e.target.value) || 24)))}
              className="mt-1 w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <label className="text-xs text-gray-400">
            Google revenue month (optional)
            <input
              value={revenueMonth}
              onChange={(e) => setRevenueMonth(e.target.value)}
              placeholder="YYYY-MM"
              className="mt-1 w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-gray-400">
            Google minimum revenue (optional)
            <input
              type="number"
              min={0}
              value={minRevenue}
              onChange={(e) => setMinRevenue(e.target.value)}
              placeholder="e.g. 50000"
              className="mt-1 w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-gray-400 flex items-end">
            <span className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 flex items-center gap-2">
              <input
                type="checkbox"
                checked={onlyMissingGoogle}
                onChange={(e) => setOnlyMissingGoogle(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800"
              />
              Only missing Google matches
            </span>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {JOBS.map((job) => (
            <button
              key={job.key}
              onClick={() => setConfirmJob(job.key)}
              disabled={triggering === job.key}
              className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded text-sm disabled:opacity-50"
            >
              {triggering === job.key ? "Queuing…" : `▶ ${job.label}`}
            </button>
          ))}
        </div>
      </div>

      {/* Trigger queue status */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-widest">Trigger Queue</h2>
          {triggers.some((t) => t.status === "queued" || t.status === "running") && (
            <button
              onClick={clearStuckTriggers}
              disabled={clearingStuck}
              className="text-xs px-3 py-1 bg-red-900 hover:bg-red-800 text-red-300 border border-red-800 rounded disabled:opacity-50"
            >
              {clearingStuck ? "Clearing…" : "Clear Stuck"}
            </button>
          )}
        </div>
        {triggers.length === 0 ? (
          <p className="text-xs text-gray-600">No recent trigger records.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
                <tr>
                  {["Job", "Status", "Requested"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {triggers.map((t) => (
                  <tr key={t.id} className={t.status === "queued" || t.status === "running" ? "bg-yellow-950/30" : ""}>
                    <td className="px-4 py-2 font-mono text-xs text-gray-300">{t.jobName}</td>
                    <td className="px-4 py-2">{statusBadge(t.status)}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{fmtTs(t.requestedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Job run history */}
      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                {["Job Name", "Started", "Completed", "Duration", "Status", "Records", "Failed", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{run.jobName}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtTs(run.startedAt)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtTs(run.completedAt)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtDuration(run.durationMs)}</td>
                  <td className="px-4 py-3">{statusBadge(run.status)}</td>
                  <td className="px-4 py-3 text-gray-300">{run.recordsProcessed?.toLocaleString()}</td>
                  <td className="px-4 py-3 text-gray-500">{run.recordsFailed ?? 0}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setDetailRun(run)}
                      className="text-xs text-gray-500 hover:text-gray-300 underline"
                    >
                      Log
                    </button>
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-600 text-sm">
                    No job runs recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirm trigger modal */}
      {confirmJob && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96">
            <h2 className="text-sm font-semibold text-white mb-2">Trigger job?</h2>
            <p className="text-sm text-gray-400 mb-5">
              This will queue <span className="text-white font-mono">{confirmJob}</span> for immediate execution.
            </p>
            <p className="text-xs text-gray-500 mb-5">
              Scope: {county.trim() ? `county=${county.trim()}, ` : "all counties, "}
              lookback={lookbackMonths} months
              {confirmJob === "google_places_refresh" && revenueMonth.trim() ? `, revenueMonth=${revenueMonth.trim()}` : ""}
              {confirmJob === "google_places_refresh" && minRevenue.trim() ? `, minRevenue=${minRevenue.trim()}` : ""}
              {confirmJob === "google_places_refresh" && onlyMissingGoogle ? ", onlyMissingGoogle=true" : ""}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmJob(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded">Cancel</button>
              <button
                onClick={() => previewJob(confirmJob)}
                disabled={previewing === confirmJob}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded disabled:opacity-50"
              >
                {previewing === confirmJob ? "Previewing…" : "Preview Impact"}
              </button>
              <button onClick={() => triggerJob(confirmJob)} className="btn-accent px-3 py-1.5 text-sm rounded">Run now</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {detailRun && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[560px] max-h-[80vh] overflow-y-auto">
            <h2 className="text-sm font-semibold text-white mb-3">Run log — {detailRun.jobName}</h2>
            <pre className="text-xs text-gray-400 bg-gray-950 p-3 rounded whitespace-pre-wrap">
              {detailRun.notes || "No notes recorded."}
            </pre>
            <div className="flex justify-end mt-4">
              <button onClick={() => setDetailRun(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
