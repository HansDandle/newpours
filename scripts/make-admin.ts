/**
 * scripts/make-admin.ts
 *
 * One-time CLI script to grant a Firebase user the `role: 'admin'` custom claim.
 * The user must sign out and back in for the claim to take effect in their token.
 *
 * Usage:
 *   npx ts-node scripts/make-admin.ts <uid-or-email>
 *
 * Requires FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and
 * FIREBASE_ADMIN_PRIVATE_KEY to be set in .env.local (or environment).
 */

import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.local from the project root
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const identifier = process.argv[2];

if (!identifier) {
  console.error("Usage: npx ts-node scripts/make-admin.ts <uid-or-email>");
  process.exit(1);
}

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });

async function main() {
  const auth = getAuth(app);

  const userRecord = identifier.includes("@")
    ? await auth.getUserByEmail(identifier)
    : await auth.getUser(identifier);
  const uid = userRecord.uid;

  console.log(`Found user: ${userRecord.email ?? userRecord.uid}`);

  await auth.setCustomUserClaims(uid, { role: "admin" });
  console.log(`✅ Admin role set for ${uid}.`);
  console.log(`   The user must sign out and back in for the claim to take effect.`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
