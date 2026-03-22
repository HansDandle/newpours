"use client";
import { useEffect, useRef, useState } from "react";
import { collection, query, orderBy, limit, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { License } from "@/types";
import { getLicenseTypeInfo, TABC_LICENSE_TYPES } from "@/lib/tabc-license-types";

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

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  renderOption,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  renderOption?: (val: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (val: string) => {
    const next = new Set(selected);
    next.has(val) ? next.delete(val) : next.add(val);
    onChange(next);
  };

  const toggleAll = () => {
    // If all selected, clear all. Otherwise, select all.
    if (selected.size === options.length) {
      onChange(new Set());
    } else {
      onChange(new Set(options));
    }
  };

  const isActive = selected.size > 0;
  const allSelected = selected.size === options.length && options.length > 0;
  const btnLabel = selected.size === 0 ? label : selected.size === 1 ? [...selected][0] : `${selected.size} selected`;

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
          {/* Select All / Clear All */}
          {options.length > 0 && (
            <>
              <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-amber-50 cursor-pointer text-sm font-semibold border-b border-gray-100 bg-gray-50">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-amber-500"
                />
                <span>{allSelected ? 'Clear All' : 'Select All'}</span>
              </label>
            </>
          )}
          {options.map((opt) => (
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
          {options.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">No options</p>}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading] = useState(true);
  const [counties, setCounties] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [zip, setZip] = useState("");
  const [statusFilter, setStatusFilter] = useState(""); // "pending" | "approved" | ""
  const [search, setSearch] = useState(""); // general search across name, status, address
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
        const q = query(collection(db, "licenses"), orderBy("applicationDate", "desc"), limit(500));
        const snap = await getDocs(q);
        setLicenses(snap.docs.map((d) => ({ licenseNumber: d.id, ...d.data() } as License)));
      } catch {
        // Firestore not yet populated — show empty state
      } finally {
        setLoading(false);
      }
    };
    fetchLicenses();
  }, []);

  const allCounties = [...new Set(licenses.map((l) => l.county).filter(Boolean))].sort() as string[];
  const allTypes = [...new Set(licenses.map((l) => l.licenseType).filter(Boolean))].sort() as string[];

  const filtered = licenses.filter((lic) => {
    if (counties.size > 0 && !counties.has(lic.county ?? "")) return false;
    if (types.size > 0 && !types.has(lic.licenseType ?? "")) return false;
    if (zip && lic.zipCode !== zip) return false;
    if (statusFilter === "pending" && lic.licenseTypeLabel !== "Pending Application") return false;
    if (statusFilter === "approved" && lic.licenseTypeLabel === "Pending Application") return false;
    if (search) {
      const searchLower = search.toLowerCase();
      const matches =
        lic.businessName?.toLowerCase().includes(searchLower) ||
        lic.status?.toLowerCase().includes(searchLower) ||
        lic.address?.toLowerCase().includes(searchLower) ||
        lic.city?.toLowerCase().includes(searchLower) ||
        lic.ownerName?.toLowerCase().includes(searchLower) ||
        lic.tradeName?.toLowerCase().includes(searchLower) ||
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
          className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-400 transition"
        >
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-8">
        <MultiSelect
          label="All Counties"
          options={allCounties}
          selected={counties}
          onChange={setCounties}
        />

        <MultiSelect
          label="All License Types"
          options={allTypes}
          selected={types}
          onChange={setTypes}
          renderOption={(code) => {
            const info = TABC_LICENSE_TYPES[code];
            return info ? `${code} — ${info.short}` : code;
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

        {(counties.size > 0 || types.size > 0 || zip || statusFilter || search || dateFrom || dateTo) && (
          <button
            onClick={() => { setCounties(new Set()); setTypes(new Set()); setZip(""); setStatusFilter(""); setSearch(""); setDateFrom(""); setDateTo(""); }}
            className="text-xs text-gray-400 hover:text-gray-700 underline px-2"
          >
            Clear filters
          </button>
        )}
      </div>

      {loading && (
        <p className="text-gray-400 text-sm animate-pulse">Loading license data…</p>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">📋</p>
          <p className="font-semibold">No licenses found yet.</p>
          <p className="text-sm mt-1">New filings will appear here after the daily ingest runs.</p>
        </div>
      )}

      {/* License Cards */}
      <div className="flex flex-col gap-3">
        {filtered.map((lic) => {
          const isOpen = expanded.has(lic.licenseNumber);
          const typeInfo = getLicenseTypeInfo(lic.licenseType);
          const daysAgo = lic.applicationDate
            ? Math.floor((Date.now() - new Date(lic.applicationDate).getTime()) / 86400000)
            : null;
          const statusColor =
            lic.status === "Active" ? "text-green-600" :
            lic.status === "Expired" ? "text-red-500" : "text-yellow-600";
          return (
            <div key={lic.licenseNumber} className="border border-gray-200 rounded-xl bg-white shadow-sm">
              {/* Always-visible header row */}
              <button
                onClick={() => toggle(lic.licenseNumber)}
                className="w-full text-left px-6 py-4 flex items-start justify-between gap-4 hover:bg-gray-50 rounded-xl transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold text-[#1a2233] truncate">{lic.businessName || "—"}</h2>
                    {lic.isNew && (
                      <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">NEW</span>
                    )}
                  </div>
                  <p className="text-gray-500 text-sm mt-0.5 truncate">
                    {[lic.address, lic.city, lic.county].filter(Boolean).join(", ")}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                  {lic.licenseType && (
                    <span
                      className="bg-amber-100 text-amber-800 text-xs font-semibold px-2 py-0.5 rounded-full cursor-help"
                      title={typeInfo ? `${typeInfo.short} — ${typeInfo.description}` : lic.licenseType}
                    >
                      {lic.licenseType}{typeInfo ? ` · ${typeInfo.short}` : ''}
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

              {/* Expanded detail panel */}
              {isOpen && (() => {
                const TEMP_TYPES = new Set(['NT', 'ET', 'TR', 'NB', 'NE', 'NP']);
                const isTemp = TEMP_TYPES.has(lic.licenseType?.toUpperCase() ?? '');
                const physAddr = [lic.address, lic.city, "TX", lic.zipCode].filter(Boolean).join(", ");
                const mailAddr = [lic.mailAddress, lic.mailCity, "TX", lic.mailZip].filter(Boolean).join(", ");
                const showMail = mailAddr && mailAddr !== physAddr;
                return (
                  <div className="border-t border-gray-100 px-6 py-5 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
                    <Detail label="Owner / Applicant" value={lic.ownerName} />
                    <Detail label="Business / Trade Name" value={lic.businessName} />
                    <Detail label="License #" value={lic.licenseNumber} />
                    <Detail label="License Type" value={
                      lic.licenseType
                        ? typeInfo
                          ? `${lic.licenseType} — ${typeInfo.short}`
                          : lic.licenseType
                        : lic.licenseTypeLabel
                    } />
                    {typeInfo && (
                      <div className="col-span-2 sm:col-span-3">
                        <p className="text-xs text-gray-400 uppercase tracking-wide">What this license allows</p>
                        <p className="text-sm text-gray-600 mt-0.5">{typeInfo.description}</p>
                      </div>
                    )}
                    <Detail label="Status" value={lic.status} />
                    <Detail label={isTemp ? "Event Location" : "Address"} value={physAddr} />
                    <Detail label="County" value={lic.county} />
                    {showMail && (
                      <Detail label="Mailing Address" value={mailAddr} />
                    )}
                    {isTemp ? (
                      <>
                        <Detail label="Event Start" value={fmtDate(lic.effectiveDate ?? lic.applicationDate)} />
                        <Detail label="Event End" value={fmtDate(lic.expirationDate)} />
                      </>
                    ) : (
                      <>
                        <Detail label="Issue / Application Date" value={fmtDate(lic.applicationDate)} />
                        <Detail label="Expiration Date" value={fmtDate(lic.expirationDate)} />
                      </>
                    )}
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
