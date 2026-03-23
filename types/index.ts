// Shared TypeScript types for NewPours
// See TABC_ALERT_SPEC.md for full data models

export type UserPlan = 'free' | 'basic' | 'pro' | 'enterprise';
export type PlanStatus = 'active' | 'past_due' | 'canceled';
export type DigestTime = '6am' | '8am' | '12pm';
export type EstablishmentClassification =
  | 'TRULY_NEW'
  | 'PENDING_NEW'
  | 'RENEWAL'
  | 'TRANSFER_OR_CHANGE'
  | 'UNKNOWN';

export interface User {
  uid: string;
  email: string;
  displayName: string;
  createdAt: any; // Firestore Timestamp
  stripeCustomerId: string;
  plan: UserPlan;
  planStatus: PlanStatus;
  apiKey: string;
  webhookUrl?: string;
  filters: {
    counties: string[];
    licenseTypes: string[];
    zipCodes: string[];
  };
  emailDigest: boolean;
  digestTime: DigestTime;
  includeRenewals?: boolean;
}

export interface License {
  licenseNumber: string;
  businessName: string;
  ownerName: string;
  address: string;
  address2?: string;
  city: string;
  county: string;
  zipCode: string;
  licenseType: string;
  licenseTypeLabel: string;
  status: string;
  applicationDate: any;
  effectiveDate?: any;
  expirationDate?: any;
  primaryLicenseId?: string;
  subordinateLicenseId?: string;
  masterFileId?: string;
  tradeName?: string;
  phone?: string;
  winePercent?: string;
  legacyClp?: string;
  secondaryStatus?: string;
  subordinates?: string;
  statusChangeDate?: any;
  mailAddress?: string;
  mailAddress2?: string;
  mailCity?: string;
  mailZip?: string;
  lat?: number;
  lng?: number;
  enrichedAt?: any;
  firstSeenAt: any;
  isNew: boolean;
  newEstablishmentClassification?: EstablishmentClassification;
  newEstablishmentConfidence?: number;
  newEstablishmentReason?: string;
}

export interface Alert {
  userId: string;
  licenseNumber: string;
  deliveredAt: any;
  channel: 'email' | 'webhook' | 'dashboard';
}

export interface Export {
  userId: string;
  createdAt: any;
  filters: object;
  recordCount: number;
  downloadUrl: string;
  expiresAt: any;
}

// ─── Enrichment Pipeline Types ────────────────────────────────────────────────

export type EnrichmentStatus = 'complete' | 'no_match' | 'pending' | 'error' | 'unavailable';

export interface ComptrollerMonthRecord {
  month: string; // "YYYY-MM"
  liquorReceipts: number;
  wineReceipts: number;
  beerReceipts: number;
  coverChargeReceipts: number;
  totalReceipts: number;
}

export interface ComptrollerEnrichment {
  taxpayerNumber: string;
  monthlyRecords: ComptrollerMonthRecord[];
  latestMonthRevenue: number;
  avgMonthlyRevenue: number;
  revenueTrend: 'up' | 'flat' | 'down';
  revenueDataFrom: string;
  revenueDataThrough: string;
  confidence: number;
  matchMethod: string;
}

export interface GooglePlacesEnrichment {
  placeId: string;
  name: string;
  rating: number;
  reviewCount: number;
  priceLevel?: 1 | 2 | 3 | 4;
  phoneNumber?: string;
  website?: string;
  hours?: object;
  photoReference?: string;
  lat: number;
  lng: number;
  confidence: number;
  matchedAt: any;
}

export interface HealthInspectionRecord {
  date: any;
  score: number;
  violationCount: number;
  criticalViolationCount: number;
}

export interface HealthInspectionEnrichment {
  available: boolean;
  jurisdiction?: string;
  latestScore?: number;
  latestInspectionDate?: any;
  inspectionHistory?: HealthInspectionRecord[];
  scoreTrend?: 'improving' | 'stable' | 'declining';
  confidence?: number;
  matchedAt?: any;
  reason?: string; // when available: false
}

export interface BuildingPermitRecord {
  permitType: string;
  issueDate: any;
  description: string;
  workValue: number;
  status: string;
}

export interface BuildingPermitsEnrichment {
  available: boolean;
  jurisdiction?: string;
  recentPermits?: BuildingPermitRecord[];
  hasSignificantRecentWork?: boolean;
  largestRecentPermitValue?: number;
  confidence?: number;
  matchedAt?: any;
}

/** Enrichment status map, stored as `enrichment` field on establishment docs */
export interface EnrichmentMap {
  googlePlaces: EnrichmentStatus;
  comptroller: EnrichmentStatus;
  healthInspection: EnrichmentStatus | 'unavailable';
  buildingPermits: EnrichmentStatus | 'unavailable';
  lastEnrichedAt?: any;
}

// ─── Admin: Job Runs & Logs ────────────────────────────────────────────────────

export interface JobRun {
  id?: string;
  jobName: string;
  startedAt: any;
  completedAt?: any;
  durationMs?: number;
  status: 'success' | 'partial' | 'error' | 'running';
  recordsProcessed: number;
  recordsFailed?: number;
  notes?: string;
}

export interface EnrichmentLog {
  id?: string;
  timestamp: any;
  establishmentId: string;
  source: 'googlePlaces' | 'comptroller' | 'healthInspection' | 'buildingPermits';
  status: 'success' | 'skip' | 'error';
  confidence?: number;
  matchMethod?: string;
  message: string;
}

export interface BackfillStatus {
  tabc_complete: boolean;
  tabc_count?: number;
  tabc_completedAt?: any;
  comptroller_complete: boolean;
  comptroller_months_processed?: number;
  comptroller_records_matched?: number;
  comptroller_records_unmatched?: number;
  comptroller_completedAt?: any;
}

export interface ComptrollerUnmatched {
  id?: string;
  taxpayerNumber: string;
  taxpayerName: string;
  locationName: string;
  address: string;
  city: string;
  locationNumber: string;
  latestMonthRevenue: number;
  latestMonth: string;
  dismissed?: boolean;
  dismissReason?: string;
}
