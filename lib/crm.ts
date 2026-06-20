"use client";
/**
 * Client-side CRM helpers for the unified `leads` collection. Each write keeps
 * the denormalized `crm.*` fields on the lead doc in sync with the
 * activities/contacts subcollections so list filtering stays fast.
 */
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { CrmStage, LeadContact } from "@/types";

export const CRM_STAGES: { key: CrmStage; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "proposal", label: "Proposal" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];

export async function setStage(
  leadId: string,
  toStage: CrmStage,
  fromStage: CrmStage | undefined,
  uid?: string
) {
  await updateDoc(doc(db, "leads", leadId), {
    "crm.stage": toStage,
    "crm.lastActivityAt": serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await addDoc(collection(db, "leads", leadId, "activities"), {
    type: "stage_change",
    fromStage: fromStage ?? null,
    toStage,
    createdAt: serverTimestamp(),
    createdBy: uid ?? null,
  });
}

export async function logActivity(
  leadId: string,
  type: "call" | "email" | "note" | "meeting",
  body: string,
  uid?: string
) {
  await addDoc(collection(db, "leads", leadId, "activities"), {
    type,
    body: body || null,
    createdAt: serverTimestamp(),
    createdBy: uid ?? null,
  });
  const patch: Record<string, unknown> = {
    "crm.lastActivityAt": serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (type === "call" || type === "email" || type === "meeting") {
    patch["crm.lastContactedAt"] = serverTimestamp();
  }
  await updateDoc(doc(db, "leads", leadId), patch);
}

export async function setAssignment(leadId: string, assignedTo: string | null) {
  await updateDoc(doc(db, "leads", leadId), {
    "crm.assignedTo": assignedTo,
    updatedAt: serverTimestamp(),
  });
}

export async function setFollowUp(leadId: string, followUpDate: string | null) {
  await updateDoc(doc(db, "leads", leadId), {
    "crm.followUpDate": followUpDate,
    updatedAt: serverTimestamp(),
  });
}

export async function addContact(leadId: string, contact: LeadContact) {
  await addDoc(collection(db, "leads", leadId, "contacts"), {
    name: contact.name ?? null,
    role: contact.role ?? "manual",
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    source: contact.source ?? "manual",
    createdAt: serverTimestamp(),
  });
}
