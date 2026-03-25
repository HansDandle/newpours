"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import type { UserPlan, PlanStatus } from "@/types";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  userPlan: UserPlan;
  userPlanStatus: PlanStatus;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  userPlan: "free",
  userPlanStatus: "canceled",
  isAdmin: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [userPlan, setUserPlan] = useState<UserPlan>("free");
  const [userPlanStatus, setUserPlanStatus] = useState<PlanStatus>("canceled");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (!u || !db) {
        setUserPlan("free");
        setUserPlanStatus("canceled");
        setIsAdmin(false);
        setLoading(false);
        return;
      }
      try {
        const [snap, tokenResult] = await Promise.all([
          getDoc(doc(db, "users", u.uid)),
          u.getIdTokenResult(false),
        ]);
        const data = snap.data() as { plan?: UserPlan; planStatus?: PlanStatus } | undefined;
        setUserPlan(data?.plan ?? "free");
        setUserPlanStatus(data?.planStatus ?? "canceled");
        setIsAdmin(tokenResult.claims.role === "admin");
      } catch {
        setUserPlan("free");
        setUserPlanStatus("canceled");
        setIsAdmin(false);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, userPlan, userPlanStatus, isAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
