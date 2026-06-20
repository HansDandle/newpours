"use client";
import Link from "next/link";

/** Shown to free-trial users on Pro-only surfaces instead of a permission error. */
export default function UpgradeGate({ feature }: { feature: string }) {
  return (
    <div className="mx-auto mt-10 max-w-xl rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <p className="text-3xl">🔒</p>
      <h2 className="mt-3 text-xl font-semibold text-slate-900">{feature} is a Pro feature</h2>
      <p className="mt-2 text-sm text-slate-600">
        Your free trial includes <strong>Travis County</strong> leads 30+ days old in the{" "}
        <Link href="/leads" className="accent underline">Leads</Link> view. Upgrade to unlock{" "}
        {feature.toLowerCase()}, every county, and the newest leads as they file.
      </p>
      <Link href="/pricing" className="mt-6 inline-block btn-accent rounded-lg px-5 py-2.5 text-sm font-semibold">
        See plans
      </Link>
    </div>
  );
}
