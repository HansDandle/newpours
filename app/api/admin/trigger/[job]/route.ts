import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";

const TRIGGER_COOLDOWN_MINUTES = 20;
const TABC_ISSUED_API = "https://data.texas.gov/resource/7hf9-qc9f.json";
const TABC_PENDING_API = "https://data.texas.gov/resource/mxm5-tdpj.json";

const VALID_JOBS = [
  "tabc_ingest",
  "dedup_pending",
  "comptroller_update",
  "google_places_refresh",
  "health_inspections",
  "building_permits",
];

function toSocrataDate(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function escapeSocrataString(value: string): string {
  return value.replace(/'/g, "''");
}

async function fetchSocrataCount(
  endpoint: string,
  dateField: string,
  sinceIso: string,
  county?: string
): Promise<number | null> {
  const escapedCounty = county ? escapeSocrataString(county) : null;
  const sinceNoMillis = sinceIso.replace(/\.\d{3}Z$/, "");
  const sinceDateOnly = sinceIso.slice(0, 10);

  const dateLiterals = [sinceIso, sinceNoMillis, sinceDateOnly];
  const whereClauses: string[] = [];

  for (const literal of dateLiterals) {
    if (escapedCounty) {
      whereClauses.push(`${dateField} >= '${literal}' AND upper(county) = upper('${escapedCounty}')`);
    }
    whereClauses.push(`${dateField} >= '${literal}'`);
  }

  for (const whereClause of whereClauses) {
    const params = new URLSearchParams({
      "$select": "count(*)",
      "$where": whereClause,
      "$limit": "1",
    });

    const res = await fetch(`${endpoint}?${params.toString()}`);
    if (!res.ok) continue;

    const rows = await res.json();
    const first = Array.isArray(rows) ? rows[0] : null;
    if (!first || typeof first !== "object") continue;

    const raw = Object.values(first)[0];
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

async function buildPreview(
  db: ReturnType<typeof getAdminDb>,
  job: string,
  county: string,
  lookbackMonths: number,
  revenueMonth?: string,
  minRevenue?: number,
  onlyMissingGoogle?: boolean,
  establishmentIds?: string[]
) {
  const since = new Date();
  since.setMonth(since.getMonth() - lookbackMonths);
  const sinceIso = toSocrataDate(since);

  if (job === "tabc_ingest") {
    const [issuedCount, pendingCount] = await Promise.all([
      fetchSocrataCount(TABC_ISSUED_API, "current_issued_date", sinceIso, county || undefined),
      fetchSocrataCount(TABC_PENDING_API, "submission_date", sinceIso, county || undefined),
    ]);

    const knownIssued = issuedCount ?? 0;
    const knownPending = pendingCount ?? 0;
    const total = knownIssued + knownPending;

    return {
      preview: true,
      job,
      scope: {
        county: county || "all",
        lookbackMonths,
      },
      estimatedRecords: total,
      estimatedFirestoreReads: 0,
      estimatedFirestoreWrites: total,
      estimatedExternalCalls: 2,
      notes: issuedCount == null || pendingCount == null
        ? ["One or more source count endpoints failed; estimate may be partial."]
        : [],
    };
  }

  if (job === "health_inspections") {
    let query = db.collection("establishments") as FirebaseFirestore.Query;
    if (county) query = query.where("county", "==", county);

    const snap = await query.limit(500).get();
    const candidates = snap.size;

    return {
      preview: true,
      job,
      scope: {
        county: county || "all",
        lookbackMonths,
      },
      estimatedRecords: candidates,
      estimatedFirestoreReads: candidates,
      estimatedFirestoreWrites: candidates * 2,
      estimatedExternalCalls: candidates,
      notes: [
        "Health inspections run is capped at 500 establishments per trigger.",
        "Writes estimate assumes one establishment update + one enrichment log per establishment.",
      ],
    };
  }

  if (job === "comptroller_update") {
    return {
      preview: true,
      job,
      scope: {
        county: county || "all",
        lookbackMonths,
      },
      estimatedRecords: 0,
      estimatedFirestoreReads: 0,
      estimatedFirestoreWrites: 1,
      estimatedExternalCalls: 0,
      notes: ["Manual trigger currently queues the job; full monthly processing runs in scheduled function logic."],
    };
  }

  if (job === "google_places_refresh" || job === "building_permits") {
    let query = db.collection("establishments") as FirebaseFirestore.Query;
    if (county) query = query.where("county", "==", county);

    const targetIdSet = new Set((establishmentIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean));
    const snap = await query.limit(5000).get();
    const since = new Date();
    since.setMonth(since.getMonth() - lookbackMonths);

    const candidates = snap.docs.filter((doc) => {
      if (targetIdSet.size > 0 && !targetIdSet.has(doc.id)) return false;

      const data = doc.data() as Record<string, any>;
      const rawDate = data.applicationDate ?? data.firstSeenAt ?? data.effectiveDate;
      const date = typeof rawDate?.toDate === "function" ? rawDate.toDate() : new Date(rawDate ?? 0);
      if (Number.isNaN(date.getTime()) || date < since) return false;

      if (job === "google_places_refresh") {
        if (onlyMissingGoogle) {
          const status = String(data.enrichment?.googlePlaces ?? data["enrichment.googlePlaces"] ?? "").trim().toLowerCase();
          if (status === "complete") return false;
        }

        if (revenueMonth || minRevenue != null) {
          // Monthly records now live in subcollection; preview estimation uses latestMonthRevenue
          // as a proxy. Exact historical month filtering isn't available in the preview estimator.
          const latestMonth = String(data.comptroller?.revenueDataThrough ?? data["comptroller.revenueDataThrough"] ?? "");
          const latestRevenue = Number(data.comptroller?.latestMonthRevenue ?? data["comptroller.latestMonthRevenue"]);
          const revenue = Number.isFinite(latestRevenue) && latestRevenue > 0 ? latestRevenue : null;

          // If a specific month is requested but doesn't match latest, include conservatively
          if (!revenueMonth || latestMonth === revenueMonth) {
            if (revenue == null || (minRevenue != null && revenue < minRevenue)) return false;
          }
        }
      }

      return true;
    }).length;

    return {
      preview: true,
      job,
      scope: {
        county: county || "all",
        lookbackMonths,
        targetedIds: targetIdSet.size,
      },
      estimatedRecords: candidates,
      estimatedFirestoreReads: candidates,
      estimatedFirestoreWrites: candidates * 2,
      estimatedExternalCalls: job === "google_places_refresh" ? candidates * 2 : candidates,
      notes: job === "building_permits"
        ? ["Building permits currently enrich only Austin-supported records; unsupported jurisdictions are marked unavailable."]
        : [
            "Google Places refresh runs against establishments in the selected lookback window.",
            ...(revenueMonth || minRevenue != null ? [`Revenue filter applied${revenueMonth ? ` for month ${revenueMonth}` : ""}${minRevenue != null ? ` with minimum ${minRevenue}` : ""}.`] : []),
            ...(onlyMissingGoogle ? ["Only establishments without a complete Google match are included."] : []),
          ],
    };
  }

  return {
    preview: true,
    job,
    scope: {
      county: county || "all",
      lookbackMonths,
    },
    estimatedRecords: 0,
    estimatedFirestoreReads: 0,
    estimatedFirestoreWrites: 0,
    estimatedExternalCalls: 0,
    notes: ["No preview estimator available for this job."],
  };
}

export async function POST(
  request: NextRequest,
  context: { params: { job: string } | Promise<{ job: string }> }
) {
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

  const resolvedParams = await Promise.resolve(context.params as { job: string } | Promise<{ job: string }>);
  const pathJob = request.nextUrl.pathname.split("/").pop() ?? "";
  const job = decodeURIComponent((resolvedParams?.job ?? pathJob) || "").trim().toLowerCase();

  if (!VALID_JOBS.includes(job)) {
    return NextResponse.json(
      {
        error: "Unknown job",
        received: job,
        validJobs: VALID_JOBS,
      },
      { status: 400 }
    );
  }

  let body: {
    county?: string;
    lookbackMonths?: number;
    preview?: boolean;
    revenueMonth?: string;
    minRevenue?: number;
    onlyMissingGoogle?: boolean;
    establishmentIds?: string[];
  } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const county = (body.county ?? "").trim();
  const revenueMonth = (body.revenueMonth ?? "").trim();
  const establishmentIds = Array.isArray(body.establishmentIds)
    ? Array.from(new Set(body.establishmentIds.map((value) => String(value ?? "").trim()).filter(Boolean))).slice(0, 1000)
    : [];
  const minRevenueRaw = Number(body.minRevenue);
  const minRevenue = Number.isFinite(minRevenueRaw) ? minRevenueRaw : undefined;
  const onlyMissingGoogle = body.onlyMissingGoogle === true;
  const lookbackMonthsRaw = Number(body.lookbackMonths ?? 24);
  const lookbackMonths = Number.isFinite(lookbackMonthsRaw)
    ? Math.min(Math.max(Math.floor(lookbackMonthsRaw), 1), 24)
    : 24;
  const preview = body.preview === true;

  // Write a trigger doc to Firestore — the Cloud Function watches this collection
  const db = getAdminDb();
  if (preview) {
    const previewResult = await buildPreview(db, job, county, lookbackMonths, revenueMonth || undefined, minRevenue, onlyMissingGoogle, establishmentIds);
    return NextResponse.json(previewResult);
  }

  const cooldownStart = new Date(Date.now() - TRIGGER_COOLDOWN_MINUTES * 60 * 1000);
  const recent = await db
    .collection("system/adminTriggers/items")
    .where("requestedAt", ">=", cooldownStart)
    .limit(50)
    .get();

  const existing = recent.docs.find((d) => {
    const row = d.data() as { jobName?: string; status?: string };
    return row.jobName === job && (row.status === "queued" || row.status === "running");
  });

  if (existing) {
    return NextResponse.json(
      {
        error: "Job is already queued/running. Please wait before retrying.",
        cooldownMinutes: TRIGGER_COOLDOWN_MINUTES,
      },
      { status: 429 }
    );
  }

  const ref = await db.collection("system/adminTriggers/items").add({
    jobName: job,
    county: county || null,
    lookbackMonths,
    revenueMonth: revenueMonth || null,
    minRevenue: minRevenue ?? null,
    onlyMissingGoogle,
    establishmentIds,
    requestedAt: new Date(),
    status: "queued",
  });

  return NextResponse.json({ queued: true, jobId: ref.id });
}
