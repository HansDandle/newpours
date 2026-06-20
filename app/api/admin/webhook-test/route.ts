import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

/** Sends a sample lead.created payload to the configured webhook so the user can verify wiring. */
export async function POST(request: NextRequest) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authorization.slice(7));
    if (decoded.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const db = getAdminDb();
  const snap = await db.doc("settings/integrations").get();
  const settings = snap.exists ? (snap.data() as Record<string, unknown>) : null;
  const url = String(settings?.webhookUrl ?? "");
  if (!url) return NextResponse.json({ error: "No webhook URL configured." }, { status: 400 });

  const payload = {
    event: "lead.created",
    test: true,
    lead: {
      id: "sample",
      businessName: "Sample Coffee Co.",
      address: "123 Test St",
      city: "Austin",
      county: "Travis",
      zipCode: "78701",
      phones: ["(512) 555-0100"],
      website: null,
      sources: [{ type: "tabs_permit", sourceId: "TABS2026000000", estimatedCost: 250000, openingDate: "2026-09-01" }],
      signals: ["build_out", "opening_soon", "no_website"],
      stage: "new",
    },
    sentAt: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = String(settings?.secret ?? "");
  if (secret) headers["X-NewPours-Signature"] = crypto.createHmac("sha256", secret).update(body).digest("hex");

  let status = 0;
  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetch(url, { method: "POST", headers, body });
    status = res.status;
    ok = res.ok;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }

  await db.collection("system/webhookDeliveries/items").add({
    event: "lead.created",
    leadId: "sample",
    businessName: "Sample Coffee Co.",
    url,
    status,
    ok,
    error,
    test: true,
    at: new Date(),
  });

  return NextResponse.json({ sent: true, status, ok, error });
}
