"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "./AuthProvider";

export default function Navbar() {
  const { user, loading, devSignOut } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    devSignOut();
    try { await signOut(auth); } catch { /* no-op if not signed in via Firebase */ }
    router.push("/");
  };

  return (
    <nav className="w-full py-4 px-8 flex justify-between items-center bg-[#1a2233] text-white shadow-md">
      <Link href="/" className="text-xl font-bold tracking-tight text-amber-400 hover:text-amber-300 transition">
        NewPours
      </Link>
      <div className="flex gap-8 text-sm font-medium items-center">
        {!loading && (
          <>
            {user ? (
              <>
                <Link href="/dashboard" className="hover:text-amber-400 transition">Dashboard</Link>
                <button
                  onClick={handleSignOut}
                  className="bg-amber-500 hover:bg-amber-400 text-white px-4 py-2 rounded-lg transition"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link href="/pricing" className="hover:text-amber-400 transition">Pricing</Link>
                <Link href="/login" className="bg-amber-500 hover:bg-amber-400 text-white px-4 py-2 rounded-lg transition">Sign In</Link>
              </>
            )}
          </>
        )}
      </div>
    </nav>
  );
}

