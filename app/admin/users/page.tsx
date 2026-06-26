"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/components/shared/AuthProvider";
import Link from "next/link";

interface UserRow {
  uid: string;
  email: string;
  displayName?: string;
  plan: string;
  planStatus: string;
  createdAt: any;
  stripeCustomerId?: string;
  compedAccess?: boolean;
}

const PLAN_PRICES: Record<string, number> = { free: 0, basic: 29, pro: 79, enterprise: 299 };

const planBadge = (plan: string) => {
    const map: Record<string, string> = {
    free: "bg-gray-700 text-gray-300",
    basic: "bg-blue-900 text-blue-300",
    pro: "bg-purple-900 text-purple-300",
    enterprise: "bg-[rgba(200,169,108,0.12)] text-[var(--brand-accent)]",
  };
  return map[plan] ?? "bg-gray-700 text-gray-300";
};

const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    active: "bg-green-900 text-green-300",
    past_due: "bg-yellow-900 text-yellow-300",
    canceled: "bg-red-900/60 text-red-400",
  };
  return map[status] ?? "bg-gray-700 text-gray-300";
};

export default function AdminUsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [grantEmail, setGrantEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // email currently being changed
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    getDocs(collection(db, "users"))
      .then((snap) =>
        setUsers(snap.docs.map((d) => ({ uid: d.id, ...d.data() } as UserRow)))
      )
      .finally(() => setLoading(false));
  }, []);

  async function changeAccess(email: string, action: "grant" | "revoke") {
    const target = email.trim().toLowerCase();
    if (!target) return;
    setBusy(target);
    try {
      const token = await user?.getIdToken?.();
      const res = await fetch("/api/admin/grant-access", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ email: target, action, plan: "pro" }),
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        const newPlan = action === "grant" ? "pro" : "free";
        const newStatus = action === "grant" ? "active" : "canceled";
        setUsers((prev) =>
          prev.map((u) =>
            u.uid === json.uid
              ? { ...u, plan: newPlan, planStatus: newStatus, compedAccess: action === "grant" }
              : u
          )
        );
        setToast(action === "grant" ? `✓ Granted pro access to ${target}.` : `✓ Revoked access for ${target}.`);
        if (action === "grant") setGrantEmail("");
      } else {
        setToast(`Error: ${json.error ?? "unknown"}`);
      }
    } catch {
      setToast("Request failed.");
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 6000);
    }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return users.filter((u) => {
      if (planFilter && u.plan !== planFilter) return false;
      if (q && !`${u.email} ${u.displayName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, search, planFilter]);

  const mrr = useMemo(
    () => users.reduce((sum, u) => sum + (u.planStatus === "active" ? (PLAN_PRICES[u.plan] ?? 0) : 0), 0),
    [users]
  );

  function fmtDate(ts: any) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div className="p-8">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Users & Billing</h1>
        <div className="text-sm text-gray-400">
          MRR <span className="text-green-400 font-semibold">${mrr.toLocaleString()}</span>
          {" "}·{" "}
          {users.filter((u) => u.planStatus === "active").length} active subscribers
        </div>
      </div>

      {/* Invite / grant full access without Stripe (comped). The person must have
          signed up (free) first — the grant attaches to their existing account. */}
      <div className="mb-6 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="text-xs text-gray-500 uppercase tracking-widest mb-2">Grant Full Access</h2>
        <p className="text-xs text-gray-500 mb-3">
          Gives a person full (pro) access without billing or admin powers. They must have signed up once already.
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); changeAccess(grantEmail, "grant"); }}
          className="flex gap-2 flex-wrap"
        >
          <input
            type="email"
            placeholder="person@example.com"
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-sm text-gray-100 placeholder-gray-500 rounded px-3 py-2 w-72 focus:outline-none focus:ring-1 focus:ring-[var(--brand-accent)]"
          />
          <button
            type="submit"
            disabled={!grantEmail.trim() || busy === grantEmail.trim().toLowerCase()}
            className="btn-accent px-4 py-2 text-sm rounded disabled:opacity-50"
          >
            {busy === grantEmail.trim().toLowerCase() ? "Granting…" : "Grant pro access"}
          </button>
        </form>
      </div>

      <div className="flex gap-3 mb-5 flex-wrap">
        <input
          type="search"
          placeholder="Search email or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-gray-100 placeholder-gray-500 rounded px-3 py-2 w-72 focus:outline-none focus:ring-1 focus:ring-[var(--brand-accent)]"
        />
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-gray-100 rounded px-3 py-2 focus:outline-none"
        >
          <option value="">All plans</option>
          {["free", "basic", "pro", "enterprise"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                {["Email", "Name", "Plan", "Status", "Joined", "MRR", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map((u) => (
                <tr key={u.uid} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-200">{u.email}</td>
                  <td className="px-4 py-3 text-gray-400">{u.displayName || "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${planBadge(u.plan)}`}>
                      {u.plan}
                    </span>
                    {u.compedAccess && (
                      <span className="ml-1.5 px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/60 text-emerald-300">
                        comped
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge(u.planStatus)}`}>
                      {u.planStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(u.createdAt)}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">
                    {u.planStatus === "active" ? `$${PLAN_PRICES[u.plan] ?? 0}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <Link
                        href={`/admin/users/${u.uid}`}
                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs"
                      >
                        View
                      </Link>
                      {u.stripeCustomerId && (
                        <a
                          href={`https://dashboard.stripe.com/customers/${u.stripeCustomerId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-1 bg-indigo-900/60 hover:bg-indigo-800 text-indigo-300 rounded text-xs"
                        >
                          Stripe ↗
                        </a>
                      )}
                      {u.compedAccess || u.planStatus !== "active" ? (
                        u.compedAccess ? (
                          <button
                            onClick={() => changeAccess(u.email, "revoke")}
                            disabled={busy === u.email?.toLowerCase()}
                            className="px-2 py-1 bg-red-900/60 hover:bg-red-800 text-red-300 rounded text-xs disabled:opacity-50"
                          >
                            {busy === u.email?.toLowerCase() ? "…" : "Revoke"}
                          </button>
                        ) : (
                          <button
                            onClick={() => changeAccess(u.email, "grant")}
                            disabled={busy === u.email?.toLowerCase()}
                            className="px-2 py-1 bg-emerald-900/60 hover:bg-emerald-800 text-emerald-300 rounded text-xs disabled:opacity-50"
                          >
                            {busy === u.email?.toLowerCase() ? "…" : "Grant"}
                          </button>
                        )
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-600 text-sm">
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
