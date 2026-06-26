"use client";
import { useEffect, useState } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "@/lib/firebase";
import type { Lead, LeadActivity, LeadContact, CrmStage } from "@/types";
import {
  CRM_STAGES,
  setStage,
  logActivity,
  setFollowUp,
  addContact,
  setOperator,
  clearOperatorLock,
} from "@/lib/crm";
import { loadOperators, type OperatorDef } from "@/lib/operators";

export const SIGNAL_LABELS: Record<string, string> = {
  opening_soon: "Opening soon",
  brand_new: "Brand new",
  build_out: "Build-out",
  event_upcoming: "Event",
  no_website: "No website",
  multi_unit_operator: "Multi-unit operator",
  high_value_buildout: "High-value build-out",
  multifamily: "New apartments",
  large_nonprofit: "Large nonprofit",
};

const SOURCE_LABELS: Record<string, string> = {
  tabc: "TABC license",
  tabc_event: "TABC event permit",
  tabs_permit: "Construction permit",
  event: "Event permit",
  building_permit: "Apartment building permit",
  nonprofit_990: "Nonprofit (IRS 990)",
};

function fmtDate(value: any) {
  if (!value) return "--";
  const d = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function Signal({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[rgba(200,169,108,0.3)] bg-[rgba(200,169,108,0.1)] px-2 py-0.5 text-[11px] font-semibold text-[var(--brand-accent)]">
      {label}
    </span>
  );
}

export default function LeadDetail({
  lead,
  uid,
  isAdmin,
  onOperatorClick,
}: {
  lead: Lead & { id: string };
  uid?: string;
  isAdmin: boolean;
  onOperatorClick?: (operatorName: string) => void;
}) {
  const [contacts, setContacts] = useState<LeadContact[]>([]);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [hsPushing, setHsPushing] = useState(false);
  const [hsPushResult, setHsPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncedNow, setSyncedNow] = useState(false);
  // True if the lead is in HubSpot — from the persisted deal id, or a push just now.
  const inHubSpot = syncedNow || Boolean((lead.enrichment as any)?.hubspot?.dealId);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContact, setNewContact] = useState<LeadContact>({ role: "manual" });
  const [operators, setOperators] = useState<OperatorDef[]>([]);

  useEffect(() => {
    if (isAdmin) loadOperators().then(setOperators).catch(() => {});
  }, [isAdmin]);

  const handleOperatorChange = async (value: string) => {
    if (value === "__auto__") {
      await clearOperatorLock(lead.id);
      lead.operatorLocked = false;
    } else if (value === "__none__") {
      await setOperator(lead.id, null);
      lead.operator = null;
      lead.operatorLocked = true;
    } else {
      const op = operators.find((o) => o.id === value);
      if (!op) return;
      const ref = { key: op.id!, name: op.name };
      await setOperator(lead.id, ref);
      lead.operator = ref;
      lead.operatorLocked = true;
    }
  };

  useEffect(() => {
    // Reset per-lead UI state so a previous lead's push result doesn't linger
    // when the shared detail panel switches to a different lead.
    setHsPushResult(null);
    setHsPushing(false);
    setSyncedNow(false);
    setApResult(null);
    setApBusy(false);
    let cancelled = false;
    (async () => {
      const [cSnap, aSnap] = await Promise.all([
        getDocs(collection(db, "leads", lead.id, "contacts")),
        getDocs(query(collection(db, "leads", lead.id, "activities"), orderBy("createdAt", "desc"))),
      ]);
      if (cancelled) return;
      setContacts(cSnap.docs.map((d) => ({ id: d.id, ...d.data() } as LeadContact)));
      setActivities(aSnap.docs.map((d) => ({ id: d.id, ...d.data() } as LeadActivity)));
    })();
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  const refreshActivities = async () => {
    const aSnap = await getDocs(query(collection(db, "leads", lead.id, "activities"), orderBy("createdAt", "desc")));
    setActivities(aSnap.docs.map((d) => ({ id: d.id, ...d.data() } as LeadActivity)));
  };

  const handleStage = async (stage: CrmStage) => {
    if (!isAdmin) return;
    setBusy(true);
    try {
      await setStage(lead.id, stage, lead.crm?.stage, uid);
      lead.crm = { ...(lead.crm ?? { stage: "new" }), stage };
      await refreshActivities();
    } finally {
      setBusy(false);
    }
  };

  const handleLog = async (type: "call" | "email" | "note" | "meeting") => {
    if (!isAdmin) return;
    setBusy(true);
    try {
      await logActivity(lead.id, type, note.trim(), uid);
      setNote("");
      await refreshActivities();
    } finally {
      setBusy(false);
    }
  };

  const handleAddContact = async () => {
    if (!isAdmin) return;
    setBusy(true);
    try {
      await addContact(lead.id, newContact);
      setContacts((prev) => [...prev, newContact]);
      setNewContact({ role: "manual" });
      setShowAddContact(false);
    } finally {
      setBusy(false);
    }
  };

  const [apBusy, setApBusy] = useState(false);
  const [apResult, setApResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleApolloEnrich = async () => {
    setApBusy(true);
    setApResult(null);
    try {
      const fn = httpsCallable(getFunctions(), "apolloEnrichLead");
      const res = await fn({ leadId: lead.id });
      const d = res.data as { matched?: boolean; name?: string; title?: string; email?: string };
      if (d.matched && d.email) setApResult({ ok: true, message: `${d.name}${d.title ? ` (${d.title})` : ""} — ${d.email}` });
      else if (d.matched) setApResult({ ok: true, message: `${d.name ?? "Match"} found, but no email available` });
      else setApResult({ ok: false, message: "No Apollo match" });
    } catch (err: any) {
      setApResult({ ok: false, message: err?.message ?? "Apollo lookup failed" });
    } finally {
      setApBusy(false);
    }
  };

  const handlePushToHubSpot = async () => {
    setHsPushing(true);
    setHsPushResult(null);
    try {
      const fn = httpsCallable(getFunctions(), "hubspotPushLead");
      const res = await fn({ leadId: lead.id });
      const data = res.data as { created?: boolean };
      setSyncedNow(true);
      setHsPushResult({ ok: true, message: data.created ? "Created in HubSpot" : "Updated in HubSpot" });
    } catch (err: any) {
      setHsPushResult({ ok: false, message: err?.message ?? "Push failed" });
    } finally {
      setHsPushing(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Lead</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-900">{lead.businessName}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {[lead.address, lead.city, lead.county, lead.zipCode].filter(Boolean).join(", ") || "No address"}
        </p>
        {lead.operator && (
          <button
            type="button"
            onClick={() => onOperatorClick?.(lead.operator!.name)}
            className="mt-2 inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
            title="Show all properties from this operator"
          >
            🏛 {lead.operator.name}
            <span className="text-indigo-400">· see portfolio</span>
          </button>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {lead.category && (
            <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              {lead.category}
            </span>
          )}
          {(lead.signals ?? []).map((s) => (
            <Signal key={s} label={SIGNAL_LABELS[s] ?? s} />
          ))}
          {inHubSpot && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#FF7A59]/40 bg-[#FF7A59]/10 px-2 py-0.5 text-[11px] font-semibold text-[#FF7A59]">
              ✓ In HubSpot
            </span>
          )}
        </div>

        {/* Quick research — open the lead's name + address in external tools. */}
        {(() => {
          const q = [lead.businessName, lead.address, lead.city].filter(Boolean).join(" ");
          const eq = encodeURIComponent(q);
          const links = [
            { label: "Google", href: `https://www.google.com/search?q=${eq}` },
            { label: "Maps", href: `https://www.google.com/maps/search/?api=1&query=${eq}` },
            { label: "News", href: `https://www.google.com/search?q=${eq}&tbm=nws` },
            { label: "Facebook", href: `https://www.facebook.com/search/top?q=${encodeURIComponent([lead.businessName, lead.city].filter(Boolean).join(" "))}` },
          ];
          return (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Research</span>
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)]"
                >
                  {l.label} ↗
                </a>
              ))}
            </div>
          );
        })()}
      </div>

      {/* CRM stage selector */}
      {isAdmin && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-2">Pipeline stage</p>
          <div className="flex flex-wrap gap-1.5">
            {CRM_STAGES.map((s) => {
              const active = (lead.crm?.stage ?? "new") === s.key;
              return (
                <button
                  key={s.key}
                  disabled={busy}
                  onClick={() => handleStage(s.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                    active
                      ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-white"
                      : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs text-slate-500">Follow-up</label>
            <input
              type="date"
              defaultValue={lead.crm?.followUpDate ?? ""}
              onChange={(e) => setFollowUp(lead.id, e.target.value || null)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700"
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs text-slate-500">Operator</label>
            <select
              value={lead.operatorLocked ? (lead.operator?.key ?? "__none__") : "__auto__"}
              onChange={(e) => handleOperatorChange(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700"
            >
              <option value="__auto__">Auto{lead.operator && !lead.operatorLocked ? ` (${lead.operator.name})` : ""}</option>
              <option value="__none__">None (locked)</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            {lead.operatorLocked && <span className="text-[10px] text-slate-400">pinned</span>}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handlePushToHubSpot}
              disabled={hsPushing}
              className="rounded-full border border-[#FF7A59] px-3 py-1 text-xs font-semibold text-[#FF7A59] hover:bg-[#FF7A59] hover:text-white transition disabled:opacity-40"
            >
              {hsPushing ? "Pushing…" : inHubSpot ? "Re-push to HubSpot" : "Push to HubSpot"}
            </button>
            {hsPushResult && (
              <span className={`text-xs font-medium ${hsPushResult.ok ? "text-green-600" : "text-red-500"}`}>
                {hsPushResult.ok ? "✓" : "✗"} {hsPushResult.message}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={handleApolloEnrich}
              disabled={apBusy}
              className="rounded-full border border-indigo-400 px-3 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-500 hover:text-white transition disabled:opacity-40"
            >
              {apBusy ? "Searching…" : "Find contact (Apollo)"}
            </button>
            {apResult && (
              <span className={`text-xs font-medium ${apResult.ok ? "text-green-600" : "text-red-500"}`}>
                {apResult.ok ? "✓" : "✗"} {apResult.message}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Sources */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Sources ({(lead.sources ?? []).length})</p>
        <div className="mt-2 space-y-2">
          {(lead.sources ?? []).map((s, i) => (
            <div key={`${s.type}-${s.sourceId}-${i}`} className="text-sm text-slate-600">
              <span className="font-semibold text-slate-800">{SOURCE_LABELS[s.type] ?? s.type}</span>
              {s.estimatedCost ? ` · $${Number(s.estimatedCost).toLocaleString()}` : ""}
              {s.openingDate ? ` · opens ${fmtDate(s.openingDate)}` : ""}
              {s.status ? ` · ${s.status}` : ""}
              {s.detailUrl ? (
                <>
                  {" · "}
                  <a href={s.detailUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                    record
                  </a>
                </>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* Contacts */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Contacts</p>
          {isAdmin && (
            <button onClick={() => setShowAddContact((v) => !v)} className="text-xs text-[var(--brand-accent)] font-semibold">
              {showAddContact ? "Cancel" : "+ Add"}
            </button>
          )}
        </div>
        {showAddContact && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <input placeholder="Name" value={newContact.name ?? ""} onChange={(e) => setNewContact((c) => ({ ...c, name: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <input placeholder="Phone" value={newContact.phone ?? ""} onChange={(e) => setNewContact((c) => ({ ...c, phone: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <input placeholder="Email" value={newContact.email ?? ""} onChange={(e) => setNewContact((c) => ({ ...c, email: e.target.value }))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <button onClick={handleAddContact} disabled={busy} className="rounded-lg btn-accent px-3 py-1 text-sm font-semibold disabled:opacity-50">Save contact</button>
          </div>
        )}
        <div className="space-y-1.5">
          {contacts.length === 0 ? (
            <p className="text-sm text-slate-400">No contacts yet.</p>
          ) : (
            contacts.map((c, i) => (
              <div key={c.id ?? i} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">
                  {c.name || "Unnamed"} <span className="text-slate-400">· {c.role}</span>
                </span>
                <span className="text-slate-600">
                  {c.phone ? <a href={`tel:${c.phone}`} className="text-blue-600 hover:underline">{c.phone}</a> : c.email || "--"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Activity log */}
      {isAdmin && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-2">Log activity</p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Notes about this outreach…"
            rows={2}
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["call", "email", "meeting", "note"] as const).map((t) => (
              <button key={t} disabled={busy} onClick={() => handleLog(t)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600 hover:border-slate-400 disabled:opacity-50">
                Log {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Activity timeline */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-2">History</p>
        {activities.length === 0 ? (
          <p className="text-sm text-slate-400">No activity yet.</p>
        ) : (
          <ul className="space-y-2">
            {activities.map((a) => (
              <li key={a.id} className="text-sm text-slate-600 border-l-2 border-slate-200 pl-3">
                <span className="font-semibold text-slate-800 capitalize">
                  {a.type === "stage_change" ? `Moved to ${a.toStage}` : a.type}
                </span>
                <span className="text-slate-400"> · {fmtDate(a.createdAt)}</span>
                {a.body ? <p className="text-slate-500">{a.body}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
