"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth } from "@/lib/firebase";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  devSignOut: () => void;
}

const DEV_KEY = "np_dev_auth";

// Minimal fake User shape so the rest of the app treats it as logged in
const DEV_USER = {
  uid: "dev-admin",
  email: "admin@newpours.dev",
  displayName: "Admin (dev)",
} as unknown as User;

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  devSignOut: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Dev bypass: if the flag is set, skip Firebase and use the fake user
    if (typeof window !== "undefined" && localStorage.getItem(DEV_KEY) === "1") {
      setUser(DEV_USER);
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const devSignOut = () => {
    localStorage.removeItem(DEV_KEY);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, devSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

/** Call this from the login page to activate the dev bypass */
export function devLogin() {
  if (typeof window !== "undefined") localStorage.setItem(DEV_KEY, "1");
}
