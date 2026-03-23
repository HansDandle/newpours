"use client";
import { useEffect, useRef, useState } from "react";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import type { EstablishmentClassification, License, PlanStatus, UserPlan } from "@/types";
import { getLicenseTypeInfo, TABC_LICENSE_TYPES } from "@/lib/tabc-license-types";

const DASHBOARD_FILTERS_STORAGE_KEY = "newpours.dashboard.filters.v1";

type PersistedDashboardFilters = {
  counties: string[];
  types: string[];
  zip: string;
  statusFilter: string;
  classificationFilters: string[];
  search: string;
  dateFrom: string;
  dateTo: string;
};

type EstablishmentEnrichment = {
  licenseNumber?: string;
  enrichment?: {
    googlePlaces?: string;
    comptroller?: string;
    healthInspection?: string;
    buildingPermits?: string;
  };
  googlePlaces?: {
    rating?: number;
    reviewCount?: number;
    priceLevel?: number;
    website?: string;
  };
  comptroller?: {
    latestMonthRevenue?: number;
    revenueDataThrough?: string;
  };
  healthInspection?: {
    latestScore?: number;
    latestInspectionDate?: string;
  };
};

function normalizeEstablishmentEnrichment(raw: Record<string, any>): EstablishmentEnrichment {
  return {
    ...raw,
    enrichment: {
      ...(raw.enrichment ?? {}),
      googlePlaces: raw.enrichment?.googlePlaces ?? raw["enrichment.googlePlaces"],
      comptroller: raw.enrichment?.comptroller ?? raw["enrichment.comptroller"],
      healthInspection: raw.enrichment?.healthInspection ?? raw["enrichment.healthInspection"],
      buildingPermits: raw.enrichment?.buildingPermits ?? raw["enrichment.buildingPermits"],
    },
    comptroller: {
      ...(raw.comptroller ?? {}),
      monthlyRecords: raw.comptroller?.monthlyRecords ?? raw["comptroller.monthlyRecords"],
      latestMonthRevenue: raw.comptroller?.latestMonthRevenue ?? raw["comptroller.latestMonthRevenue"],
      avgMonthlyRevenue: raw.comptroller?.avgMonthlyRevenue ?? raw["comptroller.avgMonthlyRevenue"],
      revenueTrend: raw.comptroller?.revenueTrend ?? raw["comptroller.revenueTrend"],
      revenueDataFrom: raw.comptroller?.revenueDataFrom ?? raw["comptroller.revenueDataFrom"],
      revenueDataThrough: raw.comptroller?.revenueDataThrough ?? raw["comptroller.revenueDataThrough"],
      confidence: raw.comptroller?.confidence ?? raw["comptroller.confidence"],
      matchMethod: raw.comptroller?.matchMethod ?? raw["comptroller.matchMethod"],
      taxpayerNumber: raw.comptroller?.taxpayerNumber ?? raw["comptroller.taxpayerNumber"],
    },
  };
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-gray-800 mt-0.5">{value}</p>
    </div>
  );
}

function fmtDate(val?: string | null) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? val : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function joinParts(parts: Array<string | null | undefined>) {
  return parts.map((part) => part?.trim()).filter(Boolean).join(", ");
}

function getSortableTimestamp(val?: string | null) {
  if (!val) return 0;
  const timestamp = new Date(val).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getSourceRecordUrl(license: License) {
  const rawId = license.licenseNumber.includes("-") ? license.licenseNumber.split("-")[1] : "";
  if (!rawId) return null;

  if (license.licenseTypeLabel === "Pending Application") {
    return `https://data.texas.gov/resource/mxm5-tdpj.json?applicationid=${encodeURIComponent(rawId)}`;
  }

  return `https://data.texas.gov/resource/7hf9-qc9f.json?license_id=${encodeURIComponent(rawId)}`;
}

function getTabcSearchUrl() {
  return "https://www.tabc.texas.gov/public-safety/licensing-search/";
}

function isPendingRecord(license: License) {
  if (license.licenseNumber?.startsWith("app-")) return true;
  if (license.licenseNumber?.startsWith("lic-")) return false;
  return license.licenseTypeLabel === "Pending Application";
}

function getEffectiveClassification(license: License): EstablishmentClassification {
  if (license.newEstablishmentClassification) return license.newEstablishmentClassification;

  if (isPendingRecord(license)) {
    return license.primaryLicenseId ? "RENEWAL" : "PENDING_NEW";
  }

  const secondary = (license.secondaryStatus ?? "").toLowerCase();
  if (secondary.includes("renew")) return "RENEWAL";
  if (secondary.includes("transfer") || secondary.includes("change")) return "TRANSFER_OR_CHANGE";

  return "TRULY_NEW";
}

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  renderOption,
  searchable = false,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  renderOption?: (val: string) => string;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const filteredOptions = options.filter((opt) => {
    if (!query) return true;
    const rendered = renderOption ? renderOption(opt) : opt;
    return rendered.toLowerCase().includes(query.toLowerCase());
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const toggle = (val: string) => {
    const next = new Set(selected);
    next.has(val) ? next.delete(val) : next.add(val);
    onChange(next);
  };

  const visibleSelectedCount = filteredOptions.filter((opt) => selected.has(opt)).length;
  const allVisibleSelected = filteredOptions.length > 0 && visibleSelectedCount === filteredOptions.length;

  const toggleAll = () => {
    if (allVisibleSelected) {
      const next = new Set(selected);
      filteredOptions.forEach((opt) => next.delete(opt));
      onChange(next);
    } else {
      const next = new Set(selected);
      filteredOptions.forEach((opt) => next.add(opt));
      onChange(next);
    }
  };

  const isActive = selected.size > 0;
  const singleSelected = selected.size === 1 ? [...selected][0] : null;
  const btnLabel = selected.size === 0
    ? label
    : selected.size === 1 && singleSelected
      ? (renderOption ? renderOption(singleSelected) : singleSelected)
      : `${selected.size} selected`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm bg-white min-w-[140px] justify-between ${
          isActive ? "border-amber-400 text-amber-700 font-semibold" : "border-gray-300 text-gray-700"
        }`}
      >
        <span className="truncate max-w-[160px]">{btnLabel}</span>
        <svg className={`w-4 h-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-64 max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg py-1">
          {searchable && (
            <div className="px-3 pb-2 pt-1 border-b border-gray-100 bg-white sticky top-0">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}...`}
                className="w-full border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
              />
            </div>
          )}
          {filteredOptions.length > 0 && (
            <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-amber-50 cursor-pointer text-sm font-semibold border-b border-gray-100 bg-gray-50">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAll}
                className="accent-amber-500"
              />
              <span>{allVisibleSelected ? "Clear Visible" : "Select Visible"}</span>
            </label>
          )}
          {filteredOptions.map((opt) => (
            <label key={opt} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={() => toggle(opt)}
                className="accent-amber-500"
              />
              <span>{renderOption ? renderOption(opt) : opt}</span>
            </label>
          ))}
          {filteredOptions.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">No options</p>}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [licenses, setLicenses] = useState<License[]>([]);
  const [enrichmentByLicense, setEnrichmentByLicense] = useState<Map<string, EstablishmentEnrichment>>(new Map());
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userPlan, setUserPlan] = useState<UserPlan>("free");
  const [userPlanStatus, setUserPlanStatus] = useState<PlanStatus>("canceled");
  const [counties, setCounties] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [zip, setZip] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [classificationFilters, setClassificationFilters] = useState<Set<string>>(new Set(["TRULY_NEW"]));
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  useEffect(() => {
    const fetchLicenses = async () => {
      try {
        const [licenseSnap, establishmentSnap] = await Promise.all([
          getDocs(collection(db, "licenses")),
          getDocs(collection(db, "establishments")),
        ]);

        const enrichmentMap = new Map<string, EstablishmentEnrichment>();
        for (const d of establishmentSnap.docs) {
          const data = normalizeEstablishmentEnrichment(d.data() as Record<string, any>);
          if (data.licenseNumber) enrichmentMap.set(data.licenseNumber, data);
        }
        setEnrichmentByLicense(enrichmentMap);

        const nextLicenses = licenseSnap.docs
          .map((d) => ({ ...d.data(), licenseNumber: d.id } as License))
          .sort((left, right) => getSortableTimestamp(right.applicationDate) - getSortableTimestamp(left.applicationDate));
        setLicenses(nextLicenses);
      } catch {
      } finally {
        setLoading(false);
      }
    };
    fetchLicenses();
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DASHBOARD_FILTERS_STORAGE_KEY);
      if (!raw) {
        setFiltersHydrated(true);
        return;
      }

      const parsed = JSON.parse(raw) as Partial<PersistedDashboardFilters>;
      if (Array.isArray(parsed.counties)) setCounties(new Set(parsed.counties.filter(Boolean)));
      if (Array.isArray(parsed.types)) setTypes(new Set(parsed.types.filter(Boolean)));
      if (typeof parsed.zip === "string") setZip(parsed.zip);
      if (typeof parsed.statusFilter === "string") setStatusFilter(parsed.statusFilter);
      if (Array.isArray(parsed.classificationFilters)) {
        setClassificationFilters(new Set(parsed.classificationFilters.filter(Boolean)));
      }
      if (typeof parsed.search === "string") setSearch(parsed.search);
      if (typeof parsed.dateFrom === "string") setDateFrom(parsed.dateFrom);
      if (typeof parsed.dateTo === "string") setDateTo(parsed.dateTo);
    } catch {
    } finally {
      setFiltersHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!filtersHydrated) return;

    const payload: PersistedDashboardFilters = {
      counties: [...counties],
      types: [...types],
      zip,
      statusFilter,
      classificationFilters: [...classificationFilters],
      search,
      dateFrom,
      dateTo,
    };

    try {
      localStorage.setItem(DASHBOARD_FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
    }
  }, [counties, types, zip, statusFilter, classificationFilters, search, dateFrom, dateTo, filtersHydrated]);

  useEffect(() => {
    const loadAdminClaim = async () => {
      if (!user) {
        setIsAdmin(false);
        return;
      }

      try {
        const tokenResult = await user.getIdTokenResult(false);
        setIsAdmin(tokenResult.claims.role === "admin");
      } catch {
        setIsAdmin(false);
      }
    };

    loadAdminClaim();
  }, [user]);

  useEffect(() => {
    const fetchUserPlan = async () => {
      if (!user) {
        setUserPlan("free");
        setUserPlanStatus("canceled");
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        const data = userSnap.data() as { plan?: UserPlan; planStatus?: PlanStatus } | undefined;
        setUserPlan(data?.plan ?? "free");
        setUserPlanStatus(data?.planStatus ?? "active");
      } catch {
        setUserPlan("free");
        setUserPlanStatus("canceled");
      }
    };

    fetchUserPlan();
  }, [user]);

  const hasProEnrichment = (userPlan === "pro" || userPlan === "enterprise") && userPlanStatus === "active";
  const hasEnrichmentAccess = hasProEnrichment || isAdmin;

  const allCounties = [...new Set(licenses.map((l) => l.county).filter(Boolean))].sort() as string[];
  const allTypes = [...new Set(licenses.map((l) => l.licenseType).filter(Boolean))].sort() as string[];
  const classificationOptions: string[] = ["TRULY_NEW", "PENDING_NEW", "RENEWAL", "TRANSFER_OR_CHANGE", "UNKNOWN"];

  const filtered = licenses.filter((lic) => {
    const pendingRecord = isPendingRecord(lic);
    const effectiveClassification = getEffectiveClassification(lic);

    if (counties.size > 0 && !counties.has(lic.county ?? "")) return false;
    if (types.size > 0 && !types.has(lic.licenseType ?? "")) return false;
    if (zip && lic.zipCode !== zip) return false;
    if (statusFilter === "pending" && !pendingRecord) return false;
    if (statusFilter === "approved" && pendingRecord) return false;
    if (classificationFilters.size > 0 && !classificationFilters.has(effectiveClassification)) return false;
    if (search) {
      const searchLower = search.toLowerCase();
      const matches =
        lic.businessName?.toLowerCase().includes(searchLower) ||
        lic.phone?.toLowerCase().includes(searchLower) ||
        lic.status?.toLowerCase().includes(searchLower) ||
        lic.address?.toLowerCase().includes(searchLower) ||
        lic.address2?.toLowerCase().includes(searchLower) ||
        lic.city?.toLowerCase().includes(searchLower) ||
        lic.ownerName?.toLowerCase().includes(searchLower) ||
        lic.tradeName?.toLowerCase().includes(searchLower) ||
        lic.legacyClp?.toLowerCase().includes(searchLower) ||
        lic.licenseNumber?.toLowerCase().includes(searchLower);
      if (!matches) return false;
    }
    if (dateFrom || dateTo) {
      const d = lic.applicationDate ? new Date(lic.applicationDate).getTime() : null;
      if (d === null) return false;
      if (dateFrom && d < new Date(dateFrom).getTime()) return false;
      if (dateTo && d > new Date(dateTo + "T23:59:59").getTime()) return false;
    }
    return true;
  });

  const handleExport = () => {
    if (!filtered.length) return;
    const header = "licenseNumber,businessName,address,city,county,licenseType,status,filedDate\n";
    const rows = filtered.map((l) =>
      [l.licenseNumber, l.businessName, l.address, l.city, l.county, l.licenseType, l.status, l.applicationDate].join(",")
    );
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "licenses.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1a2233]">License Alerts</h1>
          {!loading && licenses.length > 0 && (
            <p className="text-sm text-gray-400 mt-0.5">{filtered.length} of {licenses.length} licenses</p>
          )}
        </div>
        <button
          onClick={handleExport}
          disabled={!hasEnrichmentAccess}
          title={hasEnrichmentAccess ? "Export filtered rows to CSV" : "CSV exports are available on Pro and Enterprise plans."}
          className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {hasEnrichmentAccess ? "Export CSV" : "Export CSV (Pro+)"}
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-8">
        <MultiSelect
          label="All Counties"
          options={allCounties}
          selected={counties}
          onChange={setCounties}
          searchable
        />

        <MultiSelect
          label="All License Types"
          options={allTypes}
          selected={types}
          onChange={setTypes}
          renderOption={(code) => {
            const info = TABC_LICENSE_TYPES[code];
            return info ? `${code} - ${info.short}` : code;
          }}
        />

        <select
          className="border rounded-lg px-3 py-2 text-sm bg-white"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending Applications</option>
          <option value="approved">Issued / Approved</option>
        </select>

        <MultiSelect
          label="Classifications"
          options={classificationOptions}
          selected={classificationFilters}
          onChange={setClassificationFilters}
          renderOption={(val) => val.replaceAll("_", " ")}
        />

        <input
          type="text"
          placeholder="Search (business name, expired, surrendered, etc.)"
          className="border rounded-lg px-3 py-2 text-sm bg-white"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <input
          type="text"
          placeholder="Zip code"
          className="border rounded-lg px-3 py-2 text-sm w-28"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
        />

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">From</label>
          <input
            type="date"
            className="border rounded-lg px-3 py-2 text-sm bg-white"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">To</label>
          <input
            type="date"
            className="border rounded-lg px-3 py-2 text-sm bg-white"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>

        {(counties.size > 0 || types.size > 0 || zip || statusFilter || classificationFilters.size > 0 || search || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setCounties(new Set());
              setTypes(new Set());
              setZip("");
              setStatusFilter("");
              setClassificationFilters(new Set(["TRULY_NEW"]));
              setSearch("");
              setDateFrom("");
              setDateTo("");
            }}
            className="text-xs text-gray-400 hover:text-gray-700 underline px-2"
          >
            Clear filters
          </button>
        )}
      </div>

      {loading && (
        <p className="text-gray-400 text-sm animate-pulse">Loading license data...</p>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">[ ]</p>
          <p className="font-semibold">No licenses found yet.</p>
          <p className="text-sm mt-1">New filings will appear here after the daily ingest runs.</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {filtered.map((lic) => {
          const isOpen = expanded.has(lic.licenseNumber);
          const effectiveClassification = getEffectiveClassification(lic);
          const typeInfo = getLicenseTypeInfo(lic.licenseType);
          const daysAgo = lic.applicationDate
            ? Math.floor((Date.now() - new Date(lic.applicationDate).getTime()) / 86400000)
            : null;
          const statusColor =
            lic.status === "Active" ? "text-green-600" :
            lic.status === "Expired" ? "text-red-500" : "text-yellow-600";
          return (
            <div key={lic.licenseNumber} className="border border-gray-200 rounded-xl bg-white shadow-sm">
              <button
                onClick={() => toggle(lic.licenseNumber)}
                className="w-full text-left px-6 py-4 flex items-start justify-between gap-4 hover:bg-gray-50 rounded-xl transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold text-[#1a2233] truncate">{lic.businessName || "-"}</h2>
                    {lic.isNew && (
                      <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">NEW</span>
                    )}
                    {effectiveClassification !== "UNKNOWN" && (
                      <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                        {effectiveClassification.replaceAll("_", " ")}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-500 text-sm mt-0.5 truncate">
                    {joinParts([lic.address, lic.address2, lic.city, lic.county])}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                  {lic.licenseType && (
                    <span
                      className="bg-amber-100 text-amber-800 text-xs font-semibold px-2 py-0.5 rounded-full cursor-help"
                      title={typeInfo ? `${typeInfo.short} - ${typeInfo.description}` : lic.licenseType}
                    >
                      {lic.licenseType}{typeInfo ? ` · ${typeInfo.short}` : ""}
                    </span>
                  )}
                  {lic.status && (
                    <span className={`text-xs font-semibold ${statusColor}`}>{lic.status}</span>
                  )}
                  {daysAgo !== null && (
                    <span className="text-xs text-gray-400">{daysAgo}d ago</span>
                  )}
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {isOpen && (() => {
                const TEMP_TYPES = new Set(["NT", "ET", "TR", "NB", "NE", "NP"]);
                const isTemp = TEMP_TYPES.has(lic.licenseType?.toUpperCase() ?? "");
                const isPendingApplication = lic.licenseTypeLabel === "Pending Application";
                const physAddr = joinParts([lic.address, lic.address2, lic.city, "TX", lic.zipCode]);
                const mailAddr = joinParts([lic.mailAddress, lic.mailAddress2, lic.mailCity, "TX", lic.mailZip]);
                const showMail = mailAddr && mailAddr !== physAddr;
                const sourceRecordUrl = getSourceRecordUrl(lic);
                const enrichment = enrichmentByLicense.get(lic.licenseNumber);
                const googleRating = enrichment?.googlePlaces?.rating;
                const reviewCount = enrichment?.googlePlaces?.reviewCount;
                const latestRevenue = enrichment?.comptroller?.latestMonthRevenue;
                const revenueMonth = enrichment?.comptroller?.revenueDataThrough;
                const healthScore = enrichment?.healthInspection?.latestScore;
                return (
                  <div className="border-t border-gray-100 px-6 py-5 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
                    <Detail label="Owner / Applicant" value={lic.ownerName} />
                    <Detail label="Business / Trade Name" value={lic.businessName} />
                    <Detail label="License #" value={lic.licenseNumber} />
                    <Detail label="Legacy License #" value={lic.legacyClp} />
                    <Detail label="Phone" value={lic.phone} />
                    <Detail label="License Type" value={
                      lic.licenseType
                        ? typeInfo
                          ? `${lic.licenseType} - ${typeInfo.short}`
                          : lic.licenseType
                        : lic.licenseTypeLabel
                    } />
                    <Detail label="Secondary Status" value={lic.secondaryStatus} />
                    {typeInfo && (
                      <div className="col-span-2 sm:col-span-3">
                        <p className="text-xs text-gray-400 uppercase tracking-wide">What this license allows</p>
                        <p className="text-sm text-gray-600 mt-0.5">{typeInfo.description}</p>
                      </div>
                    )}
                    <Detail label="Status" value={lic.status} />
                    <Detail label="Classification" value={effectiveClassification.replaceAll("_", " ")} />
                    <Detail label="Classification Confidence" value={lic.newEstablishmentConfidence != null ? `${Math.round(lic.newEstablishmentConfidence * 100)}%` : null} />
                    <Detail label="Classification Reason" value={lic.newEstablishmentReason} />
                    <div className="col-span-2 sm:col-span-3 mt-1 rounded-lg border border-gray-200 p-3 bg-gray-50">
                      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Enrichment Insights</p>
                      {!hasEnrichmentAccess ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm text-gray-600">Google, Comptroller, and Health enrichment are available on Pro and Enterprise plans.</p>
                          <a
                            href="/pricing"
                            className="text-sm font-semibold text-amber-700 underline hover:text-amber-800"
                          >
                            Upgrade to unlock
                          </a>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className="rounded bg-white border border-gray-200 p-3">
                            <p className="text-xs text-gray-500">Google Places</p>
                            <p className="text-sm text-gray-800 mt-1">
                              {googleRating != null
                                ? `${googleRating.toFixed(1)} stars${reviewCount != null ? ` (${reviewCount} reviews)` : ""}`
                                : "No Google match yet"}
                            </p>
                          </div>
                          <div className="rounded bg-white border border-gray-200 p-3">
                            <p className="text-xs text-gray-500">Comptroller Revenue</p>
                            <p className="text-sm text-gray-800 mt-1">
                              {latestRevenue != null
                                ? `$${latestRevenue.toLocaleString()}${revenueMonth ? ` in ${revenueMonth}` : ""}`
                                : "No revenue match yet"}
                            </p>
                          </div>
                          <div className="rounded bg-white border border-gray-200 p-3">
                            <p className="text-xs text-gray-500">Health Inspection</p>
                            <p className="text-sm text-gray-800 mt-1">
                              {healthScore != null ? `Latest score: ${healthScore}` : "No inspection match yet"}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                    <Detail label="Subordinate License #" value={lic.subordinateLicenseId} />
                    <Detail label="Primary License #" value={lic.primaryLicenseId} />
                    <Detail label="Master File ID" value={lic.masterFileId} />
                    <Detail label="Wine Percent" value={lic.winePercent} />
                    <Detail label={isTemp ? "Event Location" : "Address"} value={physAddr} />
                    <Detail label="County" value={lic.county} />
                    {showMail && (
                      <Detail label="Mailing Address" value={mailAddr} />
                    )}
                    <Detail label="Subordinate Licenses" value={lic.subordinates} />
                    <Detail label="Status Change Date" value={fmtDate(lic.statusChangeDate)} />
                    {isTemp && !isPendingApplication ? (
                      <>
                        <Detail label="Event Start" value={fmtDate(lic.effectiveDate)} />
                        <Detail label="Event End" value={fmtDate(lic.expirationDate)} />
                      </>
                    ) : isTemp && isPendingApplication ? (
                      <>
                        <Detail label="Submission Date" value={fmtDate(lic.applicationDate)} />
                        <Detail label="Event Dates" value="Not provided in TABC pending-application data" />
                      </>
                    ) : (
                      <>
                        <Detail label="Issue / Application Date" value={fmtDate(lic.applicationDate)} />
                        <Detail label="Expiration Date" value={fmtDate(lic.expirationDate)} />
                      </>
                    )}
                    <div className="col-span-2 sm:col-span-3 flex flex-wrap gap-3 pt-1">
                      {sourceRecordUrl && (
                        <a
                          href={sourceRecordUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-medium text-amber-700 underline hover:text-amber-800"
                        >
                          Open Texas source record
                        </a>
                      )}
                      <a
                        href={getTabcSearchUrl()}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-gray-600 underline hover:text-gray-800"
                      >
                        Open TABC licensing search
                      </a>
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </section>
  );
}
