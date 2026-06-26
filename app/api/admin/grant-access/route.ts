/**
 * Admin grant/revoke comped access.
 *
 * Lets an admin give a specific person full ("pro") access without making them
 * an admin and without Stripe — the existing plan gate (fullAccess = isAdmin ||
 * pro/enterprise active) does the rest. Grants are applied to the user's
 * `users/{uid}` doc, so the person must have signed up (free) at least once.
 *
 *   POST /api/admin/grant-access  { email, action: "grant" | "revoke", plan? }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

const GRANTABLE_PLANS = new Set(["pro", "enterprise"]);

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let adminUid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authorization.slice(7));
    if (decoded.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    adminUid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let body: { email?: string; action?: string; plan?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const action = String(body.action ?? "grant").trim().toLowerCase();
  const plan = String(body.plan ?? "pro").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (action !== "grant" && action !== "revoke") {
    return NextResponse.json({ error: "action must be 'grant' or 'revoke'." }, { status: 400 });
  }
  if (action === "grant" && !GRANTABLE_PLANS.has(plan)) {
    return NextResponse.json({ error: "plan must be 'pro' or 'enterprise'." }, { status: 400 });
  }

  // The grant attaches to the user's account, so they must have signed up first.
  let userRecord;
  try {
    userRecord = await getAdminAuth().getUserByEmail(email);
  } catch {
    return NextResponse.json(
      { error: `No account found for ${email}. Ask them to sign up (free) first, then grant access.` },
      { status: 404 }
    );
  }

  const db = getAdminDb();
  const ref = db.collection("users").doc(userRecord.uid);
  const now = new Date();

  if (action === "revoke") {
    await ref.set(
      {
        plan: "free",
        planStatus: "canceled",
        compedAccess: false,
        compedRevokedAt: now,
        compedBy: adminUid,
      },
      { merge: true }
    );
    return NextResponse.json({ ok: true, action, email, uid: userRecord.uid, plan: "free" });
  }

  await ref.set(
    {
      email: userRecord.email ?? email,
      plan,
      planStatus: "active",
      compedAccess: true, // comped (not Stripe-billed) — distinguishes from paying subs
      compedAt: now,
      compedBy: adminUid,
    },
    { merge: true }
  );

  return NextResponse.json({ ok: true, action, email, uid: userRecord.uid, plan });
}
