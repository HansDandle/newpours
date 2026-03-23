"use client";
import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";
import { auth } from "@/lib/firebase";

/**
 * Wraps admin routes. Renders 404 content for:
 * - Unauthenticated users
 * - Authenticated users who lack the `role: 'admin'` custom claim
 */

type ClaimState = "loading" | "admin" | "denied";

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [claimState, setClaimState] = useState<ClaimState>("loading");

  useEffect(() => {
    if (loading) return;

    if (!user) {
      setClaimState("denied");
      return;
    }

    // Real users: verify `role: 'admin'` custom claim
    if (!auth || !user.getIdTokenResult) {
      setClaimState("denied");
      return;
    }

    user
      .getIdTokenResult(/* forceRefresh */ false)
      .then((result) => {
        if (result.claims.role === "admin") {
          setClaimState("admin");
        } else {
          setClaimState("denied");
        }
      })
      .catch(() => setClaimState("denied"));
  }, [user, loading]);

  if (loading || claimState === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <div className="text-gray-400 text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  // Return 404-style content — not 403 — to avoid revealing the route exists
  if (claimState === "denied") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <div className="text-center">
          <p className="text-6xl font-bold text-gray-700">404</p>
          <p className="text-gray-500 mt-2 text-sm">Page not found.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
