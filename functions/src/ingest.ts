import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const adminDb = admin.firestore();

const TABC_ISSUED_API  = 'https://data.texas.gov/resource/7hf9-qc9f.json';
const TABC_PENDING_API = 'https://data.texas.gov/resource/mxm5-tdpj.json';

type EstablishmentClassification = 'TRULY_NEW' | 'PENDING_NEW' | 'RENEWAL' | 'TRANSFER_OR_CHANGE' | 'UNKNOWN';

function daysBetween(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const ad = new Date(a).getTime();
  const bd = new Date(b).getTime();
  if (Number.isNaN(ad) || Number.isNaN(bd)) return null;
  return Math.floor(Math.abs(ad - bd) / 86400000);
}

function classifyPending(record: Record<string, string>): {
  newEstablishmentClassification: EstablishmentClassification;
  newEstablishmentConfidence: number;
  newEstablishmentReason: string;
} {
  if (record.primary_license_id) {
    return {
      newEstablishmentClassification: 'RENEWAL',
      newEstablishmentConfidence: 0.9,
      newEstablishmentReason: 'Pending application references existing primary license',
    };
  }

  return {
    newEstablishmentClassification: 'PENDING_NEW',
    newEstablishmentConfidence: 0.85,
    newEstablishmentReason: 'Pending application has no linked primary license',
  };
}

function classifyIssued(record: Record<string, string>): {
  newEstablishmentClassification: EstablishmentClassification;
  newEstablishmentConfidence: number;
  newEstablishmentReason: string;
} {
  const secondary = (record.secondary_status ?? '').toLowerCase();
  if (secondary.includes('renew') || secondary.includes('transfer') || secondary.includes('change')) {
    return {
      newEstablishmentClassification: secondary.includes('renew') ? 'RENEWAL' : 'TRANSFER_OR_CHANGE',
      newEstablishmentConfidence: 0.85,
      newEstablishmentReason: `Secondary status indicates ${record.secondary_status}`,
    };
  }

  const dayDelta = daysBetween(record.original_issue_date, record.current_issued_date);
  if (dayDelta !== null && dayDelta > 120) {
    return {
      newEstablishmentClassification: 'RENEWAL',
      newEstablishmentConfidence: 0.8,
      newEstablishmentReason: 'Current issue date is far after original issue date',
    };
  }

  if (!record.original_issue_date || dayDelta === 0) {
    return {
      newEstablishmentClassification: 'TRULY_NEW',
      newEstablishmentConfidence: 0.9,
      newEstablishmentReason: 'First-time issuance signal from issue dates',
    };
  }

  return {
    newEstablishmentClassification: 'UNKNOWN',
    newEstablishmentConfidence: 0.5,
    newEstablishmentReason: 'Insufficient renewal/new indicators',
  };
}

export const ingestTABC = onSchedule({ schedule: '0 6 * * *', timeZone: 'America/Chicago' }, async () => {
  const snapshot = await adminDb.collection('licenses').get();
  const existing = new Set(snapshot.docs.map(doc => doc.id));
  let count = 0;
  let updatedCount = 0;

  // 1. Pending applications
  const pendingRes = await fetch(`${TABC_PENDING_API}?$limit=10000`);
  const pendingData = await pendingRes.json() as Record<string, string>[];
  for (const record of pendingData) {
    const id = `app-${record.applicationid}`;
    if (!record.applicationid) continue;
    const isExisting = existing.has(id);
    const classification = classifyPending(record);
    const payload = {
      licenseNumber: id,
      businessName: record.trade_name ?? record.owner ?? '',
      ownerName: record.owner ?? '',
      address: record.address ?? '',
      address2: record.address_2 ?? '',
      city: record.city ?? '',
      county: record.county ?? '',
      zipCode: (record.zip ?? '').slice(0, 5),
      licenseType: record.license_type ?? '',
      licenseTypeLabel: 'Pending Application',
      status: record.applicationstatus ?? 'Pending',
      applicationDate: record.submission_date ?? null,
      effectiveDate: null,
      expirationDate: null,
      tradeName: record.trade_name ?? '',
      phone: record.phone ?? '',
      winePercent: record.wine_percent ?? '',
      masterFileId: record.master_file_id ?? null,
      subordinateLicenseId: record.subordinate_license_id ?? null,
      primaryLicenseId: record.primary_license_id ?? null,
      ...classification,
    };
    await adminDb.collection('licenses').doc(id).set(
      isExisting
        ? payload
        : {
            ...payload,
            isNew: true,
            firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          },
      { merge: true }
    );
    if (isExisting) updatedCount++;
    else count++;
  }

  // 2. Issued licenses
  const issuedRes = await fetch(`${TABC_ISSUED_API}?$limit=10000`);
  const issuedData = await issuedRes.json() as Record<string, string>[];
  for (const record of issuedData) {
    const id = `lic-${record.license_id}`;
    if (!record.license_id) continue;
    const isExisting = existing.has(id);
    const classification = classifyIssued(record);
    const payload = {
      licenseNumber: id,
      businessName: record.trade_name ?? '',
      ownerName: record.owner ?? '',
      address: record.address ?? '',
      address2: record.address_2 ?? '',
      city: record.city ?? '',
      county: record.county ?? '',
      zipCode: (record.zip ?? '').slice(0, 5),
      licenseType: record.license_type ?? '',
      licenseTypeLabel: record.tier ?? '',
      status: record.primary_status ?? '',
      tradeName: record.trade_name ?? '',
      phone: record.phone ?? '',
      winePercent: record.wine_percent ?? '',
      legacyClp: record.legacy_clp ?? '',
      secondaryStatus: record.secondary_status ?? '',
      subordinates: record.subordinates ?? '',
      statusChangeDate: record.status_change_date ?? null,
      masterFileId: record.master_file_id ?? null,
      mailAddress: record.mail_address ?? '',
      mailAddress2: record.mail_address_2 ?? '',
      mailCity: record.mail_city ?? '',
      mailZip: (record.mail_zip ?? '').slice(0, 5),
      applicationDate: record.current_issued_date ?? null,
      effectiveDate: record.current_issued_date ?? null,
      expirationDate: record.expiration_date ?? null,
      ...classification,
    };
    await adminDb.collection('licenses').doc(id).set(
      isExisting
        ? payload
        : {
            ...payload,
            isNew: true,
            firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          },
      { merge: true }
    );
    if (isExisting) updatedCount++;
    else count++;
  }

  // 3. Deduplicate: remove pending apps that have now been issued a license
  const pendingSnap = await adminDb.collection('licenses')
    .where('licenseTypeLabel', '==', 'Pending Application')
    .get();
  const issuedIds = new Set(issuedData.map((r: Record<string, string>) => r.license_id).filter(Boolean));
  for (const doc of pendingSnap.docs) {
    const pid = doc.data().primaryLicenseId;
    if (pid && issuedIds.has(pid)) await doc.ref.delete();
  }

  // 4. Log run metadata
  await adminDb.collection('runs').add({
    type: 'ingest',
    count,
    updatedCount,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
});
