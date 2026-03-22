import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const adminDb = admin.firestore();

const TABC_ISSUED_API  = 'https://data.texas.gov/resource/7hf9-qc9f.json';
const TABC_PENDING_API = 'https://data.texas.gov/resource/mxm5-tdpj.json';

export const ingestTABC = onSchedule({ schedule: '0 6 * * *', timeZone: 'America/Chicago' }, async () => {
  const snapshot = await adminDb.collection('licenses').get();
  const existing = new Set(snapshot.docs.map(doc => doc.id));
  let count = 0;

  // 1. Pending applications
  const pendingRes = await fetch(`${TABC_PENDING_API}?$limit=10000`);
  const pendingData = await pendingRes.json() as Record<string, string>[];
  for (const record of pendingData) {
    const id = `app-${record.applicationid}`;
    if (!record.applicationid || existing.has(id)) continue;
    await adminDb.collection('licenses').doc(id).set({
      licenseNumber: id,
      businessName: record.owner ?? '',
      ownerName: record.owner ?? '',
      address: record.address ?? '',
      city: record.city ?? '',
      county: record.county ?? '',
      zipCode: (record.zip ?? '').slice(0, 5),
      licenseType: record.license_type ?? '',
      licenseTypeLabel: 'Pending Application',
      status: record.applicationstatus ?? 'Pending',
      applicationDate: record.submission_date ?? null,
      effectiveDate: null,
      expirationDate: null,
      primaryLicenseId: record.primary_license_id ?? null,
      isNew: true,
      firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    count++;
  }

  // 2. Issued licenses
  const issuedRes = await fetch(`${TABC_ISSUED_API}?$limit=10000`);
  const issuedData = await issuedRes.json() as Record<string, string>[];
  for (const record of issuedData) {
    const id = `lic-${record.license_id}`;
    if (!record.license_id || existing.has(id)) continue;
    await adminDb.collection('licenses').doc(id).set({
      licenseNumber: id,
      businessName: record.trade_name ?? '',
      ownerName: record.owner ?? '',
      address: record.address ?? '',
      city: record.city ?? '',
      county: record.county ?? '',
      zipCode: (record.zip ?? '').slice(0, 5),
      licenseType: record.license_type ?? '',
      licenseTypeLabel: record.tier ?? '',
      status: record.primary_status ?? '',
      tradeName: record.trade_name ?? '',
      mailAddress: record.mail_address ?? '',
      mailCity: record.mail_city ?? '',
      mailZip: (record.mail_zip ?? '').slice(0, 5),
      applicationDate: record.current_issued_date ?? null,
      effectiveDate: record.current_issued_date ?? null,
      expirationDate: record.expiration_date ?? null,
      isNew: true,
      firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    count++;
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
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
});
