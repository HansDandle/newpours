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
    timeoutSeconds: 540,
    memory: '512MiB',
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
        const INGEST_LIMIT = 10000;
        // Push county filter into the API query to avoid fetching all 10K records
        const countyApiFilter = countyFilter
          ? `&$where=${encodeURIComponent(`lower(county)='${countyFilter.replace(/'/g, "''")}'`)}`
          : '';
        const [issuedRes, pendingRes] = await Promise.all([
          fetch(`${TABC_ISSUED_API}?$limit=${INGEST_LIMIT}&$order=current_issued_date DESC${countyApiFilter}`),
          fetch(`${TABC_PENDING_API}?$limit=${INGEST_LIMIT}&$order=submission_date DESC${countyApiFilter}`),
        ]);
        const issued: Record<string, string>[] = await issuedRes.json();
        const pending: Record<string, string>[] = await pendingRes.json();

        // Snapshot existing license IDs for isNew detection
        const existingSnap = await db.collection('licenses').get();
        const existing = new Set(existingSnap.docs.map(d => d.id));

        // Write pending applications to licenses collection
        for (const r of pending) {
          if (!r.applicationid) continue;
          if (countyFilter && (r.county ?? '').toLowerCase().trim() !== countyFilter) continue;
          if (!inLookbackWindow(r.submission_date, since)) continue;

          const id = `app-${r.applicationid}`;
          const isExisting = existing.has(id);
          const payload = {
            licenseNumber: id,
            businessName: r.trade_name ?? r.owner ?? '',
            ownerName: r.owner ?? '',
            address: r.address ?? '',
            address2: r.address_2 ?? '',
            city: r.city ?? '',
            county: r.county ?? '',
            zipCode: (r.zip ?? '').slice(0, 5),
            licenseType: r.license_type ?? '',
            licenseTypeLabel: 'Pending Application',
            status: r.applicationstatus ?? 'Pending',
            applicationDate: r.submission_date ?? null,
            effectiveDate: null as null,
            expirationDate: null as null,
            tradeName: r.trade_name ?? '',
            phone: r.phone ?? '',
            winePercent: r.wine_percent ?? '',
            mailAddress: r.mail_address ?? '',
            mailCity: r.mail_city ?? '',
            mailZip: (r.mail_zip ?? '').slice(0, 5),
            masterFileId: r.master_file_id ?? null,
            subordinateLicenseId: r.subordinate_license_id ?? null,
            primaryLicenseId: r.primary_license_id ?? null,
            newEstablishmentClassification: r.primary_license_id ? 'RENEWAL' : 'PENDING_NEW',
            newEstablishmentConfidence: r.primary_license_id ? 0.9 : 0.85,
            newEstablishmentReason: r.primary_license_id
              ? 'Pending application references existing primary license'
              : 'Pending application has no linked primary license',
          };
          await db.collection('licenses').doc(id).set(
            isExisting
              ? payload
              : { ...payload, isNew: true, firstSeenAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          processed++;
        }

        // Write issued licenses to licenses collection with full payload
        for (const r of issued) {
          if (!r.license_id) continue;
          if (countyFilter && (r.county ?? '').toLowerCase().trim() !== countyFilter) continue;
          if (!inLookbackWindow(r.current_issued_date, since)) continue;

          const id = `lic-${r.license_id}`;
          const isExisting = existing.has(id);

          // Classify
          const secondary = (r.secondary_status ?? '').toLowerCase();
          const origMs = r.original_issue_date ? new Date(r.original_issue_date).getTime() : null;
          const currMs = r.current_issued_date ? new Date(r.current_issued_date).getTime() : null;
          const dayDelta = (origMs && currMs) ? Math.abs(currMs - origMs) / 86400000 : null;
          let newEstablishmentClassification: string;
          let newEstablishmentConfidence: number;
          let newEstablishmentReason: string;
          if (secondary.includes('renew')) {
            newEstablishmentClassification = 'RENEWAL'; newEstablishmentConfidence = 0.85;
            newEstablishmentReason = `Secondary status indicates ${r.secondary_status}`;
          } else if (secondary.includes('transfer') || secondary.includes('change')) {
            newEstablishmentClassification = 'TRANSFER_OR_CHANGE'; newEstablishmentConfidence = 0.85;
            newEstablishmentReason = `Secondary status indicates ${r.secondary_status}`;
          } else if (dayDelta !== null && dayDelta > 120) {
            newEstablishmentClassification = 'RENEWAL'; newEstablishmentConfidence = 0.8;
            newEstablishmentReason = 'Current issue date is far after original issue date';
          } else if (!r.original_issue_date || dayDelta === 0) {
            newEstablishmentClassification = 'TRULY_NEW'; newEstablishmentConfidence = 0.9;
            newEstablishmentReason = 'First-time issuance signal from issue dates';
          } else {
            newEstablishmentClassification = 'UNKNOWN'; newEstablishmentConfidence = 0.5;
            newEstablishmentReason = 'Insufficient indicators';
          }

          const payload = {
            licenseNumber: id,
            businessName: r.trade_name ?? r.owner ?? '',
            ownerName: r.owner ?? '',
            address: r.address ?? '',
            address2: r.address_2 ?? '',
            city: r.city ?? '',
            county: r.county ?? '',
            zipCode: (r.zip ?? '').slice(0, 5),
            licenseType: r.license_type ?? '',
            licenseTypeLabel: r.tier ?? '',
            status: r.primary_status ?? '',
            tradeName: r.trade_name ?? '',
            phone: r.phone ?? '',
            winePercent: r.wine_percent ?? '',
            legacyClp: r.legacy_clp ?? '',
            secondaryStatus: r.secondary_status ?? '',
            subordinates: r.subordinates ?? '',
            statusChangeDate: r.status_change_date ?? null,
            masterFileId: r.master_file_id ?? null,
            mailAddress: r.mail_address ?? '',
            mailAddress2: r.mail_address_2 ?? '',
            mailCity: r.mail_city ?? '',
            mailZip: (r.mail_zip ?? '').slice(0, 5),
            originalIssueDate: r.original_issue_date ?? null,
            applicationDate: r.current_issued_date ?? null,
            effectiveDate: r.current_issued_date ?? null,
            expirationDate: r.expiration_date ?? null,
            newEstablishmentClassification,
            newEstablishmentConfidence,
            newEstablishmentReason,
          };
          await db.collection('licenses').doc(id).set(
            isExisting
              ? payload
              : { ...payload, isNew: true, firstSeenAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          // Mirror into establishments so the enrichment trigger fires for new issued licenses.
          const estPayload = {
            licenseNumber: id,
            businessName: r.trade_name ?? r.owner ?? '',
            ownerName: r.owner ?? '',
            tradeName: r.trade_name ?? '',
            address: r.address ?? '',
            address2: r.address_2 ?? '',
            city: r.city ?? '',
            county: r.county ?? '',
            zipCode: (r.zip ?? '').slice(0, 5),
            licenseType: r.license_type ?? '',
            licenseTypeLabel: r.tier ?? '',
            status: r.primary_status ?? '',
            phone: r.phone ?? '',
            mailAddress: r.mail_address ?? '',
            mailAddress2: r.mail_address_2 ?? '',
            mailCity: r.mail_city ?? '',
            mailZip: (r.mail_zip ?? '').slice(0, 5),
            applicationDate: r.current_issued_date ?? null,
            effectiveDate: r.current_issued_date ?? null,
            expirationDate: r.expiration_date ?? null,
            newEstablishmentClassification,
            newEstablishmentConfidence,
            newEstablishmentReason,
          };
          await db.collection('establishments').doc(id).set(
            isExisting
              ? estPayload
              : {
                  ...estPayload,
                  isNew: true,
                  firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
                  enrichment: { googlePlaces: 'pending', comptroller: 'pending', healthInspection: 'pending', buildingPermits: 'pending' },
                },
            { merge: true }
          );
          processed++;
        }

        // Deduplicate: remove pending apps that have now been issued a license.
        // Case A (renewals): pending.primaryLicenseId matches an issued license_id.
        // Case B (new apps): pending.masterFileId matches an issued master_file_id.
        const pendingSnap = await db.collection('licenses')
          .where('licenseTypeLabel', '==', 'Pending Application')
          .get();
        const issuedLicenseIds = new Set(issued.map((r: Record<string, string>) => r.license_id).filter(Boolean));
        const issuedMasterFileIds = new Set(issued.map((r: Record<string, string>) => r.master_file_id).filter(Boolean));
        // Fallback: match on owner + county + licenseType for permits without a master_file_id (e.g. NT)
        const issuedOwnerKeys = new Set(
          issued
            .map((r: Record<string, string>) => `${(r.owner ?? '').trim().toLowerCase()}::${(r.county ?? '').trim().toLowerCase()}::${(r.license_type ?? '').trim().toLowerCase()}`)
            .filter((k: string) => !k.startsWith('::'))
        );
        for (const doc of pendingSnap.docs) {
          const d = doc.data();
          const byRenewal = d.primaryLicenseId && issuedLicenseIds.has(d.primaryLicenseId);
          const byMasterFile = d.masterFileId && issuedMasterFileIds.has(d.masterFileId);
          const ownerKey = `${(d.ownerName ?? '').trim().toLowerCase()}::${(d.county ?? '').trim().toLowerCase()}::${(d.licenseType ?? '').trim().toLowerCase()}`;
          const byOwner = !d.masterFileId && ownerKey.length > 2 && issuedOwnerKeys.has(ownerKey);
          if (byRenewal || byMasterFile || byOwner) {
            await doc.ref.delete();
            // Also remove the corresponding establishments doc so it disappears from the explorer.
            await db.collection('establishments').doc(doc.id).delete();
          }
        }
      } else if (jobName === 'dedup_pending') {
        // Standalone dedup: compare pending Firestore docs against the live TABC issued API.
        // Fetches issued records but writes nothing — only deletes stale pending docs.
        const [issuedRes, pendingSnap] = await Promise.all([
          fetch(`${TABC_ISSUED_API}?$limit=10000&$order=current_issued_date DESC`),
          db.collection('licenses').where('licenseTypeLabel', '==', 'Pending Application').get(),
        ]);
        const issuedData: Record<string, string>[] = await issuedRes.json();
        const issuedLicenseIds = new Set(issuedData.map(r => r.license_id).filter(Boolean));
        const issuedMasterFileIds = new Set(issuedData.map(r => r.master_file_id).filter(Boolean));
        const issuedOwnerKeys = new Set(
          issuedData
            .map(r => `${(r.owner ?? '').trim().toLowerCase()}::${(r.county ?? '').trim().toLowerCase()}::${(r.license_type ?? '').trim().toLowerCase()}`)
            .filter(k => !k.startsWith('::'))
        );
        let removed = 0;
        for (const pdoc of pendingSnap.docs) {
          const d = pdoc.data();
          const byRenewal2 = d.primaryLicenseId && issuedLicenseIds.has(d.primaryLicenseId);
          const byMasterFile2 = d.masterFileId && issuedMasterFileIds.has(d.masterFileId);
          const ownerKey = `${(d.ownerName ?? '').trim().toLowerCase()}::${(d.county ?? '').trim().toLowerCase()}::${(d.licenseType ?? '').trim().toLowerCase()}`;
          const byOwner2 = !d.masterFileId && ownerKey.length > 2 && issuedOwnerKeys.has(ownerKey);
          if (byRenewal2 || byMasterFile2 || byOwner2) {
            await pdoc.ref.delete();
            // Also remove the corresponding establishments doc so it disappears from the explorer.
            await db.collection('establishments').doc(pdoc.id).delete();
            removed++;
          }
        }
        // Also clean up orphaned establishments docs that have no matching licenses doc
        // (can happen when licenses was already deleted by a prior dedup run).
        const estPendingSnap = await db.collection('establishments')
          .where('licenseTypeLabel', '==', 'Pending Application')
          .get();
        for (const estDoc of estPendingSnap.docs) {
          const d = estDoc.data();
          const byRenewalE = d.primaryLicenseId && issuedLicenseIds.has(d.primaryLicenseId);
          const byMasterFileE = d.masterFileId && issuedMasterFileIds.has(d.masterFileId);
          const ownerKeyE = `${(d.ownerName ?? '').trim().toLowerCase()}::${(d.county ?? '').trim().toLowerCase()}::${(d.licenseType ?? '').trim().toLowerCase()}`;
          const byOwnerE = !d.masterFileId && ownerKeyE.length > 2 && issuedOwnerKeys.has(ownerKeyE);
          if (byRenewalE || byMasterFileE || byOwnerE) {
            await estDoc.ref.delete();
            removed++;
          }
        }
        processed = removed;
        notes = `Removed ${removed} stale pending applications out of ${pendingSnap.size} licenses + ${estPendingSnap.size} establishment docs scanned.`;
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
