"use client";
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
      router.push("/dashboard");
    } catch (err) {
      alert("Sign in failed: " + (err as Error).message);
    }
  };
  return (
    <section className="min-h-[80vh] flex flex-col items-center justify-center gap-6">
      <div className="bg-white rounded-2xl shadow-lg p-10 flex flex-col items-center gap-4 border border-gray-100 max-w-sm w-full">
        <span className="text-3xl font-bold text-[#1a2233]">NewPours</span>
        <p className="text-gray-500 text-sm text-center">Sign in to access your TABC license alerts dashboard.</p>
        <button
          className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 hover:border-amber-400 text-gray-700 font-medium px-6 py-3 rounded-lg shadow-sm transition"
          onClick={handleGoogleSignIn}
        >
          <svg width="20" height="20" viewBox="0 0 48 48"><g><path fill="#4285F4" d="M43.6 20.4H42V20H24v8h11.3C33.7 32.1 29.3 35 24 35c-6.1 0-11-4.9-11-11s4.9-11 11-11c2.8 0 5.3 1 7.2 2.7l5.7-5.7C33.5 7.1 29 5 24 5 12.9 5 4 13.9 4 25s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.6z"/><path fill="#34A853" d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c2.8 0 5.3 1 7.2 2.7l5.7-5.7C33.5 7.1 29 5 24 5c-7.7 0-14.3 4.5-17.7 9.7z"/><path fill="#FBBC05" d="M24 45c4.9 0 9.3-1.8 12.7-4.7l-6-5.1C29 36.9 26.6 38 24 38c-5.3 0-9.7-3.3-11.3-8H6.3C9.7 40.5 16.3 45 24 45z"/><path fill="#EA4335" d="M43.6 20.4H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6 5.1C40.7 36.7 44 31.3 44 25c0-1.2-.1-2.4-.4-3.6z"/></g></svg>
          Sign in with Google
        </button>
      </div>
    </section>
  );
}
