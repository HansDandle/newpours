// Shared TypeScript types for NewPours
// See TABC_ALERT_SPEC.md for full data models

export type UserPlan = 'free' | 'basic' | 'pro' | 'enterprise';
export type PlanStatus = 'active' | 'past_due' | 'canceled';
export type DigestTime = '6am' | '8am' | '12pm';

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
}

export interface License {
  licenseNumber: string;
  businessName: string;
  ownerName: string;
  address: string;
  city: string;
  county: string;
  zipCode: string;
  licenseType: string;
  licenseTypeLabel: string;
  status: 'Pending' | 'Active' | 'Expired' | 'Cancelled';
  applicationDate: any;
  effectiveDate?: any;
  expirationDate?: any;
  tradeName?: string;
  mailAddress?: string;
  mailCity?: string;
  mailZip?: string;
  lat?: number;
  lng?: number;
  enrichedAt?: any;
  firstSeenAt: any;
  isNew: boolean;
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
