"use client";
import { useState, Suspense } from "react";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

const VERTICALS = [
  "Beer & Wine Distributor",
  "POS Vendor",
  "Staffing Agency",
  "Talent & Booking Agency",
  "Insurance Broker",
  "Commercial Real Estate",
  "Other",
];

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const planParam = searchParams.get("plan") || "free";
  const isBetaPro = planParam === "pro";

  const [form, setForm] = useState({
    name: "",
    company: "",
    title: "",
    email: "",
    phone: "",
    vertical: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const credential = await createUserWithEmailAndPassword(
        auth,
        form.email,
        form.password
      );
      await updateProfile(credential.user, { displayName: form.name });

      const trialEndsAt = isBetaPro
        ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        : null;

      await setDoc(doc(db, "users", credential.user.uid), {
        uid: credential.user.uid,
        email: form.email,
        displayName: form.name,
        companyName: form.company,
        title: form.title,
        phone: form.phone,
        vertical: form.vertical,
        plan: isBetaPro ? "pro" : "free",
        planStatus: "active",
        ...(trialEndsAt ? { trialEndsAt } : {}),
        createdAt: serverTimestamp(),
        filters: { counties: [], licenseTypes: [], zipCodes: [] },
        emailDigest: true,
        digestTime: "8am",
      });

      router.push("/dashboard");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (
        code === "auth/email-already-in-use"
      ) {
        setError(
          "An account with that email already exists. Try signing in."
        );
      } else if (code === "auth/invalid-email") {
        setError("Invalid email address.");
      } else if (code === "auth/weak-password") {
        setError("Password is too weak — use at least 8 characters.");
      } else {
        setError((err as Error).message || "Sign up failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="min-h-[80vh] flex flex-col items-center justify-center py-16 px-4">
      {isBetaPro && (
        <div className="mb-6 bg-[rgba(200,169,108,0.1)] border border-[var(--brand-accent)] rounded-xl px-6 py-4 max-w-md w-full text-center">
          <p className="font-bold accent text-lg">Limited Beta Offer</p>
          <p className="text-gray-700 text-sm mt-1">
            Pro plan free for your first 3 months — then $49/mo. Save $147.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-lg p-9 border border-gray-100 max-w-md w-full">
        <h1 className="text-2xl font-bold text-on-light mb-1">
          {isBetaPro ? "Claim Your Free Pro Access" : "Create Your Account"}
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          {isBetaPro
            ? "Start your 90-day Pro trial — no credit card required."
            : "Get started with PourScout for free."}
        </p>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Full Name
              </label>
              <input
                name="name"
                type="text"
                required
                value={form.name}
                onChange={handleChange}
                placeholder="Jane Smith"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Company Name
              </label>
              <input
                name="company"
                type="text"
                required
                value={form.company}
                onChange={handleChange}
                placeholder="Acme Distributors"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Job Title
              </label>
              <input
                name="title"
                type="text"
                value={form.title}
                onChange={handleChange}
                placeholder="Sales Manager"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Phone
              </label>
              <input
                name="phone"
                type="tel"
                value={form.phone}
                onChange={handleChange}
                placeholder="(512) 555-0100"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Industry Vertical
            </label>
            <select
              name="vertical"
              required
              value={form.vertical}
              onChange={handleChange}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition bg-white"
            >
              <option value="" disabled>
                Select your vertical…
              </option>
              {VERTICALS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Email
            </label>
            <input
              name="email"
              type="email"
              required
              value={form.email}
              onChange={handleChange}
              placeholder="jane@company.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Password
              </label>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                value={form.password}
                onChange={handleChange}
                placeholder="8+ characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Confirm Password
              </label>
              <input
                name="confirm"
                type="password"
                required
                value={form.confirm}
                onChange={handleChange}
                placeholder="Repeat password"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full btn-accent py-3 rounded-lg font-semibold transition disabled:opacity-60 mt-1"
          >
            {loading
              ? "Creating account…"
              : isBetaPro
              ? "Start Free Pro Trial"
              : "Create Account"}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-5">
          Already have an account?{" "}
          <Link href="/login" className="accent font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </section>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
