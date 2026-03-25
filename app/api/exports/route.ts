import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

function csvEscape(val: unknown): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes("\"")) {
    return `"${s.replace(/\"/g, '""')}"`;
  }
  return s;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let uid: string;
  let isAdmin = false;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    uid = decoded.uid;
    isAdmin = decoded.role === "admin";
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const db = getAdminDb();
  const userSnap = await db.collection("users").doc(uid).get();
  const user = userSnap.data() as { plan?: string; planStatus?: string; lastExportAt?: { toDate(): Date } } | undefined;

  const hasProExports = (user?.plan === "pro" || user?.plan === "enterprise") && user?.planStatus === "active";
  if (!hasProExports && !isAdmin) {
    return NextResponse.json({ error: "CSV exports require an active Pro or Enterprise plan." }, { status: 403 });
  }

  // Rate limit: 1 export per 10 minutes per user (prevents repeated full-collection scans)
  const EXPORT_COOLDOWN_MS = 10 * 60 * 1000;
  if (!isAdmin && user?.lastExportAt) {
    const lastExport = typeof user.lastExportAt.toDate === "function"
      ? user.lastExportAt.toDate()
      : new Date(user.lastExportAt as any);
    if (Date.now() - lastExport.getTime() < EXPORT_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - lastExport.getTime())) / 1000);
      return NextResponse.json(
        { error: `Export rate limit: please wait ${retryAfterSec}s before exporting again.` },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      );
    }
  }

  const licensesSnap = await db.collection("licenses").get();
  const rows = licensesSnap.docs.map((d) => {
    const l = d.data() as Record<string, unknown>;
    return {
      licenseNumber: d.id,
      businessName: l.businessName,
      address: l.address,
      city: l.city,
      county: l.county,
      licenseType: l.licenseType,
      status: l.status,
      filedDate: l.applicationDate,
      classification: l.newEstablishmentClassification,
    };
  });

  const headers = [
    "licenseNumber",
    "businessName",
    "address",
    "city",
    "county",
    "licenseType",
    "status",
    "filedDate",
    "classification",
  ];

  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h as keyof typeof row])).join(",")),
  ].join("\n");

  await Promise.all([
    db.collection("exports").add({
      userId: uid,
      createdAt: new Date(),
      recordCount: rows.length,
      filters: {},
      status: "ready",
    }),
    db.collection("users").doc(uid).update({ lastExportAt: new Date() }),
  ]);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="licenses-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
