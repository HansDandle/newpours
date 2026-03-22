"use client";
import { useState } from "react";
import { useAuth } from "@/components/shared/AuthProvider";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  enterprise: "Enterprise",
};

export default function AccountPage() {
  const { user } = useAuth();
  const [portalLoading, setPortalLoading] = useState(false);

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
          You are on the <span className="font-bold text-[#1a2233]">{PLAN_LABELS["free"]}</span> plan.
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
            <input type="text" placeholder="e.g. Travis, Harris" className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">License Types</label>
            <input type="text" placeholder="e.g. MB, BQ" className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Zip Codes</label>
            <input type="text" placeholder="e.g. 78701, 77001" className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="digest" className="w-4 h-4" />
            <label htmlFor="digest" className="text-sm">Receive daily email digest</label>
          </div>
        </div>
        <button className="mt-4 bg-[#1a2233] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-800 transition">Save Preferences</button>
      </div>

      {/* API Key */}
      <div className="border rounded-xl p-6 bg-white shadow-sm mb-6">
        <h2 className="font-semibold text-lg mb-2">API Key</h2>
        <p className="text-xs text-gray-400 mb-3">Available on Pro and Enterprise plans.</p>
        <code className="block bg-gray-100 rounded px-3 py-2 text-xs font-mono text-gray-500">••••••••••••••••••••••••••</code>
        <button className="mt-3 text-sm text-amber-600 hover:underline">Regenerate Key</button>
      </div>
    </section>
  );
}
