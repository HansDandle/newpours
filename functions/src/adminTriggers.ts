/**
 * Admin-triggered job runner.
 *
 * Watches the `system/adminTriggers/items` collection for new docs and
 * dispatches the corresponding job. Any HTTP-authenticated admin action from
 * the UI lands here.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { runComptrollerRevenueJob } from './enrichComptroller';
import { enrichHealthInspectionForEstablishment, runHealthInspectionsJob } from './enrichHealthInspections';
import { googleMapsApiKeySecret, runGooglePlacesJob } from './enrich';
import { runBuildingPermitsJob } from './enrichBuildingPermits';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const TABC_ISSUED_API = 'https://data.texas.gov/resource/7hf9-qc9f.json';
const TABC_PENDING_API = 'https://data.texas.gov/resource/mxm5-tdpj.json';

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inLookbackWindow(value: string | undefined, since: Date): boolean {
  const d = parseDate(value);
  if (!d) return false;
  return d >= since;
}

/**
 * Firestore trigger: when an admin trigger doc is created, run the job
 * and update the doc with the result.
 */
export const processAdminTrigger = onDocumentCreated(
  {
    document: 'system/adminTriggers/items/{docId}',
    secrets: [googleMapsApiKeySecret],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    if (!data || data.status !== 'queued') return;

    const { jobName, establishmentId, source } = data;
    const countyFilter = String(data.county ?? '').trim().toLowerCase();
    const lookbackMonthsRaw = Number(data.lookbackMonths ?? 24);
    const revenueMonth = String(data.revenueMonth ?? '').trim() || undefined;
    const minRevenueRaw = Number(data.minRevenue);
    const minRevenue = Number.isFinite(minRevenueRaw) ? minRevenueRaw : undefined;
    const onlyMissingGoogle = data.onlyMissingGoogle === true;
    const establishmentIds = Array.isArray(data.establishmentIds)
      ? data.establishmentIds
        .map((id: unknown) => String(id ?? '').trim())
        .filter((id: string) => id.length > 0)
      : [];
    const lookbackMonths = Number.isFinite(lookbackMonthsRaw)
      ? Math.min(Math.max(Math.floor(lookbackMonthsRaw), 1), 24)
      : 24;
    const since = new Date();
    since.setMonth(since.getMonth() - lookbackMonths);
    const startedAtMs = Date.now();

    let runRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData> | null = null;

    await snap.ref.update({ status: 'running', startedAt: admin.firestore.FieldValue.serverTimestamp() });

    runRef = await db.collection('system/jobRuns/items').add({
      jobName,
      startedAt: new Date(startedAtMs),
      status: 'running',
      recordsProcessed: 0,
      recordsFailed: 0,
      notes: `Manual trigger${countyFilter ? ` (county=${countyFilter})` : ''}, lookbackMonths=${lookbackMonths}${revenueMonth ? `, revenueMonth=${revenueMonth}` : ''}${minRevenue != null ? `, minRevenue=${minRevenue}` : ''}${onlyMissingGoogle ? ', onlyMissingGoogle=true' : ''}${establishmentIds.length ? `, targetedIds=${establishmentIds.length}` : ''}`,
    });

    try {
      let processed = 0;
      let finalStatus: 'success' | 'partial' = 'success';
      let notes: string | undefined;

      if (jobName === 'tabc_ingest') {
        const [issuedRes, pendingRes] = await Promise.all([
          fetch(`${TABC_ISSUED_API}?$limit=500&$order=current_issued_date DESC`),
          fetch(`${TABC_PENDING_API}?$limit=500&$order=submission_date DESC`),
        ]);
        const issued: Record<string, string>[] = await issuedRes.json();
        const pending: Record<string, string>[] = await pendingRes.json();

        for (const r of issued) {
          if (!r.license_id) continue;
          if (countyFilter && (r.county ?? '').toLowerCase().trim() !== countyFilter) continue;
          if (!inLookbackWindow(r.current_issued_date, since)) continue;

          await db.collection('establishments').doc(`lic-${r.license_id}`).set(
            { businessName: r.trade_name ?? '', status: r.primary_status ?? '' },
            { merge: true }
          );
          processed++;
        }
        for (const r of pending) {
          if (!r.applicationid) continue;
          if (countyFilter && (r.county ?? '').toLowerCase().trim() !== countyFilter) continue;
          if (!inLookbackWindow(r.submission_date, since)) continue;

          await db.collection('establishments').doc(`app-${r.applicationid}`).set(
            { businessName: r.trade_name ?? r.owner ?? '', status: r.applicationstatus ?? '' },
            { merge: true }
          );
          processed++;
        }
      } else if (jobName === 'health_inspections') {
        const result = await runHealthInspectionsJob(500, {
          county: countyFilter || undefined,
          lookbackDays: lookbackMonths * 30,
        });
        processed = result.processed;
        notes = `Health inspections (${lookbackMonths}mo${countyFilter ? `, county=${countyFilter}` : ''}): complete=${result.complete}, no_match=${result.noMatch}, unavailable=${result.unavailable}, error=${result.error}`;
      } else if (jobName === 'enrich_single' && establishmentId) {
        const updates: Record<string, string> = {};
        if (source === 'all' || source === 'googlePlaces') updates['enrichment.googlePlaces'] = 'pending';
        if (source === 'all' || source === 'comptroller') updates['enrichment.comptroller'] = 'pending';
        if (source === 'all' || source === 'healthInspection') updates['enrichment.healthInspection'] = 'pending';
        if (source === 'all' || source === 'buildingPermits') updates['enrichment.buildingPermits'] = 'pending';
        if (Object.keys(updates).length > 0) {
          await db.collection('establishments').doc(establishmentId).update(updates);
        }

        if (source === 'all' || source === 'healthInspection') {
          const estSnap = await db.collection('establishments').doc(establishmentId).get();
          if (estSnap.exists) {
            await enrichHealthInspectionForEstablishment(establishmentId, estSnap.data() ?? {}, 365);
          }
        }

        processed = 1;
      } else if (jobName === 'comptroller_update') {
        const result = await runComptrollerRevenueJob({
          county: countyFilter || undefined,
          lookbackMonths,
          writeUnmatched: false,
          emitPerRecordLogs: false,
        });
        processed = result.matched + result.unmatched;
        notes = `Comptroller revenue import complete (${result.monthsProcessed} month(s)${countyFilter ? `, county=${countyFilter}` : ''}): matched=${result.matched}, unmatched=${result.unmatched}. Manual mode skips unmatched writes for speed.`;
      } else if (jobName === 'google_places_refresh') {
        const result = await runGooglePlacesJob({
          county: countyFilter || undefined,
          lookbackMonths,
          revenueMonth,
          minRevenue,
          onlyMissingGoogle,
          establishmentIds: establishmentIds.length ? establishmentIds : undefined,
        });
        processed = result.processed;
        notes = `Google Places (${lookbackMonths}mo${countyFilter ? `, county=${countyFilter}` : ''}${revenueMonth ? `, revenueMonth=${revenueMonth}` : ''}${minRevenue != null ? `, minRevenue=${minRevenue}` : ''}${onlyMissingGoogle ? ', onlyMissingGoogle=true' : ''}${establishmentIds.length ? `, targetedIds=${establishmentIds.length}` : ''}): complete=${result.complete}, no_match=${result.noMatch}, error=${result.error}, skipped=${result.skipped}`;
      } else if (jobName === 'building_permits') {
        const result = await runBuildingPermitsJob({
          county: countyFilter || undefined,
          lookbackMonths,
        });
        processed = result.processed;
        notes = `Building permits (${lookbackMonths}mo${countyFilter ? `, county=${countyFilter}` : ''}): complete=${result.complete}, no_match=${result.noMatch}, unavailable=${result.unavailable}, error=${result.error}`;
      } else {
        finalStatus = 'partial';
        notes = `Admin trigger job '${jobName}' acknowledged but not implemented in processAdminTrigger yet.`;
        console.log(notes);
      }

      await snap.ref.update({
        status: finalStatus,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        recordsProcessed: processed,
        ...(notes ? { notes } : {}),
      });

      if (runRef) {
        await runRef.set(
          {
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            durationMs: Date.now() - startedAtMs,
            status: finalStatus,
            recordsProcessed: processed,
            recordsFailed: 0,
            ...(notes ? { notes } : {}),
          },
          { merge: true }
        );
      }
    } catch (err: any) {
      await snap.ref.update({
        status: 'error',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: err.message ?? String(err),
      });

      if (runRef) {
        await runRef.set(
          {
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            durationMs: Date.now() - startedAtMs,
            status: 'error',
            recordsFailed: 1,
            notes: err?.message ?? String(err),
          },
          { merge: true }
        );
      }
    }
  }
);
