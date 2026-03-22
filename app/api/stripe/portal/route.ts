import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { adminDb, getAdminAuth } from "@/lib/firebase-admin";

export async function POST(req: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-02-25.clover" });
  try {
    // Verify the caller's Firebase ID token — never trust a uid from the request body
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const stripeCustomerId = userSnap.data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      return NextResponse.json({ error: "No Stripe customer found" }, { status: 404 });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/account`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
