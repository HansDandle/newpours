/**
 * Admin helper (no ts-node needed).
 *
 *   node scripts/admin-tool.mjs                 # list all users with role:admin
 *   node scripts/admin-tool.mjs <uid-or-email>  # grant role:admin to that user
 *
 * Reads FIREBASE_ADMIN_* from .env.local. After granting, the user must sign
 * out and back in for the claim to take effect.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[k]) process.env[k] = v;
}

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const auth = getAuth();
const identifier = process.argv[2];

if (identifier) {
  const rec = identifier.includes('@') ? await auth.getUserByEmail(identifier) : await auth.getUser(identifier);
  await auth.setCustomUserClaims(rec.uid, { role: 'admin' });
  console.log(`✅ Granted role:admin to ${rec.email ?? rec.uid}. Sign out and back in for it to take effect.`);
  process.exit(0);
}

// List mode (read-only): page through users and report admins + sign-in methods.
console.log(`Project: ${process.env.FIREBASE_ADMIN_PROJECT_ID}\n`);
let pageToken;
let total = 0;
const admins = [];
const allEmails = [];
do {
  const res = await auth.listUsers(1000, pageToken);
  for (const u of res.users) {
    total++;
    const providers = u.providerData.map((p) => p.providerId).join(',') || 'password';
    allEmails.push(`${u.email ?? '(no email)'} [${providers}]`);
    if (u.customClaims?.role === 'admin') admins.push(`${u.email ?? u.uid} [${providers}]`);
  }
  pageToken = res.pageToken;
} while (pageToken);

console.log(`${total} total user(s).`);
console.log(`\nAdmins (role:admin claim):`);
if (admins.length === 0) console.log('  (none — no user has the admin claim yet)');
else admins.forEach((a) => console.log('  ✔ ' + a));
console.log(`\nAll users:`);
allEmails.forEach((e) => console.log('  - ' + e));
process.exit(0);
