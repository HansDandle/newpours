"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { ComptrollerUnmatched } from "@/types";
import Link from "next/link";

const DISMISS_REASONS = [
  "Out of scope license type",
  "Closed establishment",
  "Data error",
  "Duplicate entry",
  "Out of service area",
];

export default function UnmatchedQueuePage() {
  const [records, setRecords] = useState<ComptrollerUnmatched[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showDismissModal, setShowDismissModal] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState(DISMISS_REASONS[0]);
  const [searchModalId, setSearchModalId] = useState<string | null>(null);
  const [estSearch, setEstSearch] = useState("");
  const [estResults, setEstResults] = useState<any[]>([]);
  const [estLoading, setEstLoading] = useState(false);

  useEffect(() => {
    getDocs(collection(db, "comptroller_unmatched"))
      .then((snap) =>
        setRecords(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as ComptrollerUnmatched))
            .filter((r) => !r.dismissed)
        )
      )
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return records;
    return records.filter((r) =>
      `${r.taxpayerName} ${r.locationName} ${r.address} ${r.city}`.toLowerCase().includes(q)
    );
  }, [records, search]);

  async function dismiss(id: string, reason: string) {
    await updateDoc(doc(db, "comptroller_unmatched", id), {
      dismissed: true,
      dismissReason: reason,
    });
    setRecords((prev) => prev.filter((r) => r.id !== id));
    setShowDismissModal(null);
  }

  async function searchEstablishments(q: string) {
    if (q.length < 2) { setEstResults([]); return; }
    setEstLoading(true);
    try {
      const snap = await getDocs(collection(db, "establishments"));
      const ql = q.toLowerCase();
      setEstResults(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((e: any) =>
            `${e.businessName} ${e.address} ${e.licenseNumber}`.toLowerCase().includes(ql)
          )
          .slice(0, 20)
      );
    } finally {
      setEstLoading(false);
    }
  }

  async function linkToEstablishment(unmatchedId: string, estId: string, est: any) {
    // Move Comptroller data to the establishment
    const unmatched = records.find((r) => r.id === unmatchedId);
    if (!unmatched) return;
    await updateDoc(doc(db, "establishments", estId), {
      "comptroller.taxpayerNumber": unmatched.taxpayerNumber,
      "enrichment.comptroller": "complete",
    });
    await deleteDoc(doc(db, "comptroller_unmatched", unmatchedId));
    setRecords((prev) => prev.filter((r) => r.id !== unmatchedId));
    setSearchModalId(null);
    setEstSearch("");
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-white mb-6">
        Unmatched Comptroller Records
        <span className="ml-3 text-sm font-normal text-gray-500">
          {records.length.toLocaleString()} pending
        </span>
      </h1>

      <input
        type="search"
        placeholder="Search taxpayer name, address…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-5 bg-gray-800 border border-gray-700 text-sm text-gray-100 placeholder-gray-500 rounded px-3 py-2 w-80 focus:outline-none focus:ring-1 focus:ring-amber-500"
      />

      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                {["Taxpayer Name", "Location Name", "Address", "City", "Latest Revenue", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-200">{r.taxpayerName}</td>
                  <td className="px-4 py-3 text-gray-400">{r.locationName || "—"}</td>
                  <td className="px-4 py-3 text-gray-400">{r.address}</td>
                  <td className="px-4 py-3 text-gray-400">{r.city}</td>
                  <td className="px-4 py-3 text-green-400">
                    {r.latestMonthRevenue ? `$${r.latestMonthRevenue.toLocaleString()}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setSearchModalId(r.id!); setEstSearch(""); setEstResults([]); }}
                        className="px-2 py-1 bg-blue-800 hover:bg-blue-700 text-blue-200 rounded text-xs"
                      >
                        Find match
                      </button>
                      <button
                        onClick={() => { setShowDismissModal(r.id!); setDismissReason(DISMISS_REASONS[0]); }}
                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs"
                      >
                        Dismiss
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-600 text-sm">
                    No unmatched records.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Dismiss modal */}
      {showDismissModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96">
            <h2 className="text-sm font-semibold text-white mb-4">Dismiss record</h2>
            <label className="text-xs text-gray-400 block mb-1">Reason</label>
            <select
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded px-3 py-2 mb-4 focus:outline-none"
            >
              {DISMISS_REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDismissModal(null)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => dismiss(showDismissModal, dismissReason)}
                className="px-3 py-1.5 bg-red-800 hover:bg-red-700 text-red-200 text-sm rounded"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Link to establishment modal */}
      {searchModalId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[520px]">
            <h2 className="text-sm font-semibold text-white mb-4">Find matching establishment</h2>
            <input
              type="search"
              placeholder="Search by name, address, license #…"
              value={estSearch}
              onChange={(e) => { setEstSearch(e.target.value); searchEstablishments(e.target.value); }}
              className="w-full bg-gray-800 border border-gray-700 text-sm text-gray-100 placeholder-gray-500 rounded px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-amber-500"
              autoFocus
            />
            {estLoading && <p className="text-xs text-gray-500">Searching…</p>}
            <div className="max-h-60 overflow-y-auto divide-y divide-gray-800">
              {estResults.map((e: any) => (
                <button
                  key={e.id}
                  onClick={() => linkToEstablishment(searchModalId, e.id, e)}
                  className="w-full text-left px-3 py-2.5 hover:bg-gray-800 transition"
                >
                  <p className="text-sm text-gray-200">{e.businessName}</p>
                  <p className="text-xs text-gray-500">{e.address}, {e.city} · {e.licenseNumber}</p>
                </button>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <button
                onClick={() => { setSearchModalId(null); setEstSearch(""); setEstResults([]); }}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
