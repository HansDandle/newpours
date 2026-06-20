"use client";
import { useEffect, useState } from "react";
import { collection, getDocs, addDoc, setDoc, deleteDoc, doc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import type { Operator } from "@/types";

const empty = { name: "", aliases: "", mailPatterns: "", ownerPatterns: "", notes: "" };
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const join = (a?: string[]) => (a ?? []).join(", ");

export default function AdminOperatorsPage() {
  const { user } = useAuth();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...empty });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [retagging, setRetagging] = useState(false);

  const load = async () => {
    const snap = await getDocs(collection(db, "operators"));
    setOperators(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Operator, "id">) })).sort((a, b) => a.name.localeCompare(b.name)));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4000); };

  const startEdit = (op: Operator) => {
    setEditingId(op.id!);
    setForm({ name: op.name, aliases: join(op.aliases), mailPatterns: join(op.mailPatterns), ownerPatterns: join(op.ownerPatterns), notes: op.notes ?? "" });
  };

  const save = async () => {
    if (!form.name.trim()) { flash("Name is required."); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        aliases: csv(form.aliases),
        mailPatterns: csv(form.mailPatterns),
        ownerPatterns: csv(form.ownerPatterns),
        notes: form.notes.trim() || null,
        updatedAt: serverTimestamp(),
      };
      if (editingId) {
        await setDoc(doc(db, "operators", editingId), payload, { merge: true });
      } else {
        await addDoc(collection(db, "operators"), { ...payload, venueCount: 0, createdAt: serverTimestamp() });
      }
      setForm({ ...empty });
      setEditingId(null);
      await load();
      flash("Saved. Run “Re-tag leads now” to apply to existing leads.");
    } catch (e: any) {
      flash(`Save failed: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (op: Operator) => {
    if (!window.confirm(`Delete operator “${op.name}”? Leads keep their tag until the next re-tag.`)) return;
    await deleteDoc(doc(db, "operators", op.id!));
    await load();
    flash("Deleted.");
  };

  const retag = async () => {
    setRetagging(true);
    try {
      const token = await user?.getIdToken?.();
      const res = await fetch("/api/admin/trigger/retag_operators", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      flash(json.queued ? "Re-tag queued — counts refresh in ~1 min." : `Error: ${json.error ?? "unknown"}`);
    } catch {
      flash("Re-tag request failed.");
    } finally {
      setRetagging(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      {toast && <div className="fixed bottom-6 right-6 bg-gray-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50">{toast}</div>}
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-semibold text-white">Operator Groups</h1>
        <button onClick={retag} disabled={retagging} className="btn-accent px-4 py-2 text-sm rounded disabled:opacity-50">
          {retagging ? "Queuing…" : "Re-tag leads now"}
        </button>
      </div>
      <p className="text-sm text-gray-400 mb-6">
        A group links venues that license under separate LLCs. Auto-match by HQ <span className="font-mono">mail patterns</span> or
        {" "}<span className="font-mono">owner patterns</span> (normalized substrings), and search by any alias. Manual tags on a lead always win.
      </p>

      {/* Add / edit form */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 mb-8 space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">{editingId ? "Edit group" : "Add group"}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-xs text-gray-400">Name
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Hai Hospitality" className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-400">Aliases (comma-separated)
            <input value={form.aliases} onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))} placeholder="hai, uchi, tyson cole" className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-400">Mail patterns (comma-separated)
            <input value={form.mailPatterns} onChange={(e) => setForm((f) => ({ ...f, mailPatterns: e.target.value }))} placeholder="1011 w 5th, 200 lavaca" className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-400">Owner patterns (comma-separated)
            <input value={form.ownerPatterns} onChange={(e) => setForm((f) => ({ ...f, ownerPatterns: e.target.value }))} placeholder="hai hospitality, kerbey lane" className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm" />
          </label>
        </div>
        <label className="block text-xs text-gray-400">Notes
          <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm" />
        </label>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving} className="btn-accent px-4 py-2 text-sm rounded disabled:opacity-50">{saving ? "Saving…" : editingId ? "Update" : "Add group"}</button>
          {editingId && <button onClick={() => { setEditingId(null); setForm({ ...empty }); }} className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-200">Cancel</button>}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : operators.length === 0 ? (
        <p className="text-sm text-gray-600">No operator groups yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
              <tr>{["Name", "Venues", "Mail patterns", "Owner patterns", "Aliases", ""].map((h) => <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {operators.map((op) => (
                <tr key={op.id} className="hover:bg-gray-800/40">
                  <td className="px-4 py-2 text-gray-200 font-medium">{op.name}</td>
                  <td className="px-4 py-2 text-gray-400">{op.venueCount ?? 0}</td>
                  <td className="px-4 py-2 text-gray-400 font-mono text-xs">{join(op.mailPatterns) || "—"}</td>
                  <td className="px-4 py-2 text-gray-400 font-mono text-xs">{join(op.ownerPatterns) || "—"}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">{join(op.aliases) || "—"}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <button onClick={() => startEdit(op)} className="text-xs text-gray-400 hover:text-white mr-3">Edit</button>
                    <button onClick={() => remove(op)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
