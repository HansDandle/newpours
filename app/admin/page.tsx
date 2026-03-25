"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { collection, getDocs, doc, getDoc, getCountFromServer, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { JobRun, BackfillStatus } from "@/types";

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

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

function timeAgo(ts: any): string {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function fmtDuration(ms?: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

const PLAN_PRICES: Record<string, number> = { free: 0, basic: 29, pro: 79, enterprise: 299 };

function ApiExplorer() {
  const [endpoint, setEndpoint] = useState("https://data.texas.gov/resource/7hf9-qc9f.json?$limit=100&$where=county='Travis' AND original_issue_date >= '2026-03-01'");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(endpoint)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const body = isJson ? await res.json() : await res.text();
      setData(body);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-12">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">TABC API Explorer</h2>
      <div className="flex gap-2 mb-2">
        <input
          ref={inputRef}
          type="text"
          className="flex-1 border rounded-lg px-3 py-2 text-sm bg-white text-black"
          value={endpoint}
          onChange={e => setEndpoint(e.target.value)}
          placeholder="Paste TABC API endpoint URL here..."
        />
        <button
          className="bg-[var(--brand-accent)] text-white px-4 py-2 rounded-lg font-semibold text-sm"
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? "Loading..." : "Fetch"}
        </button>
      </div>
      {error && <div className="text-red-500 text-xs mb-2">{error}</div>}
      <div className="bg-gray-900 rounded-lg p-4 overflow-x-auto max-h-96 text-xs text-gray-100 border border-gray-800">
        {data ? (
          <pre className="whitespace-pre-wrap break-all">{typeof data === "string" ? data : JSON.stringify(data, null, 2)}</pre>
        ) : (
          <span className="text-gray-500">No data loaded yet.</span>
        )}
      </div>
    </div>
  );
}

export default function AdminOverviewPage() {
  const [stats, setStats] = useState({
    totalEstablishments: 0,
    totalLicenses: 0,
    unmatchedComptroller: 0,
    activeSubscribers: 0,
    mrr: 0,
  });
  const [detailStats, setDetailStats] = useState<{ enrichmentComplete: number; duplicateFlags: number } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [backfill, setBackfill] = useState<BackfillStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDetailStats = useCallback(async () => {
    setDetailLoading(true);
    try {
      const estSnap = await getDocs(collection(db, "establishments"));
      let enriched = 0;
      let duplicates = 0;
      for (const d of estSnap.docs) {
        const data = d.data();
        const e = data.enrichment ?? {};
        const allDone = ["googlePlaces", "comptroller", "healthInspection", "buildingPermits"].every(
          (k) => e[k] === "complete" || e[k] === "no_match" || e[k] === "unavailable"
        );
        if (allDone) enriched++;
        if (data.duplicateFlag) duplicates++;
      }
      setDetailStats({ enrichmentComplete: estSnap.size > 0 ? Math.round((enriched / estSnap.size) * 100) : 0, duplicateFlags: duplicates });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      // Establishments & licenses — count only, no full scan
      const [estCount, licCount, unmatchedCount] = await Promise.all([
        getCountFromServer(collection(db, "establishments")),
        getCountFromServer(collection(db, "licenses")),
        getCountFromServer(query(collection(db, "comptroller_unmatched"), where("dismissed", "!=", true))),
      ]);

      // Users & MRR
      const usersSnap = await getDocs(collection(db, "users"));
      let activeSubs = 0;
      let mrr = 0;
      for (const d of usersSnap.docs) {
        const u = d.data();
        if (u.planStatus === "active") {
          activeSubs++;
          mrr += PLAN_PRICES[u.plan] ?? 0;
        }
      }

      // Job runs
      const runsSnap = await getDocs(collection(db, "system/jobRuns/items"));
      const runs: JobRun[] = runsSnap.docs
        .map((d) => ({ id: d.id, ...d.data() } as JobRun))
        .sort((a, b) => (b.startedAt?.toMillis?.() ?? 0) - (a.startedAt?.toMillis?.() ?? 0))
        .slice(0, 10);

      // Backfill status
      const backfillDoc = await getDoc(doc(db, "system", "backfill"));
      const bf = backfillDoc.exists() ? (backfillDoc.data() as BackfillStatus) : null;

      const total = estCount.data().count;
      setStats({
        totalEstablishments: total,
        totalLicenses: licCount.data().count,
        unmatchedComptroller: unmatchedCount.data().count,
        activeSubscribers: activeSubs,
        mrr,
      });
      setJobRuns(runs);
      setBackfill(bf);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Removed auto-refresh interval for admin page stability
    // const interval = setInterval(load, 300000);
    // return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">System Overview</h1>
        <span className="text-xs text-gray-500">Auto-refreshes every 5 min</span>
      </div>

      {/* Backfill banner */}
      {backfill && (!backfill.tabc_complete || !backfill.comptroller_complete) && (
        <div className="mb-6 bg-yellow-900/40 border border-yellow-700 rounded-lg p-4 text-sm text-yellow-200">
          ⚠️ <strong>Backfill incomplete.</strong>{" "}
          {!backfill.tabc_complete && "TABC full ingest not yet run. "}
          {!backfill.comptroller_complete && "Comptroller backfill not yet run. "}
          Run <code className="font-mono text-xs bg-yellow-900/60 px-1 rounded">npx ts-node scripts/backfill.ts</code> to start.
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading stats…</p>
      ) : (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4 mb-4">
            <StatCard label="Establishments" value={stats.totalEstablishments.toLocaleString()} />
            <StatCard label="Licenses" value={stats.totalLicenses.toLocaleString()} />
            <StatCard label="Unmatched Comptroller" value={stats.unmatchedComptroller.toLocaleString()} sub="undismissed" />
            <StatCard label="Active Subscribers" value={stats.activeSubscribers} />
            <StatCard label="MRR" value={`$${stats.mrr.toLocaleString()}`} sub="estimated" />
          </div>
          <div className="flex items-center gap-4 mb-8">
            {detailStats ? (
              <div className="grid grid-cols-2 gap-4 flex-1">
                <StatCard label="Enrichment" value={`${detailStats.enrichmentComplete}%`} sub="of establishments complete" />
                <StatCard label="Duplicate Flags" value={detailStats.duplicateFlags} />
              </div>
            ) : (
              <button
                onClick={loadDetailStats}
                disabled={detailLoading}
                className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-3 py-2 transition-colors"
              >
                {detailLoading ? "Computing…" : "Load enrichment & duplicate stats (slow)"}
              </button>
            )}
          </div>

          {/* Job runs table */}
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Recent Job Runs
          </h2>
          {jobRuns.length === 0 ? (
            <p className="text-gray-600 text-sm">No job runs recorded yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    {["Job", "Started", "Status", "Records", "Failed", "Duration"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {jobRuns.map((run) => (
                    <tr key={run.id} className="hover:bg-gray-800/50">
                      <td className="px-4 py-3 text-gray-200 font-mono text-xs">{run.jobName}</td>
                      <td className="px-4 py-3 text-gray-400">{timeAgo(run.startedAt)}</td>
                      <td className="px-4 py-3">{statusBadge(run.status)}</td>
                      <td className="px-4 py-3 text-gray-300">{run.recordsProcessed?.toLocaleString()}</td>
                      <td className="px-4 py-3 text-gray-400">{run.recordsFailed ?? 0}</td>
                      <td className="px-4 py-3 text-gray-400">{fmtDuration(run.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <ApiExplorer />
    </div>
  );
}
