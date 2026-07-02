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
  setPrimaryContact,
  setOperator,
  clearOperatorLock,
} from "@/lib/crm";
import { loadOperators, type OperatorDef } from "@/lib/operators";
import { lookupRadioWorkflowMany, lookupMetaAds, type RwAccount } from "@/lib/radioworkflow";

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
  heavy_advertiser: "Heavy advertiser",
  in_the_news: "In the news",
  active_advertiser: "Running ads",
};

const SOURCE_LABELS: Record<string, string> = {
  tabc: "TABC license",
  tabc_event: "TABC event permit",
  tabs_permit: "Construction permit",
  event: "Event permit",
  building_permit: "Apartment building permit",
  nonprofit_990: "Nonprofit (IRS 990)",
  attorney: "Law firm (Google Places)",
  bank_branch: "Bank / credit union (FDIC)",
  medical_npi: "Medical facility (Google)",
  home_services: "Home services (Google)",
  food_drink: "Restaurant / bar (Google)",
};

const CAMPAIGN_LABELS: { key: "underwriting" | "naming" | "football"; label: string }[] = [
  { key: "underwriting", label: "Underwriting" },
  { key: "naming", label: "Naming" },
  { key: "football", label: "Football" },
];

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
    setGpResult(null);
    setGpBusy(false);
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
  const [apOrgBusy, setApOrgBusy] = useState(false);
  const [apOrgError, setApOrgError] = useState<string | null>(null);
  const [gpBusy, setGpBusy] = useState(false);
  const [gpResult, setGpResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [rwBusy, setRwBusy] = useState(false);
  const [rwAccounts, setRwAccounts] = useState<RwAccount[] | null>(null);
  const [rwError, setRwError] = useState<string | null>(null);
  const [newsBusy, setNewsBusy] = useState(false);
  const [newsItems, setNewsItems] = useState<{ title: string; source: string; link: string; date: string | null }[] | null>(null);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  const [advertiser, setAdvertiser] = useState<boolean>((lead.signals ?? []).includes("active_advertiser"));
  const [adBusy, setAdBusy] = useState(false);
  const [metaAdCount, setMetaAdCount] = useState<number | null>(null);

  const setAdvertiserTo = async (next: boolean) => {
    setAdBusy(true);
    setAdvertiser(next); // optimistic
    try {
      const fn = httpsCallable(getFunctions(), "setLeadAdvertiser");
      await fn({ leadId: lead.id, active: next });
      // Keep the in-memory lead in sync so signals/score reflect it elsewhere.
      lead.signals = next
        ? Array.from(new Set([...(lead.signals ?? []), "active_advertiser"]))
        : (lead.signals ?? []).filter((s) => s !== "active_advertiser");
    } catch {
      setAdvertiser(!next); // revert on failure
    } finally {
      setAdBusy(false);
    }
  };

  const toggleAdvertiser = () => setAdvertiserTo(!advertiser);

  // Auto-detect Meta ad activity via the extension; flag the lead if it's running ads.
  const checkMetaAds = async () => {
    const res = await lookupMetaAds(lead.businessName);
    if (!res?.ok || typeof res.count !== "number") return; // extension missing / Meta changed — stay silent
    setMetaAdCount(res.count);
    if (res.count > 0 && !(lead.signals ?? []).includes("active_advertiser")) {
      await setAdvertiserTo(true);
    }
  };

  // One free, no-cost lookup: RadioWorkflow (your session) + Google News together.
  const handleFreeLookup = () => {
    handleRadioWorkflow();
    handleNews();
  };

  // On opening a lead, surface the free signals automatically: show the press
  // already enriched in the background, and run the (free) RadioWorkflow lookup.
  useEffect(() => {
    const stored = (lead.enrichment as any)?.news;
    setNewsItems(stored?.items?.length ? stored.items : null); // only show if there's coverage
    setNewsError(null);
    setRwAccounts(null);
    setRwError(null);
    setAdvertiser((lead.signals ?? []).includes("active_advertiser"));
    setMetaAdCount(null);
    handleRadioWorkflow(true); // auto — silent if the extension isn't installed
    checkMetaAds();            // auto-detect Meta ad activity (extension, your browser)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  const handleNews = async () => {
    setNewsBusy(true);
    setNewsError(null);
    setNewsItems(null);
    try {
      const fn = httpsCallable(getFunctions(), "newsLookup");
      const res = await fn({ businessName: lead.businessName, city: lead.city ?? "" });
      const d = res.data as { items?: { title: string; source: string; link: string; date: string | null }[] };
      setNewsItems(d.items ?? []);
    } catch (err: any) {
      setNewsError(err?.message ?? "News lookup failed");
    } finally {
      setNewsBusy(false);
    }
  };

  const handleRadioWorkflow = async (auto = false) => {
    setRwBusy(true);
    setRwError(null);
    setRwAccounts(null);
    try {
      // Search the name (RW matches it fuzzily) plus a suffix-stripped variant and
      // every known email/phone, so we catch accounts filed under a different name.
      const name = lead.businessName ?? "";
      const cored = name
        .replace(/\b(llc|inc|co|corp|ltd|the|company|group|llp|lp)\b/gi, "")
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const terms = [
        name,
        ...(cored && cored.toLowerCase() !== name.toLowerCase() ? [cored] : []),
        ...(lead.emails ?? []),
        ...(lead.phones ?? []),
        ...(lead.phones ?? []).map((p) => p.replace(/\D/g, "")),
      ];
      const res = await lookupRadioWorkflowMany(terms);
      if (res.ok) setRwAccounts(res.results ?? []);
      else if (!auto) setRwError(res.error ?? "Lookup failed."); // stay quiet on auto-run
    } finally {
      setRwBusy(false);
    }
  };

  const handleGooglePlaces = async () => {
    setGpBusy(true);
    setGpResult(null);
    try {
      const fn = httpsCallable(getFunctions(), "enrichLeadPlacesLead");
      const res = await fn({ leadId: lead.id });
      const d = res.data as { matched?: boolean; website?: string; phone?: string };
      if (d.matched && (d.website || d.phone)) setGpResult({ ok: true, message: [d.phone, d.website].filter(Boolean).join("  ·  ") });
      else setGpResult({ ok: false, message: "No Google match" });
    } catch (err: any) {
      setGpResult({ ok: false, message: err?.message ?? "Lookup failed" });
    } finally {
      setGpBusy(false);
    }
  };

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

  const apolloOrgUrl = (orgId: string) =>
    `https://app.apollo.io/#/organizations/${orgId}/people?page=1&sortAscending=false&sortByField=recommendations_score`;

  const handleOpenApollo = async () => {
    setApOrgError(null);
    // Fast path: we already know the org id — open its People tab straight away.
    const cachedId = lead.enrichment?.apollo?.organizationId;
    if (cachedId) {
      window.open(apolloOrgUrl(cachedId), "_blank", "noopener,noreferrer");
      return;
    }
    // Otherwise resolve (and cache) it via Apollo — free, no contact reveal.
    setApOrgBusy(true);
    try {
      const fn = httpsCallable(getFunctions(), "apolloResolveOrg");
      const res = await fn({ leadId: lead.id });
      const d = res.data as { url?: string; organizationId?: string };
      if (d.url) {
        if (d.organizationId && lead.enrichment) {
          (lead.enrichment.apollo ||= {}).organizationId = d.organizationId;
        }
        window.open(d.url, "_blank", "noopener,noreferrer");
      } else {
        setApOrgError("No Apollo match");
      }
    } catch (err: any) {
      setApOrgError(err?.message ?? "Apollo lookup failed");
    } finally {
      setApOrgBusy(false);
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

        {/* Campaign fit — how well this lead suits each Sun Radio sell (0–100). */}
        {lead.campaignFit && (
          <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Campaign fit</p>
              {(lead.footprintCount ?? 0) > 0 && (
                <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700" title={(lead.footprintCities ?? []).join(", ")}>
                  📍 {lead.footprintCount} broadcast cities
                </span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {CAMPAIGN_LABELS.map(({ key, label }) => {
                const score = lead.campaignFit?.[key] ?? 0;
                return (
                  <div key={key} className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-center">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                    <p className={`text-lg font-bold ${score >= 60 ? "text-[var(--brand-accent)]" : score >= 30 ? "text-slate-700" : "text-slate-400"}`}>{score}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick research — open the lead's name + address in external tools. */}
        {(() => {
          const q = [lead.businessName, lead.address, lead.city].filter(Boolean).join(" ");
          const eq = encodeURIComponent(q);
          const nameCity = encodeURIComponent([lead.businessName, lead.city].filter(Boolean).join(" "));
          const justName = encodeURIComponent(lead.businessName ?? "");
          const links = [
            { label: "Google", href: `https://www.google.com/search?q=${eq}` },
            { label: "Maps", href: `https://www.google.com/maps/search/?api=1&query=${eq}` },
            { label: "News", href: `https://www.google.com/search?q=${eq}&tbm=nws` },
            { label: "Facebook", href: `https://www.facebook.com/search/top?q=${nameCity}` },
            // "Already advertising?" — public ad transparency, the free media-spend check.
            { label: "Meta ads", href: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=${justName}&search_type=keyword_unordered&media_type=all` },
            { label: "Google ads", href: `https://adstransparency.google.com/?region=US&query=${justName}` },
          ];
          return (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {/* One free lookup: RadioWorkflow + recent press together (no API cost). */}
              <button
                onClick={handleFreeLookup}
                disabled={rwBusy || newsBusy}
                className="inline-flex items-center rounded-full border border-emerald-400 bg-emerald-50 px-3 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500 hover:text-white transition disabled:opacity-40"
                title="Free lookup — checks RadioWorkflow (your session) and recent news at once"
              >
                {rwBusy || newsBusy ? "Looking up…" : "Look up (free)"}
              </button>
              <button
                onClick={() => setShowLinks((v) => !v)}
                className="inline-flex items-center rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-slate-500 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)]"
              >
                Links {showLinks ? "▴" : "▾"}
              </button>
              {/* Confirmed-advertiser toggle — flip after checking the Meta/Google ad links. */}
              <button
                onClick={toggleAdvertiser}
                disabled={adBusy}
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition disabled:opacity-40 ${
                  advertiser
                    ? "border border-amber-500 bg-amber-500 text-white"
                    : "border border-amber-400 bg-white text-amber-700 hover:bg-amber-50"
                }`}
                title="Mark this lead as a confirmed active advertiser (boosts campaign-fit scores)"
              >
                {advertiser ? "✓ Running ads" : "Running ads?"}
              </button>
              {metaAdCount !== null && metaAdCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700" title="Active ads found in the Meta Ad Library">
                  Meta: {metaAdCount} ad{metaAdCount === 1 ? "" : "s"}
                </span>
              )}
              {showLinks && links.map((l) => (
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

        {/* Recent press — Google News coverage in the last ~6 months. */}
        {(newsError || newsItems) && (
          <div className="mt-2 rounded-2xl border border-violet-200 bg-violet-50/60 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-700">Recent press</p>
            {newsError ? (
              <p className="mt-1 text-xs text-amber-700">{newsError}</p>
            ) : (newsItems ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-slate-600">No recent news coverage found.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {(newsItems ?? []).map((n, i) => (
                  <li key={i} className="text-xs">
                    <a href={n.link} target="_blank" rel="noopener noreferrer" className="font-medium text-violet-800 hover:underline">
                      {n.title}
                    </a>
                    <span className="text-slate-500">
                      {" "}· {n.source}{n.date ? ` · ${new Date(n.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* RadioWorkflow lookup result — is this account already in the station CRM? */}
        {(rwError || rwAccounts) && (
          <div className="mt-2 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">RadioWorkflow</p>
            {rwError ? (
              <p className="mt-1 text-xs text-amber-700">{rwError}</p>
            ) : (rwAccounts ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-slate-600">No matching account — not in RadioWorkflow yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {(rwAccounts ?? []).slice(0, 5).map((a) => (
                  <div key={String(a.id)} className="rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      {a.url ? (
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-emerald-700 hover:underline">
                          {a.name || "(unnamed)"} ↗
                        </a>
                      ) : (
                        <span className="font-semibold text-slate-900">{a.name || "(unnamed)"}</span>
                      )}
                      {a.owner && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">owned by {a.owner}</span>}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${a.prospect ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                        {a.prospect ? "Prospect" : "Client"}
                      </span>
                      {a.archived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Archived</span>}
                    </div>
                    {(a.contactName || a.position) && (
                      <p className="mt-1 text-slate-600">{[a.contactName, a.position].filter(Boolean).join(" · ")}</p>
                    )}
                    <p className="mt-0.5 text-slate-500">{[a.email, a.phone].filter(Boolean).join(" · ") || "No contact on file"}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
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
          {/* Paid enrichment — kept separate + explicit so a click never silently
              burns API credits. Run only when a lead is worth the spend. */}
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Enrich · uses paid APIs
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                onClick={handleGooglePlaces}
                disabled={gpBusy}
                className="rounded-full border border-sky-400 px-3 py-1 text-xs font-semibold text-sky-600 hover:bg-sky-500 hover:text-white transition disabled:opacity-40"
                title="Google Places — cheap. Fills website + phone."
              >
                {gpBusy ? "Searching…" : "Website/phone (Google ¢)"}
              </button>
              {gpResult && (
                <span className={`text-xs font-medium ${gpResult.ok ? "text-green-600" : "text-red-500"}`}>
                  {gpResult.ok ? "✓" : "✗"} {gpResult.message}
                </span>
              )}
              <button
                onClick={handleApolloEnrich}
                disabled={apBusy}
                className="rounded-full border border-indigo-400 px-3 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-500 hover:text-white transition disabled:opacity-40"
                title="Apollo — costs a credit per reveal. Finds a named contact + email."
              >
                {apBusy ? "Searching…" : "Contact + email (Apollo $)"}
              </button>
              {apResult && (
                <span className={`text-xs font-medium ${apResult.ok ? "text-green-600" : "text-red-500"}`}>
                  {apResult.ok ? "✓" : "✗"} {apResult.message}
                </span>
              )}
              <button
                onClick={handleOpenApollo}
                disabled={apOrgBusy}
                className="rounded-full border border-indigo-400 px-3 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-500 hover:text-white transition disabled:opacity-40"
                title="Open this company's People tab in Apollo (free — no contact reveal). Resolves the Apollo org on first use."
              >
                {apOrgBusy ? "Opening…" : "Open in Apollo ↗"}
              </button>
              {apOrgError && (
                <span className="text-xs font-medium text-red-500">✗ {apOrgError}</span>
              )}
            </div>
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
            contacts.map((c, i) => {
              const isPrimary = lead.primaryContact?.name && c.name && lead.primaryContact.name === c.name && lead.primaryContact.phone === (c.phone ?? null);
              return (
                <div key={c.id ?? i} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">
                      {c.name || "Unnamed"}
                      <span className="ml-1.5 text-xs font-normal text-slate-400">{c.role}</span>
                      {isPrimary && (
                        <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">export</span>
                      )}
                    </span>
                    {isAdmin && !isPrimary && c.name && (
                      <button
                        onClick={async () => {
                          await setPrimaryContact(lead.id, { name: c.name, phone: c.phone, email: c.email, role: c.role });
                          lead.primaryContact = { name: c.name, phone: c.phone, email: c.email, role: c.role };
                          setContacts((prev) => [...prev]); // re-render
                        }}
                        className="text-[10px] font-semibold text-slate-400 hover:text-emerald-600"
                      >
                        Set as export
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 text-slate-500">
                    {c.phone ? <a href={`tel:${c.phone}`} className="text-blue-600 hover:underline">{c.phone}</a> : null}
                    {c.phone && c.email ? " · " : null}
                    {c.email || (!c.phone ? "No contact info" : null)}
                  </div>
                </div>
              );
            })
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
