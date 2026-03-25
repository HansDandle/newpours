"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "./AuthProvider";

export default function Navbar() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    try { await signOut(auth); } catch { /* no-op if not signed in via Firebase */ }
    router.push("/");
  };

  return (
    <nav className="w-full py-4 px-8 flex justify-between items-center bg-brand text-on-dark shadow-md">
      <Link href="/" className="flex items-center gap-4 text-xl font-bold tracking-tight accent hover:opacity-90 transition text-on-dark">
        <img src="/branding/pourscout_sm_logo.png" alt="PourScout" className="h-10 md:h-12 lg:h-14 w-auto" />
        <span className="text-brand">PourScout</span>
      </Link>
      <div className="flex gap-8 text-sm font-medium items-center">
        {!loading && (
          <>
            {user ? (
              <>
                <Link href="/dashboard" className="hover:accent transition text-on-dark">Dashboard</Link>
                <button
                  onClick={handleSignOut}
                  className="btn-accent px-4 py-2 rounded-lg transition"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link href="/pricing" className="hover:accent transition text-on-dark">Pricing</Link>
                <Link href="/login" className="hover:accent transition text-on-dark">Sign In</Link>
                <Link href="/signup?plan=pro" className="btn-accent px-4 py-2 rounded-lg transition">Get Started</Link>
              </>
            )}
          </>
        )}
      </div>
    </nav>
  );
}

