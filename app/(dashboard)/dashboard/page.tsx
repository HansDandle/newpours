"use client";
import { useEffect, useRef, useState } from "react";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import type { EstablishmentClassification, License, PlanStatus, UserPlan } from "@/types";
import { getLicenseTypeInfo, TABC_LICENSE_TYPES } from "@/lib/tabc-license-types";

const DASHBOARD_FILTERS_STORAGE_KEY = "newpours.dashboard.filters.v1";

const TEXAS_COUNTIES = [
  "Anderson","Andrews","Angelina","Aransas","Archer","Armstrong","Atascosa","Austin","Bailey","Bandera",
  "Bastrop","Baylor","Bee","Bell","Bexar","Blanco","Borden","Bosque","Bowie","Brazoria","Brazos",
  "Brewster","Briscoe","Brooks","Brown","Burleson","Burnet","Caldwell","Calhoun","Callahan","Cameron",
  "Camp","Carson","Cass","Castro","Chambers","Cherokee","Childress","Clay","Cochran","Coke","Coleman",
  "Collin","Collingsworth","Colorado","Comal","Comanche","Concho","Cooke","Corpus Christi","Coryell",
  "Cottle","Crane","Crockett","Crosby","Culberson","Dallam","Dallas","Dawson","Deaf Smith","Delta",
  "Denton","DeWitt","Dickens","Dimmit","Donley","Duval","Eastland","Ector","Edwards","El Paso","Ellis",
  "Erath","Falls","Fannin","Fayette","Fisher","Floyd","Foard","Fort Bend","Franklin","Freestone","Frio",
  "Gaines","Galveston","Garza","Gillespie","Glasscock","Goliad","Gonzales","Gray","Grayson","Gregg",
  "Grimes","Guadalupe","Hale","Hall","Hamilton","Hansford","Hardeman","Hardin","Harris","Harrison",
  "Hartley","Haskell","Hays","Hemphill","Henderson","Hidalgo","Hill","Hockley","Hood","Hopkins",
  "Houston","Howard","Hudspeth","Hunt","Hutchinson","Irion","Jack","Jackson","Jasper","Jeff Davis",
  "Jefferson","Jim Hogg","Jim Wells","Johnson","Jones","Karnes","Kaufman","Kendall","Kenedy","Kent",
  "Kerr","Kimble","King","Kinney","Kleberg","Knox","Lamar","Lamb","Lampasas","La Salle","Lavaca",
  "Lee","Leon","Liberty","Limestone","Lipscomb","Live Oak","Llano","Loving","Lubbock","Lynn",
  "Madison","Marion","Martin","Mason","Matagorda","Maverick","McCulloch","McLennan","McMullen",
  "Medina","Menard","Midland","Milam","Mills","Mitchell","Montague","Montgomery","Moore","Morris",
  "Motley","Nacogdoches","Navarro","Newton","Nolan","Nueces","Ochiltree","Oldham","Orange","Palo Pinto",
  "Panola","Parker","Parmer","Pecos","Polk","Potter","Presidio","Rains","Randall","Reagan","Real",
  "Red River","Reeves","Refugio","Roberts","Robertson","Rockwall","Runnels","Rusk","Sabine",
  "San Augustine","San Jacinto","San Patricio","San Saba","Schleicher","Scurry","Shackelford",
  "Shelby","Sherman","Smith","Somervell","Starr","Stephens","Sterling","Stonewall","Sutton","Swisher",
  "Tarrant","Taylor","Terrell","Terry","Throckmorton","Titus","Tom Green","Travis","Trinity","Tyler",
  "Upshur","Upton","Uvalde","Val Verde","Van Zandt","Victoria","Walker","Waller","Ward","Washington",
  "Webb","Wharton","Wheeler","Wichita","Wilbarger","Willacy","Williamson","Wilson","Winkler","Wise",
  "Wood","Yoakum","Young","Zapata","Zavala",
];

type PersistedDashboardFilters = {
  counties: string[];
  types: string[];
  zip: string;
  statusFilter: string;
  classificationFilters: string[];
  search: string;
  dateFrom: string;
  dateTo: string;
  hideExpired: boolean;
};

// Convert a Firestore Timestamp (or plain seconds object) to a JS Date
function fsTimestampToDate(val: any): Date | null {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  if (val.seconds != null) return new Date(val.seconds * 1000);
  return null;
}

const DEAD_STATUS_KEYWORDS = ["expired", "surrendered", "cancelled", "revoked"];
function isClosedLicense(lic: License): boolean {
  const st = (lic.status ?? "").toLowerCase();
  const sec = (lic.secondaryStatus ?? "").toLowerCase();
  return DEAD_STATUS_KEYWORDS.some((kw) => st.includes(kw) || sec.includes(kw));
}

// Hard filter: expiration date more than 90 days in the past — never show in alert feed
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
function isStaleExpired(lic: License): boolean {
  if (!lic.expirationDate) return false;
  const exp = new Date(lic.expirationDate).getTime();
  if (isNaN(exp)) return false;
  return Date.now() - exp > NINETY_DAYS_MS;
}

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
  maxSelected,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  renderOption?: (val: string) => string;
  searchable?: boolean;
  maxSelected?: number;
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
    if (next.has(val)) {
      next.delete(val);
    } else {
      if (!maxSelected || next.size < maxSelected) {
        next.add(val);
      }
    }
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
          isActive ? "border-[var(--brand-accent)] text-accent font-semibold" : "border-gray-300 text-gray-700"
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
                className="w-full border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-accent)]"
              />
            </div>
          )}
          {filteredOptions.length > 0 && (
              <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-[rgba(200,169,108,0.06)] cursor-pointer text-sm font-semibold border-b border-gray-100 bg-gray-50">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAll}
                className="accent-[var(--brand-accent)]"
              />
              <span>{allVisibleSelected ? "Clear Visible" : "Select Visible"}</span>
            </label>
          )}
          {filteredOptions.map((opt) => {
            const disabled = !selected.has(opt) && maxSelected && selected.size >= maxSelected;
            return (
              <label key={opt} className={`flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected.has(opt)}
                  onChange={() => toggle(opt)}
                  className="accent-[var(--brand-accent)]"
                  disabled={disabled}
                />
                <span>{renderOption ? renderOption(opt) : opt}</span>
              </label>
            );
          })}
          {filteredOptions.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">No options</p>}
        </div>
      )}
    </div>
  );
}

const EST_CACHE_KEY = "newpours.establishments.cache.v1";
const EST_CACHE_TTL = 5 * 60 * 1000;

function getCachedEstablishments(): Record<string, any>[] | null {
  try {
    const raw = sessionStorage.getItem(EST_CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw) as { ts: number; data: Record<string, any>[] };
    if (Date.now() - ts > EST_CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function setCachedEstablishments(data: Record<string, any>[]) {
  try { sessionStorage.setItem(EST_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch { }
}

export default function DashboardPage() {
  const { user, userPlan, userPlanStatus, isAdmin } = useAuth();
  const [licenses, setLicenses] = useState<License[]>([]);
  const [enrichmentByLicense, setEnrichmentByLicense] = useState<Map<string, EstablishmentEnrichment>>(new Map());
  const [loading, setLoading] = useState(true);
  const [counties, setCounties] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [zip, setZip] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [classificationFilters, setClassificationFilters] = useState<Set<string>>(new Set(["RECENTLY_GRANTED"]));
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [hideExpired, setHideExpired] = useState(true);
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fetchError, setFetchError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Stable key for useEffect dependency — only re-fetch when the county selection changes
  const countiesKey = [...counties].sort().join(",");

  useEffect(() => {
    if (!user || !filtersHydrated) {
      setLoading(false);
      return;
    }
    if (counties.size === 0) {
      // No county selected — clear any stale results without hitting Firestore
      setLicenses([]);
      setEnrichmentByLicense(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    setFetchError(null);
    const fetchLicenses = async () => {
      try {
        // Fetch establishments from sessionStorage cache when available (5-min TTL)
        const enrichmentMap = new Map<string, EstablishmentEnrichment>();
        let estDocs = getCachedEstablishments();
        if (!estDocs) {
          const estSnap = await getDocs(collection(db, "establishments"));
          estDocs = estSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));
          setCachedEstablishments(estDocs);
        }
        for (const raw of estDocs) {
          const data = normalizeEstablishmentEnrichment(raw as Record<string, any>);
          if (data.licenseNumber) enrichmentMap.set(data.licenseNumber, data);
        }
        setEnrichmentByLicense(enrichmentMap);

        // Fetch 2000 most recently *filed* licenses (by TABC application date).
        // County filtering is client-side, so we need enough records to span all counties.
        const licenseSnap = await getDocs(
          query(collection(db, "licenses"), orderBy("applicationDate", "desc"), limit(2000))
        );
        const nextLicenses = licenseSnap.docs
          .map((d) => ({ ...d.data(), licenseNumber: d.id } as License));
        setLicenses(nextLicenses);
      } catch (err) {
        const msg = (err as Error)?.message ?? "Unknown error";
        setFetchError(msg);
      } finally {
        setLoading(false);
      }
    };
    fetchLicenses();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filtersHydrated, countiesKey]);

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
      if (typeof parsed.hideExpired === "boolean") setHideExpired(parsed.hideExpired);
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
      hideExpired,
    };

    try {
      localStorage.setItem(DASHBOARD_FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
    }
  }, [counties, types, zip, statusFilter, classificationFilters, search, dateFrom, dateTo, hideExpired, filtersHydrated]);

  // userPlan, userPlanStatus, and isAdmin are provided by AuthProvider — no separate reads needed here.

  const hasProEnrichment = (userPlan === "pro" || userPlan === "enterprise") && userPlanStatus === "active";
  const hasEnrichmentAccess = hasProEnrichment || isAdmin;

  // Static Texas county list so the county picker is always populated without a Firestore fetch
  const allCounties = TEXAS_COUNTIES;
  const allTypes = [...new Set(licenses.map((l) => l.licenseType).filter(Boolean))].sort() as string[];
  const classificationOptions: string[] = ["RECENTLY_GRANTED", "PENDING_NEW", "REOPENED", "RENEWAL", "TRANSFER_OR_CHANGE", "UNKNOWN"];

  const CLASSIFICATION_LABELS: Record<string, string> = {
    RECENTLY_GRANTED: "New to Market (First-Time Licensed)",
    TRULY_NEW: "First-Time Issued",
    PENDING_NEW: "New Application (Pending)",
    REOPENED: "Reopened Location",
    RENEWAL: "Renewal",
    TRANSFER_OR_CHANGE: "Transfer / Change",
    UNKNOWN: "Unknown",
  };

  // Per-user "new" threshold: records ingested after this user's account was created
  const userCreatedAt = user?.metadata?.creationTime
    ? new Date(user.metadata.creationTime).getTime()
    : 0;

  // Most recent TABC filing date in the fetched set — shows how current the data is
  const lastIngestDate = licenses.length > 0 && licenses[0].applicationDate
    ? new Date(licenses[0].applicationDate)
    : null;

  const filtered = licenses.filter((lic) => {
    const pendingRecord = isPendingRecord(lic);
    const effectiveClassification = getEffectiveClassification(lic);

    // Always hide records whose license expired more than 90 days ago
    if (isStaleExpired(lic)) return false;
    // Toggle: hide status-based closed records
    if (hideExpired && isClosedLicense(lic)) return false;
    if (counties.size > 0 && !counties.has(lic.county ?? "")) return false;
    if (types.size > 0 && !types.has(lic.licenseType ?? "")) return false;
    if (zip && lic.zipCode !== zip) return false;
    if (statusFilter === "received" && (lic.status ?? "").toLowerCase() !== "received") return false;
    if (statusFilter === "pending" && (!pendingRecord || (lic.status ?? "").toLowerCase() === "received")) return false;
    if (statusFilter === "approved" && pendingRecord) return false;
    if (classificationFilters.size > 0) {
      // "New to Market": prefer originalIssueDate for the 90-day window;
      // fall back to applicationDate + classification for records where TABC
      // did not return original_issue_date.
      const matchesGranted = classificationFilters.has("RECENTLY_GRANTED") && (() => {
        const rawDate = (lic.originalIssueDate as string | null | undefined)
          ?? ((
              lic.newEstablishmentClassification === "TRULY_NEW" ||
              lic.newEstablishmentClassification === "REOPENED"
            ) ? (lic.applicationDate as string | null | undefined) : null);
        if (!rawDate) return false;
        return Date.now() - new Date(rawDate).getTime() <= NINETY_DAYS_MS;
      })();
      const matchesDirect = classificationFilters.has(effectiveClassification);
      if (!matchesGranted && !matchesDirect) return false;
    }
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

  // Sort by TABC application/issue date, newest first
  const sorted = [...filtered].sort((a, b) => {
    const ta = a.applicationDate ? new Date(a.applicationDate).getTime() : 0;
    const tb = b.applicationDate ? new Date(b.applicationDate).getTime() : 0;
    return tb - ta;
  });

  const handleExport = () => {
    if (!sorted.length) return;
    const header = "licenseNumber,businessName,address,city,county,licenseType,status,filedDate\n";
    const rows = sorted.map((l) =>
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
          <h1 className="text-2xl font-bold text-on-light">License Alerts</h1>
          {!loading && licenses.length > 0 && (
            <p className="text-sm text-gray-400 mt-0.5">
              {sorted.length} of {licenses.length} licenses
              {lastIngestDate && (
                <span className="ml-2 text-gray-300">
                  · updated {Math.floor((Date.now() - lastIngestDate.getTime()) / 3600000) < 24
                    ? `${Math.floor((Date.now() - lastIngestDate.getTime()) / 3600000)}h ago`
                    : `${Math.floor((Date.now() - lastIngestDate.getTime()) / 86400000)}d ago`
                  }
                </span>
              )}
            </p>
          )}
        </div>
        <button
          onClick={handleExport}
          disabled={!hasEnrichmentAccess}
          title={hasEnrichmentAccess ? "Export filtered rows to CSV" : "CSV exports are available on Pro and Enterprise plans."}
          className="btn-accent px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {hasEnrichmentAccess ? "Export CSV" : "Export CSV (Pro+)"}
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-8 items-center">
        <div className={`flex items-center gap-2 ${counties.size === 0 ? "ring-2 ring-[var(--brand-accent)] rounded-lg" : ""}`}>
          {counties.size === 0 && (
            <span className="text-xs font-semibold accent whitespace-nowrap pl-1">Start here →</span>
          )}
          <MultiSelect
            label="Select County"
            options={allCounties}
            selected={counties}
            onChange={setCounties}
            searchable
            maxSelected={3}
          />
        </div>

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
          <option value="received">Submitted – Not Yet In Review</option>
          <option value="pending">In Review (Pending)</option>
          <option value="approved">Issued / Approved</option>
        </select>

        <MultiSelect
          label="Classifications"
          options={classificationOptions}
          selected={classificationFilters}
          onChange={setClassificationFilters}
          renderOption={(val) => CLASSIFICATION_LABELS[val] ?? val.replaceAll("_", " ")}
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

        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={hideExpired}
            onChange={(e) => setHideExpired(e.target.checked)}
            className="accent-[var(--brand-accent)]"
          />
          Hide closed
        </label>

        {(counties.size > 0 || types.size > 0 || zip || statusFilter || classificationFilters.size > 0 || search || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setCounties(new Set());
              setTypes(new Set());
              setZip("");
              setStatusFilter("");
              setClassificationFilters(new Set(["RECENTLY_GRANTED"]));
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

      {!loading && fetchError && (
        <div className="text-center py-16 text-red-500">
          <p className="font-semibold mb-1">Failed to load license data</p>
          <p className="text-sm text-red-400">{fetchError}</p>
          <p className="text-xs text-gray-400 mt-3">Check the browser console for details, or try refreshing the page.</p>
        </div>
      )}

      {!loading && !fetchError && counties.size === 0 && (
        <div className="text-center py-24 text-gray-400">
          <p className="text-4xl mb-4">📍</p>
          <p className="font-semibold text-gray-600 text-lg">Choose a county to load your feed</p>
          <p className="text-sm mt-2">Select one or more counties above to see TABC license alerts for your territory.</p>
        </div>
      )}

      {!loading && !fetchError && counties.size > 0 && sorted.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">[ ]</p>
          <p className="font-semibold">No licenses found for the selected filters.</p>
          <p className="text-sm mt-1">Try removing a filter or expanding your county selection.</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {sorted.map((lic) => {
          const isOpen = expanded.has(lic.licenseNumber);
          const effectiveClassification = getEffectiveClassification(lic);
          const typeInfo = getLicenseTypeInfo(lic.licenseType);
          const firstSeenDate = fsTimestampToDate(lic.firstSeenAt);
          const daysAgo = lic.applicationDate
            ? Math.floor((Date.now() - new Date(lic.applicationDate).getTime()) / 86400000)
            : null;
          const isNewForUser = firstSeenDate != null
            && firstSeenDate.getTime() > userCreatedAt
            && (effectiveClassification === "TRULY_NEW" || effectiveClassification === "REOPENED" || effectiveClassification === "PENDING_NEW");
          const isClosed = isClosedLicense(lic);
          // Determine status badge
          let statusBadge = null;
          if (lic.licenseTypeLabel === "Pending Application") {
            statusBadge = <span className="bg-yellow-100 text-yellow-700 text-xs font-bold px-2 py-0.5 rounded-full mr-1">Pending</span>;
          } else if (lic.status === "Active") {
            statusBadge = <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full mr-1">Issued</span>;
          } else if (isClosed) {
            statusBadge = <span className="bg-red-50 text-red-400 text-xs font-semibold px-2 py-0.5 rounded-full mr-1">Closed</span>;
          }
          return (
            <div key={lic.licenseNumber} className="border border-gray-200 rounded-xl bg-white shadow-sm">
              <button
                onClick={() => toggle(lic.licenseNumber)}
                className="w-full text-left px-6 py-4 flex items-start justify-between gap-4 hover:bg-gray-50 rounded-xl transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {statusBadge}
                    {lic.licenseType && (
                      <span className="bg-blue-50 text-blue-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                        {lic.licenseType}
                        {typeInfo && ` - ${typeInfo.short}`}
                      </span>
                    )}
                    {isNewForUser && (
                      <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">NEW</span>
                    )}
                  </div>
                  <h2 className="text-base font-semibold text-on-light truncate mb-0.5">{lic.businessName || lic.ownerName || "-"}</h2>
                  <p className="text-gray-500 text-sm truncate">
                    {joinParts([lic.address, lic.address2, lic.city, lic.county])}
                  </p>
                  <div className="flex flex-wrap gap-4 mt-1 text-xs text-gray-600">
                    <span>Owner: <span className="font-medium text-gray-800">{lic.ownerName || "-"}</span></span>
                    {lic.phone && <span>Phone: <span className="font-medium text-gray-800">{lic.phone}</span></span>}
                    {daysAgo !== null && <span>Filed: <span className="font-medium text-gray-800">{daysAgo} days ago</span></span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
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
                    <Detail label="Classification" value={CLASSIFICATION_LABELS[effectiveClassification] ?? effectiveClassification.replaceAll("_", " ")} />
                    <Detail label="Classification Confidence" value={lic.newEstablishmentConfidence != null ? `${Math.round(lic.newEstablishmentConfidence * 100)}%` : null} />
                    <Detail label="Classification Reason" value={lic.newEstablishmentReason} />
                    <div className="col-span-2 sm:col-span-3 mt-1 rounded-lg border border-gray-200 p-3 bg-gray-50">
                      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Enrichment Insights</p>
                      {!hasEnrichmentAccess ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm text-gray-600">Google, Comptroller, and Health enrichment are available on Pro and Enterprise plans.</p>
                          <a
                            href="/pricing"
                            className="text-sm font-semibold accent underline hover:opacity-90"
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
                    {!isPendingApplication && lic.originalIssueDate && lic.originalIssueDate !== lic.applicationDate && (
                      <Detail label="Original Issue Date" value={fmtDate(lic.originalIssueDate)} />
                    )}
                    <Detail label="Expiration Date" value={fmtDate(lic.expirationDate)} />
                      </>
                    )}
                    <div className="col-span-2 sm:col-span-3 flex flex-wrap gap-3 pt-1">
                      {sourceRecordUrl && (
                        <a
                          href={sourceRecordUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-medium accent underline hover:opacity-90"
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
