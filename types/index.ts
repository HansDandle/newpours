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
  | 'REOPENED'
  | 'UNKNOWN';

/**
 * Vendor opportunity signals computed nightly on each establishment.
 * Surfaced as Explorer filter options for distributors, staffing, POS vendors, etc.
 */
export type VendorSignal =
  | 'new_establishment'       // TRULY_NEW or PENDING_NEW — no vendor relationships yet
  | 'reopened'                // REOPENED — fresh start, likely new ownership
  | 'ownership_change'        // TRANSFER_OR_CHANGE — new owner reviewing all contracts
  | 'license_upgrade'         // License type changed to allow new product categories
  | 'special_event_license'   // Temporary/event license — needs event staffing, temp equipment
  | 'revenue_spike'           // Month-over-month revenue >30% increase
  | 'major_renovation'        // Building permit > $50K — new POS, equipment, decor
  | 'health_violation'        // Critical health violations — may need new suppliers
  | 'expiring_soon';          // License expires within 60 days — compliance/insurance opportunity

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
  lastExportAt?: any; // Firestore Timestamp — used for export rate limiting
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
  originalIssueDate?: string | null;
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
  /** Computed nightly. Machine-readable signals useful to vendors (distributors, staffing, etc.) */
  vendorSignals?: VendorSignal[];
}

export interface Alert {
  userId: string;
  licenseNumber: string;
  deliveredAt: any;
  channel: 'email' | 'webhook' | 'dashboard';
}

// ─── Unified Leads Model (radio sales) ────────────────────────────────────────
// A `lead` is one physical business/location, merged across every source that
// references it (TABC license, TABC temp/event permit, TDLR/TABS construction
// permit, city event permit). Replaces `establishments` as the product spine.

export type LeadSourceType = 'tabc' | 'tabc_event' | 'tabs_permit' | 'event' | 'building_permit' | 'nonprofit_990' | 'attorney';

/**
 * Advertising-oriented lead-quality signals (replaces the alcohol-vendor
 * `VendorSignal` taxonomy for the new radio-sales purpose).
 */
export type LeadSignal =
  | 'opening_soon'        // pending TABC, or TABS completion within 90 days
  | 'brand_new'           // first-time TABC issuance / truly new establishment
  | 'build_out'           // active TDLR/TABS construction permit
  | 'event_upcoming'      // TABC temporary/event permit (ET/NT/TR/NB/NE)
  | 'no_website'          // no website found — likely under-marketed
  | 'multi_unit_operator' // owner tied to multiple locations
  | 'high_value_buildout' // TABS estimated cost over threshold
  | 'multifamily'         // new apartment community (Austin 5+ unit building permit)
  | 'large_nonprofit'     // nonprofit with >$1MM revenue on its latest IRS 990
  | 'heavy_advertiser';   // law firm with a high review count (proxy for ad spend)

export type CrmStage = 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';

export interface LeadSource {
  type: LeadSourceType;
  sourceId: string;            // TABS project #, or lic-/app- license id
  status?: string;
  registeredDate?: string | null;
  openingDate?: string | null; // completion (TABS) / effective (TABC) date
  estimatedCost?: number | null;
  licenseType?: string;
  detailUrl?: string;
  firstSeenAt?: any;
  raw?: Record<string, any>;
}

export interface LeadContact {
  id?: string;
  name?: string;
  role?: 'owner' | 'tenant' | 'rep' | 'google' | 'manual';
  phone?: string;
  email?: string;
  source?: string;
  createdAt?: any;
}

export interface LeadActivity {
  id?: string;
  type: 'call' | 'email' | 'note' | 'meeting' | 'stage_change';
  body?: string;
  fromStage?: CrmStage;
  toStage?: CrmStage;
  createdAt?: any;
  createdBy?: string;
}

export interface LeadCrm {
  stage: CrmStage;
  assignedTo?: string | null;
  followUpDate?: string | null;
  lastActivityAt?: any;
  lastContactedAt?: any;
}

export interface OperatorRef {
  key: string;
  name: string;
}

/** A hospitality group, managed in the `operators` collection via /admin/operators. */
export interface Operator {
  id?: string;
  name: string;
  aliases?: string[];
  /** Normalized substrings of the group's HQ mailing address (auto-match). */
  mailPatterns?: string[];
  /** Normalized substrings of the owner entity name (auto-match). */
  ownerPatterns?: string[];
  notes?: string;
  venueCount?: number;
  createdAt?: any;
  updatedAt?: any;
}

export interface Lead {
  id?: string;
  businessName: string;
  dba?: string;
  ownerName?: string;
  /** Parent hospitality group, when the record links to a known operator. */
  operator?: OperatorRef | null;
  /** True when an admin manually set/cleared the operator — re-tag won't override. */
  operatorLocked?: boolean;
  mailAddress?: string;
  address: string;
  city?: string;
  county?: string;
  zipCode?: string;
  lat?: number;
  lng?: number;
  phones?: string[];
  emails?: string[];
  website?: string;
  sources: LeadSource[];
  signals: LeadSignal[];
  /** Primary marketing category (Food & Drink, Medical, Nonprofit, …) for campaign segmentation. */
  category?: string;
  enrichment?: Record<string, any>;
  crm: LeadCrm;
  /** Most recent filing/registration date across sources (free-tier recency gate). */
  recordDate?: any;
  firstSeenAt?: any;
  updatedAt?: any;
}

/** Stored at settings/integrations — drives the outbound webhook fanout. */
export interface IntegrationSettings {
  webhookUrl?: string;
  secret?: string;
  events?: Array<'lead.created' | 'lead.stage_changed'>;
  filters?: {
    counties?: string[];
    signals?: LeadSignal[];
  };
  enabled?: boolean;
  updatedAt?: any;
  hubspot?: {
    serviceKey?: string;
    enabled?: boolean;
    /** Auto-push every new lead to HubSpot on creation. */
    autoSync?: boolean;
    /** HubSpot pipeline ID — leave blank to use the default pipeline. */
    pipelineId?: string;
    /** Override PourScout stage → HubSpot deal stage value mapping. */
    stageMap?: Record<string, string>;
    /** Lead signals that qualify a lead for auto-sync (operator-linked leads always qualify). */
    icpSignals?: LeadSignal[];
  };
  apollo?: {
    apiKey?: string;
    enabled?: boolean;
  };
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
  /** Monthly detail is stored in the `revenue` subcollection — not on the parent doc */
  latestMonthRevenue: number;
  avgMonthlyRevenue: number;
  revenueTrend?: 'up' | 'flat' | 'down';
  revenueDataFrom?: string;
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
  propertyData?: EnrichmentStatus | 'no_match';
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
  candidatePlaceId?: string;
  candidateName?: string;
  candidateAddress?: string;
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
