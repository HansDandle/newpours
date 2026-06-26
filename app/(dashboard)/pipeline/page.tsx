"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import { CRM_STAGES, setStage } from "@/lib/crm";
import LeadDetail from "@/components/leads/LeadDetail";
import UpgradeGate from "@/components/shared/UpgradeGate";
import type { Lead, CrmStage } from "@/types";

type LeadRow = Lead & { id: string };

export default function PipelinePage() {
  const { user, isAdmin, userPlan, userPlanStatus } = useAuth();
  const fullAccess = isAdmin || ((userPlan === "pro" || userPlan === "enterprise") && userPlanStatus === "active");
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!fullAccess) { setLoading(false); return; }
    getDocs(collection(db, "leads"))
      .then((snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LeadRow))))
      .finally(() => setLoading(false));
  }, [fullAccess]);

  const byStage = useMemo(() => {
    const map: Record<string, LeadRow[]> = {};
    for (const s of CRM_STAGES) map[s.key] = [];
    for (const r of rows) {
      const stage = (r.crm?.stage ?? "new") as CrmStage;
      (map[stage] ?? map.new).push(r);
    }
    return map;
  }, [rows]);

  const move = async (leadId: string, toStage: CrmStage) => {
    if (!isAdmin) return;
    const lead = rows.find((r) => r.id === leadId);
    if (!lead || (lead.crm?.stage ?? "new") === toStage) return;
    const fromStage = lead.crm?.stage;
    // optimistic
    setRows((prev) => prev.map((r) => (r.id === leadId ? { ...r, crm: { ...(r.crm ?? { stage: "new" }), stage: toStage } } : r)));
    try {
      await setStage(leadId, toStage, fromStage, user?.uid);
    } catch {
      // revert on failure
      setRows((prev) => prev.map((r) => (r.id === leadId ? { ...r, crm: { ...(r.crm ?? { stage: "new" }), stage: fromStage ?? "new" } } : r)));
    }
  };

  const openLead = rows.find((r) => r.id === openId) ?? null;

  if (!fullAccess) return <UpgradeGate feature="Pipeline (CRM)" />;

  return (
    <section className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] accent">Pipeline</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">Work your leads to close.</h1>
        {!isAdmin && <p className="mt-1 text-sm text-slate-500">Read-only — sign in as an admin to move cards.</p>}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading pipeline…</p>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {CRM_STAGES.map((s) => (
            <div
              key={s.key}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={() => { if (dragId) { move(dragId, s.key); setDragId(null); } }}
              className="flex w-72 shrink-0 flex-col rounded-2xl border border-slate-200 bg-slate-50"
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                <span className="text-sm font-semibold text-slate-700">{s.label}</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{byStage[s.key]?.length ?? 0}</span>
              </div>
              <div className="flex flex-col gap-2 p-2 min-h-[120px]">
                {(byStage[s.key] ?? []).slice(0, 100).map((r) => (
                  <div
                    key={r.id}
                    draggable={isAdmin}
                    onDragStart={() => setDragId(r.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setOpenId(r.id)}
                    className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm hover:border-[var(--brand-accent)]"
                  >
                    <p className="text-sm font-semibold text-slate-900">{r.businessName}</p>
                    <p className="text-xs text-slate-500">{[r.city, r.county].filter(Boolean).join(", ") || r.address}</p>
                    {r.crm?.followUpDate && <p className="mt-1 text-[11px] font-semibold text-[var(--brand-accent)]">Follow up {r.crm.followUpDate}</p>}
                    {r.phones?.[0] && <p className="mt-1 text-xs text-slate-600">{r.phones[0]}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {openLead && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpenId(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpenId(null)} className="mb-4 text-sm text-slate-400 hover:text-slate-700">✕ Close</button>
            <LeadDetail lead={openLead} uid={user?.uid} isAdmin={isAdmin} />
          </div>
        </div>
      )}
    </section>
  );
}
