"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import MultiSelect from "@/components/shared/MultiSelect";
import LeadDetail, { SIGNAL_LABELS } from "@/components/leads/LeadDetail";
import { matchOperatorQuery, loadOperators, type OperatorDef } from "@/lib/operators";
import type { Lead, LeadSourceType, LeadSignal } from "@/types";

const LEADS_CACHE_KEY = "newpours.leads.cache.v1";
const LEADS_CACHE_TTL = 5 * 60 * 1000;

const SOURCE_OPTIONS: { value: LeadSourceType; label: string }[] = [
  { value: "tabs_permit", label: "Construction permit (TABS)" },
  { value: "building_permit", label: "Apartments (building permit)" },
  { value: "nonprofit_990", label: "Nonprofit ($1MM+ 990)" },
  { value: "tabc", label: "TABC license" },
  { value: "tabc_event", label: "TABC event permit" },
  { value: "event", label: "Event permit" },
];

const SIGNAL_OPTIONS = Object.entries(SIGNAL_LABELS).map(([value, label]) => ({ value, label }));

const STAGE_OPTIONS = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

type LeadRow = Lead & { id: string };

function ts(value: any): number {
  if (!value) return 0;
  const d = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function fmtDate(value: any) {
  if (!value) return "--";
  const d = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const FREE_COUNTY = "Travis";
const FREE_AGE_DAYS = 31; // query buffer over the rules' 30-day gate

export default function LeadsPage() {
  const { user, isAdmin, userPlan, userPlanStatus, loading: authLoading } = useAuth();
  const fullAccess = isAdmin || ((userPlan === "pro" || userPlan === "enterprise") && userPlanStatus === "active");
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [counties, setCounties] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [signals, setSignals] = useState<string[]>([]);
  const [stage, setStage] = useState<string>("");
  const [sortKey, setSortKey] = useState<"newest" | "opening" | "name" | "cost">("newest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false); // detail drawer on small screens
  const [operators, setOperators] = useState<OperatorDef[]>([]);

  useEffect(() => {
    loadOperators().then(setOperators).catch(() => {});
  }, []);

  useEffect(() => {
    if (authLoading) return;
    const cacheKey = LEADS_CACHE_KEY + (fullAccess ? ".full" : ".free");
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const { t, data } = JSON.parse(raw) as { t: number; data: LeadRow[] };
        if (Date.now() - t <= LEADS_CACHE_TTL) {
          setRows(data);
          setLoading(false);
          return;
        }
      }
    } catch {}
    // Free trial: only Travis + records 30+ days old (matches the Firestore rule).
    const q = fullAccess
      ? collection(db, "leads")
      : query(
          collection(db, "leads"),
          where("county", "==", FREE_COUNTY),
          where("recordDate", "<", Timestamp.fromMillis(Date.now() - FREE_AGE_DAYS * 86400000))
        );
    getDocs(q)
      .then((snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as LeadRow));
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data })); } catch {}
        setRows(data);
      })
      .finally(() => setLoading(false));
  }, [authLoading, fullAccess]);

  const countyOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.county).filter(Boolean) as string[])).sort().map((v) => ({ value: v, label: v })),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // If the query names a known operator (e.g. "McGuire Moorman"), match its whole portfolio.
    const queryOperator = matchOperatorQuery(search, operators);
    const out = rows.filter((r) => {
      if (counties.length && !counties.includes(r.county ?? "")) return false;
      if (sources.length && !(r.sources ?? []).some((s) => sources.includes(s.type))) return false;
      if (signals.length && !(r.signals ?? []).some((s) => signals.includes(s))) return false;
      if (stage && (r.crm?.stage ?? "new") !== stage) return false;
      if (q) {
        const hay = [r.businessName, r.ownerName, r.operator?.name, r.address, r.city, r.county, ...(r.phones ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const textMatch = hay.includes(q);
        const operatorMatch = queryOperator ? r.operator?.key === queryOperator.key : false;
        if (!textMatch && !operatorMatch) return false;
      }
      return true;
    });

    const openingOf = (r: LeadRow) =>
      Math.min(
        ...(r.sources ?? []).map((s) => (s.openingDate ? ts(s.openingDate) : Infinity)),
        Infinity
      );
    const costOf = (r: LeadRow) =>
      Math.max(0, ...(r.sources ?? []).map((s) => Number(s.estimatedCost ?? 0)));

    return [...out].sort((a, b) => {
      if (sortKey === "name") return a.businessName.localeCompare(b.businessName);
      if (sortKey === "cost") return costOf(b) - costOf(a);
      if (sortKey === "opening") return openingOf(a) - openingOf(b);
      return ts(b.firstSeenAt) - ts(a.firstSeenAt);
    });
  }, [rows, search, counties, sources, signals, stage, sortKey, operators]);

  const selected = filtered.find((r) => r.id === selectedId) ?? filtered[0] ?? null;

  const applyPreset = (sig: LeadSignal) => {
    setSignals([sig]);
    setStage("");
    if (sig === "build_out" || sig === "high_value_buildout") setSortKey("cost");
    else if (sig === "opening_soon" || sig === "event_upcoming") setSortKey("opening");
  };

  const handleExport = () => {
    const header = ["businessName", "owner", "address", "city", "county", "zip", "phones", "website", "sources", "signals", "stage", "firstSeen"].join(",");
    const lines = filtered.map((r) =>
      [
        r.businessName,
        r.ownerName,
        r.address,
        r.city,
        r.county,
        r.zipCode,
        (r.phones ?? []).join(" | "),
        r.website,
        (r.sources ?? []).map((s) => s.type).join(" | "),
        (r.signals ?? []).join(" | "),
        r.crm?.stage ?? "new",
        fmtDate(r.firstSeenAt),
      ].map(csvEscape).join(",")
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRadioWorkflowExport = () => {
    const RW_HEADERS = [
      "Company ID", "Account Name", "Account Manager", "Type", "EDI #",
      "Website", "General Phone", "General Cell/Mobile", "General Fax", "General Email",
      "Contact Name", "Position", "Spot Separation", "Competitive Code #1", "Competitive Code #2",
      "Email Times (Name)", "Email Times (Email)",
      "Physical Address", "Physical City", "Physical State", "Physical Zip/Postal Code",
      "Postal Address", "Postal City", "Postal State", "Postal Zip/Postal Code",
      "Contact - Full Name", "Contact - First Name", "Contact - Surname",
      "Office Phone", "Mobile/Cell", "Other Phone", "Fax Number", "Email Address", "Position",
    ];
    const lines = filtered.map((r) => {
      const phone = r.phones?.[0] ?? "";
      const email = r.emails?.[0] ?? "";
      const hasOwner = Boolean(r.ownerName);
      return [
        r.id,                        // Company ID
        r.businessName,              // Account Name
        "",                          // Account Manager
        "",                          // Type
        "",                          // EDI #
        r.website ?? "",             // Website
        phone,                       // General Phone
        "",                          // General Cell/Mobile
        "",                          // General Fax
        email,                       // General Email
        hasOwner ? r.ownerName : "", // Contact Name
        hasOwner ? "Owner" : "",     // Position
        "",                          // Spot Separation
        "",                          // Competitive Code #1
        "",                          // Competitive Code #2
        "",                          // Email Times (Name)
        "",                          // Email Times (Email)
        r.address ?? "",             // Physical Address
        r.city ?? "",                // Physical City
        "TX",                        // Physical State
        r.zipCode ?? "",             // Physical Zip/Postal Code
        "",                          // Postal Address
        "",                          // Postal City
        "",                          // Postal State
        "",                          // Postal Zip/Postal Code
        "",                          // Contact - Full Name
        "",                          // Contact - First Name
        "",                          // Contact - Surname
        "",                          // Office Phone
        "",                          // Mobile/Cell
        "",                          // Other Phone
        "",                          // Fax Number
        "",                          // Email Address (additional contact)
        "",                          // Position (additional contact)
      ].map(csvEscape).join(",");
    });
    const blob = new Blob([[RW_HEADERS.map(csvEscape).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads-radio-workflow.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-6">
      {!fullAccess && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Free trial</strong> — showing <strong>Travis County</strong> leads at least 30 days old.{" "}
          <a href="/pricing" className="font-semibold underline hover:no-underline">Upgrade</a> for every county and the newest leads as they file.
        </div>
      )}
      <div className="rounded-3xl border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.16),_transparent_30%),linear-gradient(180deg,_#ffffff_0%,_#f8fafc_100%)] p-6 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] accent">Leads</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">New businesses worth calling.</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Every new and soon-to-open business in your market — merged from TABC licenses, TDLR construction permits, and event permits, with owner and tenant contacts.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => applyPreset("opening_soon")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)]">Opening soon</button>
          <button onClick={() => applyPreset("build_out")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)]">New build-outs</button>
          <button onClick={() => applyPreset("event_upcoming")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)]">Events</button>
          <button onClick={() => applyPreset("no_website")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)]">No website</button>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-3 xl:grid-cols-6 md:grid-cols-3">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search business, owner, address, phone" className="xl:col-span-2 rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-[var(--brand-accent)]" />
          <MultiSelect placeholder="All counties" options={countyOptions} selected={counties} onChange={setCounties} />
          <MultiSelect placeholder="All sources" options={SOURCE_OPTIONS} selected={sources} onChange={setSources} />
          <MultiSelect placeholder="All signals" options={SIGNAL_OPTIONS} selected={signals} onChange={setSignals} />
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800">
            <option value="newest">Sort: Newest</option>
            <option value="opening">Sort: Opening soonest</option>
            <option value="cost">Sort: Build-out value</option>
            <option value="name">Sort: Name</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={stage} onChange={(e) => setStage(e.target.value)} className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
            <option value="">All stages</option>
            {STAGE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <button onClick={handleExport} className="rounded-full btn-accent px-4 py-1.5 text-xs font-semibold">Export CSV</button>
          <button onClick={handleRadioWorkflowExport} className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)]">Export for Radio Workflow</button>
          <button onClick={() => { setSearch(""); setCounties([]); setSources([]); setSignals([]); setStage(""); setSortKey("newest"); }} className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400">Reset</button>
          <span className="ml-auto text-sm text-slate-500">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()} leads</span>
        </div>
      </div>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">Loading leads…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">
          No leads yet. Run the <span className="font-mono">tabs_ingest</span> and <span className="font-mono">tabc_ingest</span> jobs (Admin → Job Monitor), or the migration script, to populate leads.
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Business</th>
                    <th className="px-4 py-3 hidden md:table-cell">Signals</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Stage</th>
                    <th className="px-4 py-3">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.slice(0, 300).map((r) => {
                    const isSel = r.id === selected?.id;
                    return (
                      <tr key={r.id} className={`cursor-pointer transition hover:bg-[rgba(200,169,108,0.06)] ${isSel ? "bg-[rgba(200,169,108,0.08)]" : ""}`} onClick={() => { setSelectedId(r.id); setMobileOpen(true); }}>
                        <td className="px-4 py-3 align-top">
                          <p className="font-semibold text-slate-900">{r.businessName}</p>
                          <p className="text-xs text-slate-500">{r.ownerName || (r.phones?.[0] ?? "No contact")}</p>
                          <div className="flex items-center gap-2">
                            <p className="text-xs text-slate-400">{(r.sources ?? []).map((s) => s.type).join(", ")}</p>
                            {r.operator && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setSearch(r.operator!.name); }}
                                className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100"
                                title="Show all properties from this operator"
                              >
                                🏛 {r.operator.name}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top hidden md:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {(r.signals ?? []).slice(0, 3).map((s) => (
                              <span key={s} className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{SIGNAL_LABELS[s] ?? s}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top hidden sm:table-cell">
                          <span className="text-xs font-semibold text-slate-700 capitalize">{r.crm?.stage ?? "new"}</span>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="text-slate-700">{[r.city, r.county].filter(Boolean).join(", ") || "--"}</p>
                          <p className="text-xs text-slate-400">{r.address || "No address"}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length > 300 ? <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Showing first 300. Refine filters to narrow the list.</p> : null}
          </div>

          {/* Desktop side detail */}
          <div className="hidden xl:block rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            {selected ? (
              <LeadDetail lead={selected} uid={user?.uid} isAdmin={isAdmin} onOperatorClick={(name) => setSearch(name)} />
            ) : (
              <p className="text-sm text-slate-500">No leads match the current filters.</p>
            )}
          </div>
        </div>
      )}

      {/* Mobile/tablet detail drawer */}
      {mobileOpen && selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30 xl:hidden" onClick={() => setMobileOpen(false)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMobileOpen(false)} className="mb-4 text-sm text-slate-400 hover:text-slate-700">✕ Close</button>
            <LeadDetail lead={selected} uid={user?.uid} isAdmin={isAdmin} onOperatorClick={(name) => { setSearch(name); setMobileOpen(false); }} />
          </div>
        </div>
      )}
    </section>
  );
}
