"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import { getLicenseTypeInfo } from "@/lib/tabc-license-types";

const EXPLORER_STORAGE_KEY = "newpours.explorer.filters.v1";

type RevenueTrend = "up" | "flat" | "down";

type RawRecord = Record<string, any>;

type ExplorerRow = {
  id: string;
  businessName: string;
  tradeName?: string;
  ownerName?: string;
  licenseNumber?: string;
  licenseType?: string;
  licenseTypeLabel?: string;
  status?: string;
  county?: string;
  city?: string;
  zipCode?: string;
  address?: string;
  mailAddress?: string;
  mailCity?: string;
  email?: string;
  applicationDate?: any;
  originalIssueDate?: string | null;
  expirationDate?: any;
  firstSeenAt?: any;
  classification?: string;
  enrichment: {
    googlePlaces?: string;
    comptroller?: string;
    healthInspection?: string;
    buildingPermits?: string;
  };
  googlePlaces?: {
    rating?: number;
    reviewCount?: number;
    website?: string;
    priceLevel?: number;
    phoneNumber?: string;
    matchedVia?: string;
    hours?: { weekday_text?: string[]; open_now?: boolean } | null;
  };
  comptroller?: {
    taxpayerNumber?: string;
    latestMonthRevenue?: number;
    avgMonthlyRevenue?: number;
    revenueTrend?: RevenueTrend;
    revenueDataThrough?: string;
    confidence?: number;
    matchMethod?: string;
  };
  healthInspection?: {
    latestScore?: number;
    latestInspectionDate?: string;
    scoreTrend?: string;
  };
  buildingPermits?: {
    recentPermits?: Array<{ issueDate?: string; permitType?: string; workValue?: number }>;
    hasSignificantRecentWork?: boolean;
    largestRecentPermitValue?: number;
  };
  propertyData?: {
    propClass?: string;
    improvements?: string[];
    dba?: string;
    ownerName?: string;
    viabilityScore?: number;
  };
};

type SortKey =
  | "latestRevenue"
  | "avgRevenue"
  | "rating"
  | "reviews"
  | "health"
  | "applicationDate"
  | "name";

type FilterState = {
  search: string;
  county: string[];
  city: string[];
  zipCode: string;
  status: string;
  classification: string[];
  licenseType: string[];
  revenueMin: string;
  revenueMax: string;
  ratingMin: string;
  healthMin: string;
  website: "all" | "yes" | "no";
  permits: "all" | "yes" | "no";
  sortKey: SortKey;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: FilterState = {
  search: "",
  county: [],
  city: [],
  zipCode: "",
  status: "",
  classification: [],
  licenseType: [],
  revenueMin: "",
  revenueMax: "",
  ratingMin: "",
  healthMin: "",
  website: "all",
  permits: "all",
  sortKey: "latestRevenue",
  sortDir: "desc",
};

function MultiSelectDropdown({
  placeholder,
  options,
  selected,
  onChange,
  className,
}: {
  placeholder: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const displayLabel =
    selected.length === 0
      ? placeholder
      : selected.length === 1
      ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
      : `${selected.length} selected`;

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-left hover:border-slate-400"
      >
        <span className={selected.length === 0 ? "text-slate-500 truncate" : "text-slate-800 truncate"}>{displayLabel}</span>
        <span className="shrink-0 text-slate-400 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-72 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 flex gap-3 px-3 py-2 bg-white border-b border-slate-100 text-xs">
            <button type="button" onClick={() => onChange(options.map((o) => o.value))} className="accent font-semibold hover:underline">All</button>
            <span className="text-slate-300">·</span>
            <button type="button" onClick={() => onChange([])} className="text-slate-500 hover:underline">None</button>
            {selected.length > 0 && <span className="ml-auto text-slate-400">{selected.length} of {options.length}</span>}
          </div>
          {options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, opt.value] : selected.filter((v) => v !== opt.value))
                }
                className="accent-[var(--brand-accent)] shrink-0"
              />
              <span className="text-sm text-slate-700 truncate">{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function formatCurrency(value?: number | null) {
  if (value == null || Number.isNaN(value)) return "No revenue";
  return `$${value.toLocaleString()}`;
}

function formatCompactCurrency(value?: number | null) {
  if (value == null || Number.isNaN(value)) return "--";
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value)}`;
}

function formatDate(value?: any) {
  if (!value) return "--";
  const date = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatGoogleHours(hours?: { weekday_text?: string[]; open_now?: boolean } | null) {
  if (!hours) return "No hours found";
  const lines = Array.isArray(hours.weekday_text) ? hours.weekday_text.filter(Boolean) : [];
  if (lines.length > 0) return lines.slice(0, 2).join(" | ");
  if (hours.open_now === true) return "Open now";
  if (hours.open_now === false) return "Closed now";
  return "No hours found";
}

function getTimestamp(value?: any) {
  if (!value) return 0;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeName(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRow(id: string, raw: RawRecord): ExplorerRow {
  return {
    id,
    businessName: raw.businessName ?? raw.tradeName ?? "Unnamed Venue",
    tradeName: raw.tradeName,
    ownerName: raw.ownerName,
    licenseNumber: raw.licenseNumber,
    licenseType: raw.licenseType,
    licenseTypeLabel: raw.licenseTypeLabel,
    status: raw.status,
    county: raw.county,
    city: raw.city,
    zipCode: raw.zipCode,
    address: raw.address,
    mailAddress: raw.mailAddress,
    mailCity: raw.mailCity,
    email: raw.email,
    applicationDate: raw.applicationDate,
    originalIssueDate: raw.originalIssueDate ?? null,
    expirationDate: raw.expirationDate ?? null,
    firstSeenAt: raw.firstSeenAt,
    classification: raw.newEstablishmentClassification,
    enrichment: {
      googlePlaces: raw.enrichment?.googlePlaces ?? raw["enrichment.googlePlaces"],
      comptroller: raw.enrichment?.comptroller ?? raw["enrichment.comptroller"],
      healthInspection: raw.enrichment?.healthInspection ?? raw["enrichment.healthInspection"],
      buildingPermits: raw.enrichment?.buildingPermits ?? raw["enrichment.buildingPermits"],
    },
    googlePlaces: {
      ...(raw.googlePlaces ?? {}),
      rating: raw.googlePlaces?.rating,
      reviewCount: raw.googlePlaces?.reviewCount,
      website: raw.googlePlaces?.website,
      priceLevel: raw.googlePlaces?.priceLevel,
      phoneNumber: raw.googlePlaces?.phoneNumber ?? raw.googlePlaces?.phone,
      matchedVia: raw.googlePlaces?.matchedVia,
      hours: raw.googlePlaces?.hours ?? raw.googlePlaces?.openingHours ?? null,
    },
    comptroller: {
      ...(raw.comptroller ?? {}),
      taxpayerNumber: raw.comptroller?.taxpayerNumber ?? raw["comptroller.taxpayerNumber"],
      latestMonthRevenue: raw.comptroller?.latestMonthRevenue ?? raw["comptroller.latestMonthRevenue"],
      avgMonthlyRevenue: raw.comptroller?.avgMonthlyRevenue ?? raw["comptroller.avgMonthlyRevenue"],
      revenueTrend: raw.comptroller?.revenueTrend ?? raw["comptroller.revenueTrend"],
      revenueDataThrough: raw.comptroller?.revenueDataThrough ?? raw["comptroller.revenueDataThrough"],
      confidence: raw.comptroller?.confidence ?? raw["comptroller.confidence"],
      matchMethod: raw.comptroller?.matchMethod ?? raw["comptroller.matchMethod"],
    },
    healthInspection: {
      ...(raw.healthInspection ?? {}),
      latestScore: raw.healthInspection?.latestScore,
      latestInspectionDate: raw.healthInspection?.latestInspectionDate,
      scoreTrend: raw.healthInspection?.scoreTrend,
    },
    buildingPermits: {
      ...(raw.buildingPermits ?? {}),
      recentPermits: raw.buildingPermits?.recentPermits,
      hasSignificantRecentWork: raw.buildingPermits?.hasSignificantRecentWork,
      largestRecentPermitValue: raw.buildingPermits?.largestRecentPermitValue,
    },
    propertyData: raw.propertyData ? {
      propClass: raw.propertyData.propClass,
      improvements: raw.propertyData.improvements,
      dba: raw.propertyData.dba,
      ownerName: raw.propertyData.ownerName,
      viabilityScore: raw.propertyData.viabilityScore,
    } : undefined,
  };
}

function StatusPill({ label, tone }: { label: string; tone: "neutral" | "good" | "warn" | "hot" }) {
  const styles = {
    neutral: "bg-slate-100 text-slate-700 border-slate-200",
    good: "bg-emerald-100 text-emerald-700 border-emerald-200",
    warn: "bg-[rgba(200,169,108,0.08)] text-[var(--brand-accent)] border-[rgba(200,169,108,0.12)]",
    hot: "bg-rose-100 text-rose-700 border-rose-200",
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[tone]}`}>{label}</span>;
}

function ExplorerCard({ title, value, meta }: { title: string; value: string; meta: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{title}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{meta}</p>
    </div>
  );
}

export default function ExplorerPage() {
  const { user, isAdmin } = useAuth();
  const [rows, setRows] = useState<ExplorerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [hydrated, setHydrated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [enrichingFiltered, setEnrichingFiltered] = useState(false);
  const [enrichingHealth, setEnrichingHealth] = useState(false);
  const [enrichingRevenue, setEnrichingRevenue] = useState(false);
  const [onlyMissingGoogle, setOnlyMissingGoogle] = useState(true);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPLORER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Migrate old single-string values to arrays
        const toArray = (v: unknown): string[] =>
          Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
        setFilters({
          ...DEFAULT_FILTERS,
          ...(parsed as Partial<FilterState>),
          county: toArray(parsed.county),
          city: toArray(parsed.city),
          classification: toArray(parsed.classification),
          licenseType: toArray(parsed.licenseType),
        });
      }
    } catch {
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(EXPLORER_STORAGE_KEY, JSON.stringify(filters));
    } catch {
    }
  }, [filters, hydrated]);

  // isAdmin comes from AuthProvider — no token read needed here.

  // Load establishments via shared sessionStorage cache (5-min TTL) to avoid redundant full-collection reads
  useEffect(() => {
    const EST_CACHE_KEY = "newpours.establishments.cache.v1";
    const EST_CACHE_TTL = 5 * 60 * 1000;
    try {
      const raw = sessionStorage.getItem(EST_CACHE_KEY);
      if (raw) {
        const { ts, data } = JSON.parse(raw) as { ts: number; data: RawRecord[] };
        if (Date.now() - ts <= EST_CACHE_TTL) {
          const nextRows = (data as RawRecord[]).map((d) => normalizeRow((d as any)._id ?? "", d));
          setRows(nextRows);
          if (nextRows.length > 0) setSelectedId(nextRows[0].id);
          setLoading(false);
          return;
        }
      }
    } catch { }
    getDocs(collection(db, "establishments"))
      .then((snapshot) => {
        const raw = snapshot.docs.map((d) => ({ _id: d.id, ...d.data() } as RawRecord));
        try { sessionStorage.setItem(EST_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: raw })); } catch { }
        const nextRows = raw.map((d) => normalizeRow((d as any)._id, d));
        setRows(nextRows);
        if (nextRows.length > 0) setSelectedId(nextRows[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  const countyOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.county).filter(Boolean) as string[])).sort().map((v) => ({ value: v, label: v })),
    [rows]
  );
  const cityOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.city).filter(Boolean) as string[])).sort().map((v) => ({ value: v, label: v })),
    [rows]
  );
  const licenseTypeOptions = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.licenseType).filter(Boolean) as string[]))
        .sort()
        .map((code) => {
          const info = getLicenseTypeInfo(code);
          return { value: code, label: info ? `${code} — ${info.short}` : code };
        }),
    [rows]
  );
  const classificationOptions = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.classification).filter(Boolean) as string[]))
        .sort()
        .map((v) => ({ value: v, label: v.replaceAll("_", " ") })),
    [rows]
  );

  const filteredRows = useMemo(() => {
    const revenueMin = Number(filters.revenueMin || 0);
    const revenueMax = Number(filters.revenueMax || 0);
    const ratingMin = Number(filters.ratingMin || 0);
    const healthMin = Number(filters.healthMin || 0);
    const query = normalizeName(filters.search);

    const filtered = rows.filter((row) => {
      const latestRevenue = Number(row.comptroller?.latestMonthRevenue ?? 0);
      const rating = Number(row.googlePlaces?.rating ?? 0);
      const healthScore = Number(row.healthInspection?.latestScore ?? 0);
      const hasWebsite = Boolean(row.googlePlaces?.website);
      const hasPermits = Boolean(row.buildingPermits?.hasSignificantRecentWork || row.buildingPermits?.recentPermits?.length);

      if (filters.county.length > 0 && !filters.county.includes(row.county ?? "")) return false;
      if (filters.city.length > 0 && !filters.city.includes(row.city ?? "")) return false;
      if (filters.zipCode && row.zipCode !== filters.zipCode) return false;
      if (filters.status && row.status !== filters.status) return false;
      if (filters.classification.length > 0 && !filters.classification.includes(row.classification ?? "")) return false;
      if (filters.licenseType.length > 0 && !filters.licenseType.includes(row.licenseType ?? "")) return false;
      if (filters.revenueMin && latestRevenue < revenueMin) return false;
      if (filters.revenueMax && latestRevenue > revenueMax) return false;
      if (filters.ratingMin && rating < ratingMin) return false;
      if (filters.healthMin && healthScore < healthMin) return false;
      if (filters.website === "yes" && !hasWebsite) return false;
      if (filters.website === "no" && hasWebsite) return false;
      if (filters.permits === "yes" && !hasPermits) return false;
      if (filters.permits === "no" && hasPermits) return false;

      if (query) {
        const haystack = normalizeName([
          row.businessName,
          row.tradeName,
          row.ownerName,
          row.address,
          row.city,
          row.county,
          row.zipCode,
          row.licenseNumber,
        ].filter(Boolean).join(" "));
        if (!haystack.includes(query)) return false;
      }

      return true;
    });

    const sorted = [...filtered].sort((left, right) => {
      const leftValue = getSortValue(left, filters.sortKey);
      const rightValue = getSortValue(right, filters.sortKey);
      if (leftValue < rightValue) return filters.sortDir === "asc" ? -1 : 1;
      if (leftValue > rightValue) return filters.sortDir === "asc" ? 1 : -1;
      return left.businessName.localeCompare(right.businessName);
    });

    return sorted;
  }, [rows, filters]);

  const selected = filteredRows.find((row) => row.id === selectedId) ?? filteredRows[0] ?? null;

  const stats = useMemo(() => {
    const revenueRows = filteredRows.filter((row) => row.comptroller?.latestMonthRevenue != null);
    const totalRevenue = revenueRows.reduce((sum, row) => sum + Number(row.comptroller?.latestMonthRevenue ?? 0), 0);
    const avgRevenue = revenueRows.length ? Math.round(totalRevenue / revenueRows.length) : 0;
    const pendingRenewals = filteredRows.filter((row) => row.classification === "RENEWAL" && String(row.status ?? "").toLowerCase().includes("pending")).length;
    const underRadar = filteredRows.filter((row) => Number(row.comptroller?.latestMonthRevenue ?? 0) >= 50000 && (!row.googlePlaces?.website || Number(row.googlePlaces?.rating ?? 0) < 4.2)).length;
    return { totalRevenue, avgRevenue, pendingRenewals, underRadar };
  }, [filteredRows]);

  const topRevenue = filteredRows[0]?.comptroller?.latestMonthRevenue;

  const applyPreset = (preset: "topRevenue" | "pendingRenewals" | "underRadar" | "permitMomentum") => {
    if (preset === "topRevenue") {
      setFilters((prev) => ({ ...prev, sortKey: "latestRevenue", sortDir: "desc", revenueMin: "50000" }));
      return;
    }
    if (preset === "pendingRenewals") {
      setFilters((prev) => ({ ...prev, classification: "RENEWAL", status: "Pending – In Review", sortKey: "latestRevenue", sortDir: "desc" }));
      return;
    }
    if (preset === "underRadar") {
      setFilters((prev) => ({ ...prev, revenueMin: "50000", website: "no", sortKey: "latestRevenue", sortDir: "desc" }));
      return;
    }
    setFilters((prev) => ({ ...prev, permits: "yes", revenueMin: "25000", sortKey: "latestRevenue", sortDir: "desc" }));
  };

  const handleExport = () => {
    const header = [
      "businessName",
      "ownerName",
      "licenseNumber",
      "licenseType",
      "status",
      "classification",
      "address",
      "city",
      "county",
      "zipCode",
      "latestMonthRevenue",
      "revenueMonth",
      "rating",
      "reviewCount",
      "healthScore",
      "website",
      "permitSignal",
    ].join(",");

    const lines = filteredRows.map((row) => [
      row.businessName,
      row.ownerName,
      row.licenseNumber,
      row.licenseType,
      row.status,
      row.classification,
      row.address,
      row.city,
      row.county,
      row.zipCode,
      row.comptroller?.latestMonthRevenue,
      row.comptroller?.revenueDataThrough,
      row.googlePlaces?.rating,
      row.googlePlaces?.reviewCount,
      row.healthInspection?.latestScore,
      row.googlePlaces?.website,
      row.buildingPermits?.hasSignificantRecentWork ? "yes" : "no",
    ].map(csvEscape).join(","));

    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "market-explorer.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const runGoogleEnrichForFiltered = async () => {
    if (!user || !isAdmin || enrichingFiltered) return;

    const targetIds = filteredRows.map((row) => row.id).filter(Boolean);
    if (!targetIds.length) {
      setAdminMessage("No filtered venues to enrich.");
      return;
    }

    const MAX_TARGET_IDS = 1000;
    const slicedIds = targetIds.slice(0, MAX_TARGET_IDS);
    const confirmMessage = `Queue Google Places refresh for ${slicedIds.length.toLocaleString()} filtered venue(s)${targetIds.length > MAX_TARGET_IDS ? ` (limited from ${targetIds.length.toLocaleString()})` : ""}?`;
    if (!window.confirm(confirmMessage)) return;

    setEnrichingFiltered(true);
    setAdminMessage(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/trigger/google_places_refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          lookbackMonths: 24,
          onlyMissingGoogle,
          establishmentIds: slicedIds,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdminMessage(payload?.error ? `Queue failed: ${payload.error}` : "Queue failed.");
        return;
      }

      setAdminMessage(`Queued Google Places refresh for ${slicedIds.length.toLocaleString()} filtered venue(s).`);
    } catch {
      setAdminMessage("Queue failed due to a network or auth error.");
    } finally {
      setEnrichingFiltered(false);
    }
  };

  const runHealthEnrichForFiltered = async () => {
    if (!user || !isAdmin || enrichingHealth) return;
    const county = filters.county.length === 1 ? filters.county[0] : undefined;
    const scope = county ? `county: ${county}` : filters.county.length > 1 ? `${filters.county.length} counties` : "all counties";
    if (!window.confirm(`Queue health inspection enrichment for ${filteredRows.length.toLocaleString()} visible venue(s) (${scope}, up to 500 processed)?`)) return;
    setEnrichingHealth(true);
    setAdminMessage(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/trigger/health_inspections", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ county, lookbackMonths: 24 }),
      });
      const payload = await res.json().catch(() => ({}));
      setAdminMessage(res.ok
        ? `Queued health inspection enrichment (${scope}).`
        : `Queue failed: ${payload?.error ?? "unknown error"}`);
    } catch {
      setAdminMessage("Queue failed due to a network or auth error.");
    } finally {
      setEnrichingHealth(false);
    }
  };

  const runRevenueEnrichForFiltered = async () => {
    if (!user || !isAdmin || enrichingRevenue) return;
    const county = filters.county.length === 1 ? filters.county[0] : undefined;
    const scope = county ? `county: ${county}` : filters.county.length > 1 ? `${filters.county.length} counties` : "all counties";
    if (!window.confirm(`Queue comptroller revenue update for ${scope}? This pulls the latest month of sales data.`)) return;
    setEnrichingRevenue(true);
    setAdminMessage(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/trigger/comptroller_update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ county, lookbackMonths: 1 }),
      });
      const payload = await res.json().catch(() => ({}));
      setAdminMessage(res.ok
        ? `Queued comptroller revenue update (${scope}).`
        : `Queue failed: ${payload?.error ?? "unknown error"}`);
    } catch {
      setAdminMessage("Queue failed due to a network or auth error.");
    } finally {
      setEnrichingRevenue(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.16),_transparent_30%),linear-gradient(180deg,_#ffffff_0%,_#f8fafc_100%)] p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] accent">Market Explorer</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Find the venues worth calling next.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Rank establishments by revenue, isolate promising renewals, and surface under-served operators using the same TABC, Comptroller, Google, inspection, and permit signals powering the alert feed.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => applyPreset("topRevenue")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)] hover:text-accent">Top Revenue</button>
            <button onClick={() => applyPreset("pendingRenewals")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)] hover:text-accent">Pending Renewals</button>
            <button onClick={() => applyPreset("underRadar")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)] hover:text-accent">No Website Over $50k</button>
            <button onClick={() => applyPreset("permitMomentum")} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-accent)] hover:text-accent">Permit Momentum</button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ExplorerCard title="Visible Venues" value={filteredRows.length.toLocaleString()} meta={`${rows.length.toLocaleString()} loaded establishments`} />
        <ExplorerCard title="Visible Revenue" value={formatCompactCurrency(stats.totalRevenue)} meta={topRevenue != null ? `Top row ${formatCompactCurrency(topRevenue)}` : "No revenue filters yet"} />
        <ExplorerCard title="Avg Monthly Revenue" value={formatCompactCurrency(stats.avgRevenue)} meta="Across filtered venues with Comptroller matches" />
        <ExplorerCard title="Opportunity Count" value={stats.underRadar.toLocaleString()} meta={`${stats.pendingRenewals.toLocaleString()} pending renewals in current slice`} />
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 xl:grid-cols-6 md:grid-cols-3">
            <input value={filters.search} onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))} placeholder="Search venue, owner, address, license #" className="xl:col-span-2 rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-[var(--brand-accent)]" />
            <MultiSelectDropdown
              placeholder="All counties"
              options={countyOptions}
              selected={filters.county}
              onChange={(v) => setFilters((prev) => ({ ...prev, county: v }))}
            />
            <MultiSelectDropdown
              placeholder="All cities"
              options={cityOptions}
              selected={filters.city}
              onChange={(v) => setFilters((prev) => ({ ...prev, city: v }))}
            />
            <input value={filters.zipCode} onChange={(event) => setFilters((prev) => ({ ...prev, zipCode: event.target.value }))} placeholder="ZIP" className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800" />
            <select value={filters.sortKey} onChange={(event) => setFilters((prev) => ({ ...prev, sortKey: event.target.value as SortKey }))} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800">
              <option value="latestRevenue">Sort: Latest Revenue</option>
              <option value="avgRevenue">Sort: Avg Revenue</option>
              <option value="rating">Sort: Rating</option>
              <option value="reviews">Sort: Review Count</option>
              <option value="health">Sort: Health Score</option>
              <option value="applicationDate">Sort: Application Date</option>
              <option value="name">Sort: Name</option>
            </select>
          </div>

          <div className="grid gap-3 xl:grid-cols-8 md:grid-cols-4">
            <select value={filters.status} onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800">
              <option value="">All statuses</option>
              <option value="Pending – In Review">Pending – In Review</option>
              <option value="Active">Active</option>
              <option value="Expired">Expired</option>
            </select>
            <MultiSelectDropdown
              placeholder="All classes"
              options={classificationOptions}
              selected={filters.classification}
              onChange={(v) => setFilters((prev) => ({ ...prev, classification: v }))}
            />
            <MultiSelectDropdown
              placeholder="All license types"
              options={licenseTypeOptions}
              selected={filters.licenseType}
              onChange={(v) => setFilters((prev) => ({ ...prev, licenseType: v }))}
            />
            <input value={filters.revenueMin} onChange={(event) => setFilters((prev) => ({ ...prev, revenueMin: event.target.value }))} placeholder="Revenue min" className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800" />
            <input value={filters.revenueMax} onChange={(event) => setFilters((prev) => ({ ...prev, revenueMax: event.target.value }))} placeholder="Revenue max" className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800" />
            <input value={filters.ratingMin} onChange={(event) => setFilters((prev) => ({ ...prev, ratingMin: event.target.value }))} placeholder="Min rating" className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800" />
            <input value={filters.healthMin} onChange={(event) => setFilters((prev) => ({ ...prev, healthMin: event.target.value }))} placeholder="Min health" className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-800" />
            <button onClick={handleExport} className="rounded-xl btn-accent px-4 py-2.5 text-sm font-semibold">Export CSV</button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <>
                <label className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={onlyMissingGoogle}
                    onChange={(event) => setOnlyMissingGoogle(event.target.checked)}
                    className="accent-[var(--brand-accent)]"
                  />
                  Only missing Google matches
                </label>
                <button
                  onClick={runGoogleEnrichForFiltered}
                  disabled={enrichingFiltered || filteredRows.length === 0}
                  className="rounded-full btn-accent px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {enrichingFiltered ? "Queueing..." : "Admin: Google Places"}
                </button>
                <button
                  onClick={runHealthEnrichForFiltered}
                  disabled={enrichingHealth || filteredRows.length === 0}
                  className="rounded-full border border-slate-400 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {enrichingHealth ? "Queueing..." : "Admin: Health inspections"}
                </button>
                <button
                  onClick={runRevenueEnrichForFiltered}
                  disabled={enrichingRevenue || filteredRows.length === 0}
                  className="rounded-full border border-slate-400 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {enrichingRevenue ? "Queueing..." : "Admin: Revenue data"}
                </button>
              </>
            ) : null}
            <select value={filters.website} onChange={(event) => setFilters((prev) => ({ ...prev, website: event.target.value as FilterState["website"] }))} className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
              <option value="all">Website: all</option>
              <option value="yes">Website: yes</option>
              <option value="no">Website: no</option>
            </select>
            <select value={filters.permits} onChange={(event) => setFilters((prev) => ({ ...prev, permits: event.target.value as FilterState["permits"] }))} className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
              <option value="all">Permits: all</option>
              <option value="yes">Permits: yes</option>
              <option value="no">Permits: no</option>
            </select>
            <button onClick={() => setFilters(DEFAULT_FILTERS)} className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400">Reset filters</button>
            <button onClick={() => setFilters((prev) => ({ ...prev, sortDir: prev.sortDir === "asc" ? "desc" : "asc" }))} className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400">Direction: {filters.sortDir === "desc" ? "High to low" : "Low to high"}</button>
            <span className="ml-auto text-sm text-slate-500">{filteredRows.length.toLocaleString()} venues in current view</span>
          </div>
          {isAdmin && adminMessage ? <p className="text-xs text-slate-600">{adminMessage}</p> : null}
        </div>
      </div>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">Loading explorer data...</div>
      ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.8fr)]">
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Venue</th>
                    <th className="px-4 py-3">Revenue</th>
                    <th className="px-4 py-3">Google</th>
                    <th className="px-4 py-3">Health</th>
                    <th className="px-4 py-3">Class</th>
                    <th className="px-4 py-3">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRows.slice(0, 250).map((row) => {
                    const latestRevenue = row.comptroller?.latestMonthRevenue;
                    const rating = row.googlePlaces?.rating;
                    const reviews = row.googlePlaces?.reviewCount;
                    const health = row.healthInspection?.latestScore;
                    const hasPermits = Boolean(row.buildingPermits?.hasSignificantRecentWork || row.buildingPermits?.recentPermits?.length);
                    const selectedRow = row.id === selected?.id;
                      return (
                      <tr key={row.id} className={`cursor-pointer transition hover:bg-[rgba(200,169,108,0.06)] ${selectedRow ? "bg-[rgba(200,169,108,0.08)]" : ""}`} onClick={() => setSelectedId(row.id)}>
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold text-slate-900">{row.businessName}</p>
                              {String(row.status ?? "").toLowerCase().includes("pending") ? <StatusPill label="Pending" tone="warn" /> : null}
                              {hasPermits ? <StatusPill label="Permit signal" tone="hot" /> : null}
                            </div>
                            <p className="text-xs text-slate-500">{row.ownerName || "No owner"}</p>
                            <p className="text-xs text-slate-400">{row.licenseType || "--"}{row.licenseNumber ? ` · ${row.licenseNumber}` : ""}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="font-semibold text-slate-900">{formatCurrency(latestRevenue)}</p>
                          <p className="text-xs text-slate-500">{row.comptroller?.revenueDataThrough || "No month yet"}</p>
                          {row.comptroller?.revenueTrend ? <p className="mt-1 text-xs text-slate-400">Trend: {row.comptroller.revenueTrend}</p> : null}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="font-semibold text-slate-900">{rating != null ? rating.toFixed(1) : "--"}</p>
                          <p className="text-xs text-slate-500">{reviews != null ? `${reviews} reviews` : "No Google profile"}</p>
                          <p className="mt-1 text-xs text-slate-400">{row.googlePlaces?.website ? "Website present" : "No website"}</p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="font-semibold text-slate-900">{health != null ? health : "--"}</p>
                          <p className="text-xs text-slate-500">{row.healthInspection?.latestInspectionDate ? formatDate(row.healthInspection.latestInspectionDate) : "No inspection"}</p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="font-semibold text-slate-900">{row.classification ? row.classification.replaceAll("_", " ") : "--"}</p>
                          <p className="text-xs text-slate-500">{row.status || "--"}</p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="font-semibold text-slate-900">{row.zipCode || "--"}</p>
                          <p className="text-xs text-slate-500">{[row.city, row.county].filter(Boolean).join(", ") || "--"}</p>
                          <p className="mt-1 text-xs text-slate-400">{row.address || "No address"}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredRows.length > 250 ? <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Showing first 250 rows. Refine filters to tighten the segment.</p> : null}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            {selected ? (
              <div className="space-y-5">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Selected Venue</p>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-900">{selected.businessName}</h2>
                  <p className="mt-1 text-sm text-slate-500">{selected.ownerName || "No owner captured"}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <ExplorerCard title="Latest Revenue" value={formatCompactCurrency(selected.comptroller?.latestMonthRevenue)} meta={selected.comptroller?.revenueDataThrough || "No revenue month"} />
                  <ExplorerCard title="Google Rating" value={selected.googlePlaces?.rating != null ? selected.googlePlaces.rating.toFixed(1) : "--"} meta={selected.googlePlaces?.reviewCount != null ? `${selected.googlePlaces.reviewCount} reviews` : "No Google match"} />
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Why it matters</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {buildOpportunityTags(selected).map((tag) => <StatusPill key={tag.label} label={tag.label} tone={tag.tone} />)}
                    {buildOpportunityTags(selected).length === 0 ? <p className="text-sm text-slate-500">No standout signals yet. Try widening your filters or using a preset.</p> : null}
                  </div>
                </div>

                <div className="grid gap-3 text-sm text-slate-600">
                  <DetailRow label="License" value={[selected.licenseType, selected.licenseTypeLabel].filter(Boolean).join(" · ") || "--"} />
                  <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">License Number</span>
                    {selected.licenseNumber
                      ? <a href={`/admin/establishments/${selected.id}`} target="_blank" rel="noopener noreferrer" className="text-right text-sm text-blue-600 hover:underline">{selected.licenseNumber}</a>
                      : <span className="text-right text-sm text-slate-700">--</span>
                    }
                  </div>
                  <DetailRow label="Classification" value={selected.classification ? selected.classification.replaceAll("_", " ") : "--"} />
                  <DetailRow label="Original License Date" value={selected.originalIssueDate ? formatDate(selected.originalIssueDate) : "--"} />
                  <DetailRow label="Expiration Date" value={selected.expirationDate ? formatDate(selected.expirationDate) : "--"} />
                  <DetailRow label="Address" value={[selected.address, selected.city, selected.county, selected.zipCode].filter(Boolean).join(", ") || "--"} />
                  <DetailRow label="Revenue Confidence" value={selected.comptroller?.confidence != null ? `${Math.round(selected.comptroller.confidence * 100)}%` : "--"} />
                  <DetailRow label="Match Method" value={selected.comptroller?.matchMethod || "--"} />
                  <DetailRow label="Phone" value={selected.googlePlaces?.phoneNumber || "No phone found"} />
                  <DetailRow label="Hours" value={formatGoogleHours(selected.googlePlaces?.hours)} />
                  <DetailRow label="Website" value={selected.googlePlaces?.website || "No website found"} />
                  {selected.googlePlaces?.matchedVia === 'mail' && (
                    <DetailRow label="Contact matched via" value="Mailing address (not venue)" />
                  )}
                  {(selected.mailAddress || selected.mailCity) && selected.mailAddress !== selected.address && (
                    <DetailRow label="Mailing Address" value={[selected.mailAddress, selected.mailCity].filter(Boolean).join(", ")} />
                  )}
                  <EmailRow id={selected.id} initialEmail={selected.email} isAdmin={isAdmin} />
                  <DetailRow label="Latest Inspection" value={selected.healthInspection?.latestInspectionDate ? `${selected.healthInspection.latestScore ?? "--"} on ${formatDate(selected.healthInspection.latestInspectionDate)}` : "No inspection data"} />
                  <DetailRow label="Permit Signal" value={selected.buildingPermits?.hasSignificantRecentWork ? `Recent permit value ${formatCurrency(selected.buildingPermits?.largestRecentPermitValue)}` : "No major permit signal"} />
                  {selected.propertyData?.propClass && (
                    <DetailRow label="Property Class" value={`${selected.propertyData.propClass}${selected.propertyData.improvements?.length ? ` · ${selected.propertyData.improvements.join(", ")}` : ""}`} />
                  )}
                  {selected.propertyData?.ownerName && (
                    <DetailRow label="Property Owner" value={selected.propertyData.ownerName} />
                  )}
                  <DetailRow label="First Seen" value={formatDate(selected.firstSeenAt || selected.applicationDate)} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No venues match the current filters.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-2">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{label}</span>
      <span className="text-right text-sm text-slate-700">{value}</span>
    </div>
  );
}

function EmailRow({ id, initialEmail, isAdmin }: { id: string; initialEmail?: string; isAdmin: boolean }) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { doc, updateDoc } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      await updateDoc(doc(db, "establishments", id), { email: email.trim() });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin && !email) return null;

  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-2">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Email</span>
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            className="text-sm border border-slate-300 rounded px-2 py-0.5 text-slate-800 w-48"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
            autoFocus
          />
          <button onClick={save} disabled={saving} className="text-xs text-[var(--brand-accent)] font-semibold">{saving ? "…" : "Save"}</button>
          <button onClick={() => setEditing(false)} className="text-xs text-slate-400">Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-right text-sm text-slate-700">{email || (isAdmin ? <span className="text-slate-400 italic">No email — click to add</span> : "No email found")}</span>
          {isAdmin && <button onClick={() => setEditing(true)} className="text-xs text-slate-400 hover:text-slate-600">Edit</button>}
        </div>
      )}
    </div>
  );
}

function csvEscape(value: unknown) {
  const stringValue = String(value ?? "");
  if (stringValue.includes(",") || stringValue.includes("\n") || stringValue.includes('"')) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function getSortValue(row: ExplorerRow, key: SortKey) {
  if (key === "latestRevenue") return Number(row.comptroller?.latestMonthRevenue ?? -1);
  if (key === "avgRevenue") return Number(row.comptroller?.avgMonthlyRevenue ?? -1);
  if (key === "rating") return Number(row.googlePlaces?.rating ?? -1);
  if (key === "reviews") return Number(row.googlePlaces?.reviewCount ?? -1);
  if (key === "health") return Number(row.healthInspection?.latestScore ?? -1);
  if (key === "applicationDate") return getTimestamp(row.applicationDate || row.firstSeenAt);
  return normalizeName(row.businessName);
}

function buildOpportunityTags(row: ExplorerRow): Array<{ label: string; tone: "neutral" | "good" | "warn" | "hot" }> {
  const tags: Array<{ label: string; tone: "neutral" | "good" | "warn" | "hot" }> = [];
  const revenue = Number(row.comptroller?.latestMonthRevenue ?? 0);
  const rating = Number(row.googlePlaces?.rating ?? 0);
  const hasWebsite = Boolean(row.googlePlaces?.website);
  const pending = String(row.status ?? "").toLowerCase().includes("pending");
  const permits = Boolean(row.buildingPermits?.hasSignificantRecentWork || row.buildingPermits?.recentPermits?.length);

  if (revenue >= 100000) tags.push({ label: "High revenue", tone: "good" });
  if (pending && row.classification === "RENEWAL") tags.push({ label: "Renewal window", tone: "warn" });
  if (revenue >= 50000 && !hasWebsite) tags.push({ label: "No website", tone: "hot" });
  if (revenue >= 50000 && rating > 0 && rating < 4.2) tags.push({ label: "Weak rating", tone: "warn" });
  if (permits) tags.push({ label: "Recent permit activity", tone: "hot" });

  return tags;
}