import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase-admin";

// The proxy is an admin-only tool (TABC/TDLR API explorer). Restrict the
// destinations to known public data hosts so it can't be abused for SSRF.
const ALLOWED_HOSTS = new Set([
  "data.texas.gov",
  "data.austintexas.gov",
  "www.tdlr.texas.gov",
]);

export async function GET(req: NextRequest) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authorization.slice(7));
    if (decoded.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const url = req.nextUrl.searchParams.get("url");
  if (!url || !/^https:\/\//.test(url)) {
    return NextResponse.json({ error: "Missing or invalid url param" }, { status: 400 });
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.has(host)) {
    return NextResponse.json({ error: `Host not allowed: ${host}` }, { status: 403 });
  }
  try {
    const res = await fetch(url);
    const contentType = res.headers.get("content-type") || "application/json";
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "content-type": contentType },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
