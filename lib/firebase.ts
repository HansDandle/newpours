import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
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
  ? (getApps().length ? getApps()[0] : initializeApp(firebaseConfig))
  : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const auth = (isBrowser && app) ? getAuth(app) : null as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = (isBrowser && app) ? getFirestore(app) : null as any;
