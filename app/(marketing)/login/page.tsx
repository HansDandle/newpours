"use client";
import { useState } from "react";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.push("/dashboard");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (
        code === "auth/invalid-credential" ||
        code === "auth/wrong-password" ||
        code === "auth/user-not-found"
      ) {
        setError("Incorrect email or password.");
      } else if (code === "auth/invalid-email") {
        setError("Invalid email address.");
      } else {
        setError((err as Error).message || "Sign in failed.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError("");
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
      router.push("/dashboard");
    } catch (err) {
      setError("Google sign in failed: " + (err as Error).message);
    }
  };

  return (
    <section className="min-h-[80vh] flex flex-col items-center justify-center gap-6">
      <div className="bg-white rounded-2xl shadow-lg p-10 flex flex-col gap-4 border border-gray-100 max-w-sm w-full">
        <span className="text-3xl font-bold text-on-light text-center">PourScout</span>
        <p className="text-gray-500 text-sm text-center">
          Sign in to access your TABC license alerts dashboard.
        </p>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        <form onSubmit={handleEmailSignIn} className="flex flex-col gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand-accent)] transition"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full btn-accent py-3 rounded-lg font-semibold transition disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div className="flex items-center gap-2">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs text-gray-400">or</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <button
          className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 hover:border-[var(--brand-accent)] text-gray-700 font-medium px-6 py-3 rounded-lg shadow-sm transition"
          onClick={handleGoogleSignIn}
        >
          <svg width="20" height="20" viewBox="0 0 48 48"><g><path fill="#4285F4" d="M43.6 20.4H42V20H24v8h11.3C33.7 32.1 29.3 35 24 35c-6.1 0-11-4.9-11-11s4.9-11 11-11c2.8 0 5.3 1 7.2 2.7l5.7-5.7C33.5 7.1 29 5 24 5 12.9 5 4 13.9 4 25s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.6z"/><path fill="#34A853" d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c2.8 0 5.3 1 7.2 2.7l5.7-5.7C33.5 7.1 29 5 24 5c-7.7 0-14.3 4.5-17.7 9.7z"/><path fill="#FBBC05" d="M24 45c4.9 0 9.3-1.8 12.7-4.7l-6-5.1C29 36.9 26.6 38 24 38c-5.3 0-9.7-3.3-11.3-8H6.3C9.7 40.5 16.3 45 24 45z"/><path fill="#EA4335" d="M43.6 20.4H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6 5.1C40.7 36.7 44 31.3 44 25c0-1.2-.1-2.4-.4-3.6z"/></g></svg>
          Continue with Google
        </button>

        <p className="text-center text-xs text-gray-400">
          New here?{" "}
          <Link href="/signup" className="accent font-medium hover:underline">
            Create an account →
          </Link>
        </p>
      </div>
    </section>
  );
}
