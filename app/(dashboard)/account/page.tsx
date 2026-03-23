"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/shared/AuthProvider";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  enterprise: "Enterprise",
};

export default function AccountPage() {
  const { user } = useAuth();
  const [portalLoading, setPortalLoading] = useState(false);
  const [plan, setPlan] = useState<keyof typeof PLAN_LABELS>("free");
  const [planStatus, setPlanStatus] = useState("canceled");
  const [counties, setCounties] = useState("");
  const [licenseTypes, setLicenseTypes] = useState("");
  const [zipCodes, setZipCodes] = useState("");
  const [emailDigest, setEmailDigest] = useState(false);
  const [includeRenewals, setIncludeRenewals] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    const loadUser = async () => {
      if (!user) return;
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data() as {
          plan?: keyof typeof PLAN_LABELS;
          planStatus?: string;
          emailDigest?: boolean;
          includeRenewals?: boolean;
          filters?: {
            counties?: string[];
            licenseTypes?: string[];
            zipCodes?: string[];
          };
        } | undefined;

        setPlan(data?.plan ?? "free");
        setPlanStatus(data?.planStatus ?? "canceled");
        setEmailDigest(Boolean(data?.emailDigest));
        setIncludeRenewals(Boolean(data?.includeRenewals));
        setCounties((data?.filters?.counties ?? []).join(", "));
        setLicenseTypes((data?.filters?.licenseTypes ?? []).join(", "));
        setZipCodes((data?.filters?.zipCodes ?? []).join(", "));
      } catch {
        // Keep sensible defaults on read failure.
      }
    };

    loadUser();
  }, [user]);

  const openPortal = async () => {
    if (!user) return;
    setPortalLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } finally {
      setPortalLoading(false);
    }
  };

  const savePreferences = async () => {
    if (!user) return;
    setSaving(true);
    setSaved("");
    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          emailDigest,
          includeRenewals,
          filters: {
            counties: counties.split(",").map((v) => v.trim()).filter(Boolean),
            licenseTypes: licenseTypes.split(",").map((v) => v.trim()).filter(Boolean),
            zipCodes: zipCodes.split(",").map((v) => v.trim()).filter(Boolean),
          },
        },
        { merge: true }
      );
      setSaved("Preferences saved.");
    } catch {
      setSaved("Could not save preferences. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const hasProFeatures = (plan === "pro" || plan === "enterprise") && planStatus === "active";

  return (
    <section className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6 text-[#1a2233]">Account Settings</h1>

      {/* User Info */}
      {user && (
        <div className="border rounded-xl p-6 bg-white shadow-sm mb-6">
          <h2 className="font-semibold text-lg mb-3">Profile</h2>
          <div className="flex items-center gap-4">
            {user.photoURL && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.photoURL} alt="avatar" className="w-12 h-12 rounded-full" />
            )}
            <div>
              <p className="font-medium text-[#1a2233]">{user.displayName}</p>
              <p className="text-sm text-gray-500">{user.email}</p>
            </div>
          </div>
        </div>
      )}

      {/* Plan */}
      <div className="border rounded-xl p-6 bg-white shadow-sm mb-6">
        <h2 className="font-semibold text-lg mb-1">Current Plan</h2>
        <p className="text-gray-500 text-sm mb-4">
          You are on the <span className="font-bold text-[#1a2233]">{PLAN_LABELS[plan]}</span> plan
          {planStatus === "active" ? "" : ` (${planStatus})`}.
        </p>
        <div className="flex gap-3">
          <a
            href="/pricing"
            className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-400 transition"
          >
            Upgrade Plan
          </a>
          <button
            onClick={openPortal}
            disabled={portalLoading}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-50 transition disabled:opacity-50"
          >
            {portalLoading ? "Loading…" : "Manage Billing"}
          </button>
        </div>
      </div>

      {/* Filter Preferences */}
      <div className="border rounded-xl p-6 bg-white shadow-sm mb-6">
        <h2 className="font-semibold text-lg mb-4">Alert Preferences</h2>
        <div className="flex flex-col gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">Counties (comma-separated)</label>
            <input
              type="text"
              placeholder="e.g. Travis, Harris"
              value={counties}
              onChange={(e) => setCounties(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">License Types</label>
            <input
              type="text"
              placeholder="e.g. MB, BQ"
              value={licenseTypes}
              onChange={(e) => setLicenseTypes(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Zip Codes</label>
            <input
              type="text"
              placeholder="e.g. 78701, 77001"
              value={zipCodes}
              onChange={(e) => setZipCodes(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="digest"
              className="w-4 h-4"
              checked={emailDigest}
              onChange={(e) => setEmailDigest(e.target.checked)}
            />
            <label htmlFor="digest" className="text-sm">Receive daily email digest</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="renewals"
              className="w-4 h-4"
              checked={includeRenewals}
              onChange={(e) => setIncludeRenewals(e.target.checked)}
            />
            <label htmlFor="renewals" className="text-sm">Include renewals and transfers in alerts</label>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button
            onClick={savePreferences}
            disabled={saving || !user}
            className="bg-[#1a2233] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-800 transition disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Preferences"}
          </button>
          {saved && <p className="text-sm text-gray-500">{saved}</p>}
        </div>
      </div>

      {/* API Key */}
      <div className="border rounded-xl p-6 bg-white shadow-sm mb-6">
        <h2 className="font-semibold text-lg mb-2">API Key</h2>
        <p className="text-xs text-gray-400 mb-3">Available on Pro and Enterprise plans.</p>
        <code className="block bg-gray-100 rounded px-3 py-2 text-xs font-mono text-gray-500">
          {hasProFeatures ? "••••••••••••••••••••••••••" : "Upgrade to Pro to access API keys."}
        </code>
        <button className="mt-3 text-sm text-amber-600 hover:underline" disabled={!hasProFeatures}>
          Regenerate Key
        </button>
      </div>
    </section>
  );
}
