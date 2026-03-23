"use client";
import { use, useEffect, useState } from "react";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { notFound } from "next/navigation";
import { useAuth } from "@/components/shared/AuthProvider";

interface EstDoc {
  [key: string]: any;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-gray-800 rounded-lg mb-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-300 hover:bg-gray-800/50 transition"
      >
        {title}
        <span className="text-gray-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t border-gray-800">{children}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: any }) {
  if (value === undefined || value === null || value === "") return null;
  const display = typeof value === "object" ? JSON.stringify(value) : String(value);
  return (
    <div className="flex gap-2 py-1 border-b border-gray-800/50">
      <span className="text-xs text-gray-500 w-48 shrink-0">{label}</span>
      <span className="text-xs text-gray-200 break-all">{display}</span>
    </div>
  );
}

function RevenueTable({ records }: { records: any[] }) {
  if (!records?.length) return <p className="text-xs text-gray-600">No revenue data.</p>;
  const sorted = [...records].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 24);
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead className="text-gray-500 border-b border-gray-800">
          <tr>
            {["Month", "Liquor", "Wine", "Beer", "Cover", "Total"].map((h) => (
              <th key={h} className="py-1 px-2 text-left">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {sorted.map((r) => (
            <tr key={r.month} className="text-gray-300">
              <td className="py-1 px-2 font-mono">{r.month}</td>
              <td className="py-1 px-2">${r.liquorReceipts?.toLocaleString()}</td>
              <td className="py-1 px-2">${r.wineReceipts?.toLocaleString()}</td>
              <td className="py-1 px-2">${r.beerReceipts?.toLocaleString()}</td>
              <td className="py-1 px-2">${r.coverChargeReceipts?.toLocaleString()}</td>
              <td className="py-1 px-2 font-semibold">${r.totalReceipts?.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function normalizeDocData(raw: Record<string, any>): EstDoc {
  return {
    ...raw,
    enrichment: {
      ...(raw.enrichment ?? {}),
      comptroller: raw.enrichment?.comptroller ?? raw["enrichment.comptroller"],
    },
    comptroller: {
      ...(raw.comptroller ?? {}),
      taxpayerNumber: raw.comptroller?.taxpayerNumber ?? raw["comptroller.taxpayerNumber"],
      monthlyRecords: raw.comptroller?.monthlyRecords ?? raw["comptroller.monthlyRecords"],
      latestMonthRevenue: raw.comptroller?.latestMonthRevenue ?? raw["comptroller.latestMonthRevenue"],
      avgMonthlyRevenue: raw.comptroller?.avgMonthlyRevenue ?? raw["comptroller.avgMonthlyRevenue"],
      revenueTrend: raw.comptroller?.revenueTrend ?? raw["comptroller.revenueTrend"],
      revenueDataFrom: raw.comptroller?.revenueDataFrom ?? raw["comptroller.revenueDataFrom"],
      revenueDataThrough: raw.comptroller?.revenueDataThrough ?? raw["comptroller.revenueDataThrough"],
      confidence: raw.comptroller?.confidence ?? raw["comptroller.confidence"],
      matchMethod: raw.comptroller?.matchMethod ?? raw["comptroller.matchMethod"],
    },
  };
}

export default function EstablishmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [data, setData] = useState<EstDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound404, setNotFound404] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [reenriching, setReenriching] = useState(false);
  const { user } = useAuth();

  const { id } = use(params);

  useEffect(() => {
    getDoc(doc(db, "establishments", id))
      .then((snap) => {
        if (!snap.exists()) { setNotFound404(true); return; }
        setData({ _id: snap.id, ...normalizeDocData(snap.data() as Record<string, any>) });
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (notFound404) notFound();

  async function triggerReenrich(source: string) {
    setReenriching(true);
    try {
      const token = await user?.getIdToken?.();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`/api/admin/enrich?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`, {
        method: "POST",
        headers,
      });
      const json = await res.json();
      if (json.queued) {
        setToast(`Re-enrich queued for ${source}`);
      } else {
        setToast(`Error: ${json.error ?? "unknown"}`);
      }
    } catch {
      setToast("Request failed");
    } finally {
      setReenriching(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function clearDuplicateFlag() {
    await updateDoc(doc(db, "establishments", id), { duplicateFlag: false });
    setData((d) => d ? { ...d, duplicateFlag: false } : d);
    setToast("Duplicate flag cleared.");
    setTimeout(() => setToast(null), 3000);
  }

  async function markReviewed() {
    await updateDoc(doc(db, "establishments", id), {
      adminReviewed: true,
      adminReviewedAt: new Date(),
    });
    setData((d) => d ? { ...d, adminReviewed: true } : d);
    setToast("Marked as reviewed.");
    setTimeout(() => setToast(null), 3000);
  }

  if (loading) return <div className="p-8 text-gray-500 animate-pulse">Loading…</div>;
  if (!data) return null;

  const tabcFields = [
    "licenseNumber", "businessName", "ownerName", "tradeName", "address", "address2",
    "city", "county", "zipCode", "licenseType", "licenseTypeLabel", "status",
    "secondaryStatus", "phone", "applicationDate", "effectiveDate", "expirationDate",
    "legacyClp", "mailAddress", "mailCity", "mailZip", "masterFileId",
    "subordinateLicenseId", "primaryLicenseId", "subordinates", "winePercent", "statusChangeDate",
  ];

  return (
    <div className="p-8 max-w-5xl">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">{data.businessName || id}</h1>
          <p className="text-xs text-gray-500 mt-1 font-mono">{id}</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button
            onClick={() => triggerReenrich("googlePlaces")}
            disabled={reenriching}
            className="px-3 py-1.5 bg-blue-800 hover:bg-blue-700 text-blue-200 text-xs rounded disabled:opacity-50"
          >
            Re-enrich Google Places
          </button>
          <button
            onClick={() => triggerReenrich("all")}
            disabled={reenriching}
            className="px-3 py-1.5 bg-purple-800 hover:bg-purple-700 text-purple-200 text-xs rounded disabled:opacity-50"
          >
            Re-enrich All
          </button>
          {data.duplicateFlag && (
            <button
              onClick={clearDuplicateFlag}
              className="px-3 py-1.5 bg-yellow-800 hover:bg-yellow-700 text-yellow-200 text-xs rounded"
            >
              Clear Duplicate Flag
            </button>
          )}
          {!data.adminReviewed && (
            <button
              onClick={markReviewed}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded"
            >
              Mark Reviewed
            </button>
          )}
          {data.adminReviewed && (
            <span className="px-3 py-1.5 bg-green-900/40 text-green-400 text-xs rounded">
              ✅ Reviewed
            </span>
          )}
        </div>
      </div>

      {/* TABC Data */}
      <Section title="TABC Data">
        {tabcFields.map((k) => (
          <Field key={k} label={k} value={data[k]} />
        ))}
      </Section>

      {/* Enrichment Status */}
      <Section title="Enrichment Status">
        {data.enrichment && Object.entries(data.enrichment).map(([k, v]) => (
          <Field key={k} label={k} value={v} />
        ))}
      </Section>

      {/* Comptroller Data */}
      {data.comptroller && (
        <Section title="Comptroller Revenue Data">
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Field label="Taxpayer #" value={data.comptroller.taxpayerNumber} />
            <Field label="Latest Month Revenue" value={data.comptroller.latestMonthRevenue ? `$${Number(data.comptroller.latestMonthRevenue).toLocaleString()}` : undefined} />
            <Field label="Avg Monthly Revenue" value={data.comptroller.avgMonthlyRevenue ? `$${Number(data.comptroller.avgMonthlyRevenue).toLocaleString()}` : undefined} />
            <Field label="Revenue Trend" value={data.comptroller.revenueTrend} />
            <Field label="Data Range" value={data.comptroller.revenueDataFrom ? `${data.comptroller.revenueDataFrom} → ${data.comptroller.revenueDataThrough}` : undefined} />
            <Field label="Match Method" value={data.comptroller.matchMethod} />
            <Field label="Confidence" value={data.comptroller.confidence} />
          </div>
          <RevenueTable records={data.comptroller.monthlyRecords ?? []} />
        </Section>
      )}

      {/* Google Places */}
      {data.googlePlaces && (
        <Section title="Google Places">
          {["placeId", "name", "rating", "reviewCount", "priceLevel", "phoneNumber", "website", "lat", "lng", "confidence"].map((k) => (
            <Field key={k} label={k} value={data.googlePlaces[k]} />
          ))}
        </Section>
      )}

      {/* Health Inspection */}
      {data.healthInspection && (
        <Section title="Health Inspection">
          {["available", "jurisdiction", "latestScore", "scoreTrend", "confidence"].map((k) => (
            <Field key={k} label={k} value={data.healthInspection[k]} />
          ))}
        </Section>
      )}

      {/* Building Permits */}
      {data.buildingPermits && (
        <Section title="Building Permits">
          {["available", "jurisdiction", "hasSignificantRecentWork", "largestRecentPermitValue", "confidence"].map((k) => (
            <Field key={k} label={k} value={data.buildingPermits[k]} />
          ))}
        </Section>
      )}

      {/* Raw JSON */}
      <Section title="Raw Firestore Document">
        <pre className="text-xs text-gray-400 overflow-auto max-h-64 bg-gray-900 p-3 rounded">
          {JSON.stringify(data, null, 2)}
        </pre>
      </Section>
    </div>
  );
}
