import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  browserLocalPersistence,
  browserPopupRedirectResolver,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Initialize only in the browser and when NEXT_PUBLIC env vars are present.
// This avoids calling Firebase during server-side rendering or in toolchains
// (like Turbopack) where `process.env` may be undefined at module-eval time.
const isBrowser = typeof window !== 'undefined';
const hasPublicKey = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

const app = isBrowser && hasPublicKey
  ? (getApps().length ? getApp() : initializeApp(firebaseConfig))
  : null;

// Use initializeAuth with explicit persistence + popup resolver to prevent
// "INTERNAL ASSERTION FAILED: Pending promise was never set" with signInWithPopup.
// Falls back to getAuth() if initializeAuth already ran (HMR re-execution).
function buildAuth(firebaseApp: ReturnType<typeof initializeApp>) {
  try {
    return initializeAuth(firebaseApp, {
      persistence: browserLocalPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    // initializeAuth throws if auth was already initialized for this app
    return getAuth(firebaseApp);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const auth = (isBrowser && app) ? buildAuth(app) : null as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = (isBrowser && app) ? getFirestore(app) : null as any;
