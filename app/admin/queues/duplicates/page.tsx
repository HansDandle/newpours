"use client";
import { useEffect, useState } from "react";
import { collection, getDocs, doc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";

interface FlaggedPair {
  a: any;
  b: any;
}

export default function DuplicateFlagsPage() {
  const [pairs, setPairs] = useState<FlaggedPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    getDocs(collection(db, "establishments"))
      .then((snap) => {
        const flagged = snap.docs
          .filter((d) => d.data().duplicateFlag)
          .reduce<Record<string, any[]>>((acc, d) => {
            const placeId = d.data().duplicatePlaceId ?? "unknown";
            if (!acc[placeId]) acc[placeId] = [];
            acc[placeId].push({ id: d.id, ...d.data() });
            return acc;
          }, {});

        const result: FlaggedPair[] = [];
        for (const group of Object.values(flagged)) {
          for (let i = 0; i < group.length; i += 2) {
            result.push({ a: group[i], b: group[i + 1] ?? null });
          }
        }
        setPairs(result);
      })
      .finally(() => setLoading(false));
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function keepBoth(a: any, b: any) {
    const batch = writeBatch(db);
    batch.update(doc(db, "establishments", a.id), { duplicateFlag: false, duplicateReviewed: true });
    if (b) batch.update(doc(db, "establishments", b.id), { duplicateFlag: false, duplicateReviewed: true });
    await batch.commit();
    setPairs((prev) => prev.filter((p) => p.a.id !== a.id));
    showToast("Kept both — flags cleared.");
  }

  async function markRelated(a: any, b: any) {
    const batch = writeBatch(db);
    batch.update(doc(db, "establishments", a.id), {
      duplicateFlag: false,
      duplicateReviewed: true,
      relatedLicenses: [b?.licenseNumber ?? b?.id].filter(Boolean),
    });
    if (b) {
      batch.update(doc(db, "establishments", b.id), {
        duplicateFlag: false,
        duplicateReviewed: true,
        relatedLicenses: [a.licenseNumber ?? a.id],
      });
    }
    await batch.commit();
    setPairs((prev) => prev.filter((p) => p.a.id !== a.id));
    showToast("Marked as related — licenses linked.");
  }

  async function archiveOne(archiveId: string, keepId: string) {
    const batch = writeBatch(db);
    batch.update(doc(db, "establishments", archiveId), { archived: true, duplicateFlag: false });
    batch.update(doc(db, "establishments", keepId), { duplicateFlag: false, duplicateReviewed: true });
    await batch.commit();
    setPairs((prev) => prev.filter((p) => p.a.id !== archiveId && p.b?.id !== archiveId));
    showToast("Record archived.");
  }

  function RecordCard({ record }: { record: any }) {
    if (!record) return <div className="flex-1 bg-gray-800/40 rounded-lg p-4 text-center text-gray-600 text-sm">Pair member unavailable.</div>;
    return (
      <div className="flex-1 bg-gray-800 rounded-lg p-4 space-y-2">
        <Link href={`/admin/establishments/${record.id}`} className="accent hover:underline text-sm font-medium">
          {record.businessName || record.id}
        </Link>
        <p className="text-xs text-gray-500 font-mono">{record.licenseNumber}</p>
        <p className="text-xs text-gray-400">{record.address}, {record.city}</p>
        <div className="flex gap-2 flex-wrap">
          <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded">{record.licenseType || "—"}</span>
          <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded">{record.status || "—"}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      <h1 className="text-xl font-semibold text-white mb-6">
        Duplicate Flags
        <span className="ml-3 text-sm font-normal text-gray-500">
          {pairs.length} pairs pending review
        </span>
      </h1>

      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : pairs.length === 0 ? (
        <p className="text-gray-600 text-sm">No duplicate flags. 🎉</p>
      ) : (
        <div className="space-y-6">
          {pairs.map((pair, i) => (
            <div key={i} className="border border-gray-800 rounded-xl p-5">
              <div className="flex gap-4 mb-4">
                <RecordCard record={pair.a} />
                <div className="flex items-center text-gray-600 text-xl">⟷</div>
                <RecordCard record={pair.b} />
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => keepBoth(pair.a, pair.b)}
                  className="px-3 py-1.5 bg-green-900/50 hover:bg-green-800 text-green-300 text-xs rounded"
                >
                  Keep both
                </button>
                <button
                  onClick={() => markRelated(pair.a, pair.b)}
                  className="px-3 py-1.5 bg-blue-900/50 hover:bg-blue-800 text-blue-300 text-xs rounded"
                >
                  Mark as related
                </button>
                {pair.b && (
                  <>
                    <button
                      onClick={() => archiveOne(pair.a.id, pair.b.id)}
                      className="px-3 py-1.5 bg-red-900/50 hover:bg-red-800 text-red-300 text-xs rounded"
                    >
                      Archive A
                    </button>
                    <button
                      onClick={() => archiveOne(pair.b.id, pair.a.id)}
                      className="px-3 py-1.5 bg-red-900/50 hover:bg-red-800 text-red-300 text-xs rounded"
                    >
                      Archive B
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
