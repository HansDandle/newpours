"use client";
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import type { IntegrationSettings } from "@/types";

const EVENT_TYPES = ["lead.created", "lead.stage_changed"] as const;

function fmtTs(ts: any) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AdminIntegrationsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<IntegrationSettings>({ enabled: false, events: ["lead.created"] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const snap = await getDoc(doc(db, "settings", "integrations"));
      if (snap.exists()) setSettings({ events: ["lead.created"], ...(snap.data() as IntegrationSettings) });
      const dSnap = await getDocs(query(collection(db, "system/webhookDeliveries/items"), orderBy("at", "desc"), limit(15)));
      setDeliveries(dSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    })();
  }, []);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4000); };

  const save = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, "settings", "integrations"), { ...settings, updatedAt: serverTimestamp() }, { merge: true });
      flash("Saved.");
    } catch (e: any) {
      flash(`Save failed: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const token = await user?.getIdToken?.();
      const res = await fetch("/api/admin/webhook-test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      flash(json.sent ? `Test sent — HTTP ${json.status}${json.ok ? " ✓" : ""}${json.error ? ` (${json.error})` : ""}` : `Error: ${json.error}`);
    } catch {
      flash("Test request failed.");
    } finally {
      setTesting(false);
    }
  };

  const toggleEvent = (ev: string) => {
    setSettings((s) => {
      const events = new Set(s.events ?? []);
      if (events.has(ev as any)) events.delete(ev as any);
      else events.add(ev as any);
      return { ...s, events: Array.from(events) as IntegrationSettings["events"] };
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      {toast && <div className="fixed bottom-6 right-6 bg-gray-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50">{toast}</div>}
      <h1 className="text-xl font-semibold text-white mb-2">Integrations</h1>
      <p className="text-sm text-gray-400 mb-6">Send new leads and pipeline changes to Zapier, Make, or any endpoint via a signed JSON webhook.</p>

      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : (
        <>
          <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5">
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={!!settings.enabled} onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))} />
              Enable outbound webhook
            </label>

            <label className="block text-xs text-gray-400">
              Webhook URL
              <input
                value={settings.webhookUrl ?? ""}
                onChange={(e) => setSettings((s) => ({ ...s, webhookUrl: e.target.value }))}
                placeholder="https://hooks.zapier.com/…"
                className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-xs text-gray-400">
              Signing secret (optional — sent as X-NewPours-Signature, HMAC-SHA256)
              <input
                value={settings.secret ?? ""}
                onChange={(e) => setSettings((s) => ({ ...s, secret: e.target.value }))}
                placeholder="a shared secret"
                className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
              />
            </label>

            <div className="text-xs text-gray-400">
              Events
              <div className="mt-1 flex gap-4">
                {EVENT_TYPES.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-gray-200">
                    <input type="checkbox" checked={(settings.events ?? []).includes(ev)} onChange={() => toggleEvent(ev)} />
                    <span className="font-mono">{ev}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="block text-xs text-gray-400">
              County filter (comma-separated, blank = all)
              <input
                value={(settings.filters?.counties ?? []).join(", ")}
                onChange={(e) => setSettings((s) => ({ ...s, filters: { ...s.filters, counties: e.target.value.split(",").map((c) => c.trim()).filter(Boolean) } }))}
                placeholder="Travis, Williamson, Hays"
                className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm"
              />
            </label>

            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving} className="btn-accent px-4 py-2 text-sm rounded disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
              <button onClick={sendTest} disabled={testing || !settings.webhookUrl} className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50">{testing ? "Sending…" : "Send test event"}</button>
            </div>
          </div>

          <h2 className="text-xs text-gray-500 uppercase tracking-widest mt-8 mb-3">Recent deliveries</h2>
          {deliveries.length === 0 ? (
            <p className="text-xs text-gray-600">No deliveries yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>{["Event", "Lead", "Status", "When"].map((h) => <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="px-4 py-2 font-mono text-xs text-gray-300">{d.event}{d.test ? " (test)" : ""}</td>
                      <td className="px-4 py-2 text-gray-300">{d.businessName ?? d.leadId}</td>
                      <td className="px-4 py-2"><span className={d.ok ? "text-green-400" : "text-red-400"}>{d.status || "—"}{d.error ? ` ${d.error}` : ""}</span></td>
                      <td className="px-4 py-2 text-gray-400 text-xs">{fmtTs(d.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
