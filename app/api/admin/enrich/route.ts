import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authorization.slice(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    if (decoded.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const source = searchParams.get("source") ?? "all";

  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const db = getAdminDb();
  const ref = await db.collection("system/adminTriggers/items").add({
    jobName: "enrich_single",
    establishmentId: id,
    source,
    requestedAt: new Date(),
    status: "queued",
  });

  return NextResponse.json({ queued: true, jobId: ref.id });
}
