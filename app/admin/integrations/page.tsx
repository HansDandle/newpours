"use client";
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
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
  const [hsTesting, setHsTesting] = useState(false);
  const [hsKeyVisible, setHsKeyVisible] = useState(false);

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

  const setHs = (patch: Partial<NonNullable<IntegrationSettings["hubspot"]>>) =>
    setSettings((s) => ({ ...s, hubspot: { ...s.hubspot, ...patch } }));

  const testHubSpot = async () => {
    const key = settings.hubspot?.serviceKey;
    if (!key) return;
    setHsTesting(true);
    try {
      // HubSpot's API has no browser CORS — test runs server-side via callable.
      const fn = httpsCallable(getFunctions(), "hubspotTestConnection");
      const res = await fn({ serviceKey: key });
      const data = res.data as { ok: boolean; message: string };
      flash(data.ok ? `HubSpot connected — service key is valid ✓` : `HubSpot error: ${data.message}`);
    } catch (e: any) {
      flash(`HubSpot test failed: ${e?.message ?? "request error"}`);
    } finally {
      setHsTesting(false);
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

          {/* HubSpot CRM */}
          <h2 className="text-xs text-gray-500 uppercase tracking-widest mt-8 mb-3">HubSpot CRM</h2>
          <p className="text-sm text-gray-400 mb-4">Push leads to HubSpot as associated Company + Contact + Deal records — on-demand from a lead, or automatically as new leads arrive.</p>
          <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5">
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={!!settings.hubspot?.enabled} onChange={(e) => setHs({ enabled: e.target.checked })} />
              Enable HubSpot integration
            </label>

            <label className="block text-xs text-gray-400">
              Service key
              <div className="mt-1 flex gap-2">
                <input
                  type={hsKeyVisible ? "text" : "password"}
                  value={settings.hubspot?.serviceKey ?? ""}
                  onChange={(e) => setHs({ serviceKey: e.target.value })}
                  placeholder="pat-na1-…"
                  className="flex-1 bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm font-mono"
                />
                <button type="button" onClick={() => setHsKeyVisible((v) => !v)} className="px-3 py-2 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300">{hsKeyVisible ? "Hide" : "Show"}</button>
                <button type="button" onClick={testHubSpot} disabled={hsTesting || !settings.hubspot?.serviceKey} className="px-3 py-2 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50">{hsTesting ? "Testing…" : "Test"}</button>
              </div>
              <span className="mt-1 block text-[11px] text-gray-500">HubSpot → Settings → Integrations → Service Keys. Needs companies, contacts, and deals read/write scopes.</span>
            </label>

            <label className="block text-xs text-gray-400">
              Pipeline ID <span className="text-gray-600">(optional — blank uses the default pipeline)</span>
              <input
                value={settings.hubspot?.pipelineId ?? ""}
                onChange={(e) => setHs({ pipelineId: e.target.value })}
                placeholder="default"
                className="mt-1 w-full bg-gray-950 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm font-mono"
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={!!settings.hubspot?.autoSync} onChange={(e) => setHs({ autoSync: e.target.checked })} />
              Auto-sync new leads as they arrive
            </label>

            <details className="text-xs text-gray-400">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-300">Default stage mapping</summary>
              <div className="mt-2 font-mono text-[11px] text-gray-400 space-y-0.5">
                <div>new → appointmentscheduled</div>
                <div>contacted → qualifiedtobuy</div>
                <div>qualified → presentationscheduled</div>
                <div>proposal → decisionmakerboughtin</div>
                <div>won → closedwon</div>
                <div>lost → closedlost</div>
              </div>
              <p className="mt-2 text-[11px] text-gray-500">HubSpot's default Sales Pipeline stage IDs. If you use a custom pipeline, deal creation will fail with an invalid-stage error — tell me your stage IDs and I'll wire in a custom mapping.</p>
            </details>

            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving} className="btn-accent px-4 py-2 text-sm rounded disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
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
