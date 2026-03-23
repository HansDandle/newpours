"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/shared/AuthProvider";
import { db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import type { PlanStatus, UserPlan } from "@/types";

export default function ExportsPage() {
  const { user } = useAuth();
  const [plan, setPlan] = useState<UserPlan>("free");
  const [planStatus, setPlanStatus] = useState<PlanStatus>("canceled");
  const [isAdmin, setIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  const mockExports = [
    { id: 'exp_001', createdAt: '2026-03-21', recordCount: 48, status: 'Ready' },
    { id: 'exp_002', createdAt: '2026-03-20', recordCount: 102, status: 'Ready' },
  ];

  useEffect(() => {
    const loadPlan = async () => {
      if (!user) {
        setPlan("free");
        setPlanStatus("canceled");
        setIsAdmin(false);
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data() as { plan?: UserPlan; planStatus?: PlanStatus } | undefined;
        setPlan(data?.plan ?? "free");
        setPlanStatus(data?.planStatus ?? "canceled");

        const tokenResult = await user.getIdTokenResult(false);
        setIsAdmin(tokenResult.claims.role === "admin");
      } catch {
        setPlan("free");
        setPlanStatus("canceled");
        setIsAdmin(false);
      }
    };

    loadPlan();
  }, [user]);

  const hasProExports = (plan === "pro" || plan === "enterprise") && planStatus === "active";
  const hasExportAccess = hasProExports || isAdmin;

  const createExport = async () => {
    if (!user || !hasExportAccess || creating) return;

    setCreating(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/exports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({}),
      });

      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "licenses-export.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-[#1a2233]">CSV Exports</h1>
        <button
          onClick={createExport}
          disabled={!hasExportAccess || creating}
          title={hasExportAccess ? "Generate and download a fresh CSV export" : "CSV exports are available on Pro and Enterprise plans."}
          className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {hasExportAccess ? (creating ? "Creating..." : "New Export") : "New Export (Pro+)"}
        </button>
      </div>
      {!hasExportAccess && (
        <div className="mb-4 text-sm text-gray-500">
          Upgrade to Pro or Enterprise to generate and download CSV exports. <a href="/pricing" className="text-amber-600 hover:underline">See plans</a>
        </div>
      )}
      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th className="px-6 py-3 text-left">Export ID</th>
              <th className="px-6 py-3 text-left">Date</th>
              <th className="px-6 py-3 text-left">Records</th>
              <th className="px-6 py-3 text-left">Status</th>
              <th className="px-6 py-3 text-left">Download</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {mockExports.map((exp) => (
              <tr key={exp.id} className="hover:bg-gray-50 transition">
                <td className="px-6 py-4 font-mono text-xs text-gray-500">{exp.id}</td>
                <td className="px-6 py-4">{exp.createdAt}</td>
                <td className="px-6 py-4">{exp.recordCount}</td>
                <td className="px-6 py-4"><span className="text-green-600 font-medium">{exp.status}</span></td>
                <td className="px-6 py-4">
                  {hasExportAccess ? (
                    <a href="#" className="text-amber-600 hover:underline">Download</a>
                  ) : (
                    <span className="text-gray-400">Locked (Pro+)</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
