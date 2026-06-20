import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side Turnstile siteverify (browser -> here -> Cloudflare).
 * If no secret is configured, returns success so auth forms aren't blocked
 * before keys are set up. Once TURNSTILE_SECRET_KEY is present, it enforces.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return NextResponse.json({ success: true, skipped: true });

  const { token } = await req.json().catch(() => ({ token: null }));
  if (!token) {
    return NextResponse.json({ success: false, error: "missing-token" }, { status: 400 });
  }

  const ipHeader = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "";
  const form = new URLSearchParams({ secret, response: String(token) });
  const ip = ipHeader.split(",")[0]?.trim();
  if (ip) form.set("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    return NextResponse.json({ success: !!data.success, errors: data["error-codes"] ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "siteverify-failed" },
      { status: 502 }
    );
  }
}
