"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";

interface EstRow {
  id: string;
  businessName: string;
  licenseNumber: string;
  county: string;
  licenseType: string;
  status: string;
  firstSeenAt: any;
  duplicateFlag?: boolean;
  newEstablishmentClassification?: string;
  newEstablishmentConfidence?: number;
  enrichment?: {
    googlePlaces?: string;
    comptroller?: string;
    healthInspection?: string;
    buildingPermits?: string;
  };
}

function EnrichBadge({ status }: { status?: string }) {
  if (!status || status === "pending") return <span className="text-gray-600">—</span>;
  if (status === "complete") return <span className="text-green-400">✅</span>;
  if (status === "no_match") return <span className="text-yellow-500">⚠️</span>;
  if (status === "unavailable") return <span className="text-gray-500">N/A</span>;
  return <span className="text-red-400">❌</span>;
}

export default function AdminEstablishmentsPage() {
  const [rows, setRows] = useState<EstRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [countyFilter, setCountyFilter] = useState("");
  const [dupFilter, setDupFilter] = useState(false);
  const [classificationFilter, setClassificationFilter] = useState("");

  useEffect(() => {
    getDocs(collection(db, "establishments"))
      .then((snap) =>
        setRows(
          snap.docs.map((d) => ({ id: d.id, ...d.data() } as EstRow))
        )
      )
      .finally(() => setLoading(false));
  }, []);

  const counties = useMemo(() => {
    const s = new Set(rows.map((r) => r.county).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter((r) => {
      if (dupFilter && !r.duplicateFlag) return false;
      if (countyFilter && r.county !== countyFilter) return false;
      if (classificationFilter && (r.newEstablishmentClassification ?? "") !== classificationFilter) return false;
      if (q && !`${r.businessName} ${r.licenseNumber} ${r.county}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, countyFilter, dupFilter, classificationFilter]);

  const classifications = useMemo(() => {
    const s = new Set(rows.map((r) => r.newEstablishmentClassification).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  function fmtDate(ts: any) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-white mb-6">Establishments</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="search"
          placeholder="Search name, license #, county…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-gray-100 placeholder-gray-500 rounded px-3 py-2 w-72 focus:outline-none focus:ring-1 focus:ring-[var(--brand-accent)]"
        />
        <select
          value={countyFilter}
          onChange={(e) => setCountyFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-gray-100 rounded px-3 py-2 focus:outline-none"
        >
          <option value="">All counties</option>
          {counties.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={classificationFilter}
          onChange={(e) => setClassificationFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-gray-100 rounded px-3 py-2 focus:outline-none"
        >
          <option value="">All classifications</option>
          {classifications.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={dupFilter}
            onChange={(e) => setDupFilter(e.target.checked)}
            className="accent-[var(--brand-accent)]"
          />
          Duplicate flags only
        </label>
        <span className="ml-auto text-sm text-gray-500 self-center">
          {filtered.length.toLocaleString()} records
        </span>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                {[
                  "Business Name",
                  "License #",
                  "County",
                  "Type",
                  "Status",
                  "Class",
                  "Google",
                  "Comptroller",
                  "Health",
                  "Permits",
                  "First Seen",
                ].map((h) => (
                  <th key={h} className="px-3 py-3 text-left font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.slice(0, 500).map((row) => (
                <tr key={row.id} className="hover:bg-gray-800/50">
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/establishments/${row.id}`}
                      className="accent hover:underline"
                    >
                      {row.businessName || "—"}
                    </Link>
                    {row.duplicateFlag && (
                      <span className="ml-2 text-xs bg-red-900/60 text-red-300 px-1.5 rounded">dup</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400">{row.licenseNumber}</td>
                  <td className="px-3 py-2">
                    <span className="bg-gray-700 text-gray-300 px-2 py-0.5 rounded text-xs">
                      {row.county || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs">{row.licenseType || "—"}</td>
                  <td className="px-3 py-2">
                    <span className="text-xs text-gray-300">{row.status || "—"}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-300 whitespace-nowrap">
                    {row.newEstablishmentClassification || "—"}
                    {row.newEstablishmentConfidence != null && (
                      <span className="text-gray-500 ml-1">({Math.round(row.newEstablishmentConfidence * 100)}%)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <EnrichBadge status={row.enrichment?.googlePlaces} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <EnrichBadge status={row.enrichment?.comptroller} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <EnrichBadge status={row.enrichment?.healthInspection} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <EnrichBadge status={row.enrichment?.buildingPermits} />
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                    {fmtDate(row.firstSeenAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <p className="text-center text-xs text-gray-600 py-3">
              Showing first 500 of {filtered.length.toLocaleString()} results — refine your search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
