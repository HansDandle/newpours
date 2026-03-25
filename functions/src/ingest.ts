import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp();
const adminDb = admin.firestore();

const TABC_ISSUED_API  = 'https://data.texas.gov/resource/7hf9-qc9f.json';
const TABC_PENDING_API = 'https://data.texas.gov/resource/mxm5-tdpj.json';

type EstablishmentClassification = 'TRULY_NEW' | 'PENDING_NEW' | 'RENEWAL' | 'TRANSFER_OR_CHANGE' | 'REOPENED' | 'UNKNOWN';

/** Normalizes an owner name or address to a stable lookup key. */
function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\bdrive\b/g, 'dr')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

interface IssuedContext {
  /** Set of "normalizedAddress::licenseType" keys from the full API pull */
  addressTypeHistory: Set<string>;
  /** Set of "normalizedOwner::licenseType" keys from the full API pull */
  ownerTypeHistory: Set<string>;
  /** The license_id of the record being classified — excluded from history checks */
  currentId: string;
}

function classifyIssued(
  record: Record<string, string>,
  context?: IssuedContext,
): {
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

  // No original_issue_date at all → TABC has never previously issued a license for this entity.
  // This is the strongest possible signal for a brand-new establishment; skip the history check
  // because any address match in the batch would be a coincidence, not evidence of a reopen.
  if (!record.original_issue_date) {
    return {
      newEstablishmentClassification: 'TRULY_NEW',
      newEstablishmentConfidence: 0.95,
      newEstablishmentReason: 'No original issue date; TABC has never previously licensed this entity',
    };
  }

  if (dayDelta === 0) {
    // original_issue_date exists and equals current_issued_date → first issuance of this license,
    // but the business may have had prior licenses at the same address under different IDs.
    // Cross-check the in-memory batch history to detect reopens.
    if (context) {
      const addrKey  = `${normalizeKey(record.address ?? '')}::${record.license_type ?? ''}`;
      const ownerKey = `${normalizeKey(record.owner ?? '')}::${record.license_type ?? ''}`;
      const hasAddrHistory  = context.addressTypeHistory.has(addrKey);
      const hasOwnerHistory = context.ownerTypeHistory.has(ownerKey);
      if (hasAddrHistory || hasOwnerHistory) {
        return {
          newEstablishmentClassification: 'REOPENED',
          newEstablishmentConfidence: 0.80,
          newEstablishmentReason: hasAddrHistory
            ? 'Prior license at same address + license type; likely new ownership or reopen'
            : 'Prior license by same owner + license type; likely new ownership or reopen',
        };
      }
    }
    return {
      newEstablishmentClassification: 'TRULY_NEW',
      newEstablishmentConfidence: 0.85,
      newEstablishmentReason: 'First-time issuance; no prior address or owner history found in current dataset',
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
  // Order by submission_date DESC so we always fetch the most recently filed applications.
  const pendingRes = await fetch(`${TABC_PENDING_API}?$limit=10000&$order=submission_date DESC`);
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

  // 2. Issued licenses — order by current_issued_date DESC so the 10,000 most recently
  // issued licenses are fetched. Without ordering, the API returns records in an arbitrary
  // internal order and recent county-level records (e.g. Travis) may be entirely missed.
  const issuedRes = await fetch(`${TABC_ISSUED_API}?$limit=10000&$order=current_issued_date DESC`);
  const issuedData = await issuedRes.json() as Record<string, string>[];

  // Build in-memory history maps for cross-referencing first-time vs reopen.
  // Each map key is "normalizedValue::licenseType". We collect ALL records first
  // so that when classifying record X we can see if any *other* record shares
  // the same address or owner+licenseType (indicating a prior/parallel presence).
  const addressTypeHistory = new Set<string>();
  const ownerTypeHistory   = new Set<string>();
  for (const r of issuedData) {
    if (!r.license_id) continue;
    const addrKey  = `${normalizeKey(r.address ?? '')}::${r.license_type ?? ''}`;
    const ownerKey = `${normalizeKey(r.owner ?? '')}::${r.license_type ?? ''}`;
    addressTypeHistory.add(addrKey);
    ownerTypeHistory.add(ownerKey);
  }

  for (const record of issuedData) {
    const id = `lic-${record.license_id}`;
    if (!record.license_id) continue;
    const isExisting = existing.has(id);
    // Remove this record's own keys before classifying so we don't
    // flag it as "has history" just because it appears in the dataset itself.
    const addrKeySelf  = `${normalizeKey(record.address ?? '')}::${record.license_type ?? ''}`;
    const ownerKeySelf = `${normalizeKey(record.owner ?? '')}::${record.license_type ?? ''}`;
    addressTypeHistory.delete(addrKeySelf);
    ownerTypeHistory.delete(ownerKeySelf);
    const context: IssuedContext = { addressTypeHistory, ownerTypeHistory, currentId: record.license_id };
    const classification = classifyIssued(record, context);
    // Restore keys for subsequent records that share the same address/owner
    addressTypeHistory.add(addrKeySelf);
    ownerTypeHistory.add(ownerKeySelf);
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
      originalIssueDate: record.original_issue_date ?? null,
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

  // 3. Deduplicate: remove pending apps that have now been issued a license.
  //    Case A (renewals): pending.primaryLicenseId matches an issued license_id.
  //    Case B (new apps): pending.masterFileId matches an issued master_file_id —
  //      this catches apps like app-XXXXX that were approved and given a new lic-YYYYY.
  const pendingSnap = await adminDb.collection('licenses')
    .where('licenseTypeLabel', '==', 'Pending Application')
    .get();
  const issuedLicenseIds = new Set(issuedData.map((r: Record<string, string>) => r.license_id).filter(Boolean));
  const issuedMasterFileIds = new Set(issuedData.map((r: Record<string, string>) => r.master_file_id).filter(Boolean));
  // Fallback: match on owner + county + licenseType for permits without a master_file_id (e.g. NT)
  const issuedOwnerKeys = new Set(
    issuedData
      .map((r: Record<string, string>) => `${(r.owner ?? '').trim().toLowerCase()}::${(r.county ?? '').trim().toLowerCase()}::${(r.license_type ?? '').trim().toLowerCase()}`)
      .filter(k => !k.startsWith('::'))
  );
  for (const doc of pendingSnap.docs) {
    const d = doc.data();
    const byRenewal = d.primaryLicenseId && issuedLicenseIds.has(d.primaryLicenseId);
    const byMasterFile = d.masterFileId && issuedMasterFileIds.has(d.masterFileId);
    const ownerKey = `${(d.ownerName ?? '').trim().toLowerCase()}::${(d.county ?? '').trim().toLowerCase()}::${(d.licenseType ?? '').trim().toLowerCase()}`;
    const byOwner = !d.masterFileId && ownerKey.length > 2 && issuedOwnerKeys.has(ownerKey);
    if (byRenewal || byMasterFile || byOwner) await doc.ref.delete();
  }

  // 4. Log run metadata
  await adminDb.collection('runs').add({
    type: 'ingest',
    count,
    updatedCount,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
});
