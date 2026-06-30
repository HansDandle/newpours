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
  setDoc,
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

/** Manually pin a lead to an operator (or None). Locks it from the auto re-tag. */
export async function setOperator(leadId: string, operator: { key: string; name: string } | null) {
  await updateDoc(doc(db, "leads", leadId), {
    operator,
    operatorLocked: true,
    updatedAt: serverTimestamp(),
  });
}

/** Release the manual lock so the next re-tag decides the operator automatically. */
export async function clearOperatorLock(leadId: string) {
  await updateDoc(doc(db, "leads", leadId), {
    operatorLocked: false,
    updatedAt: serverTimestamp(),
  });
}

export async function addContact(leadId: string, contact: LeadContact) {
  const phone = String(contact.phone ?? "").trim();
  const email = String(contact.email ?? "").trim();
  const name = String(contact.name ?? "").trim();

  // Subcollection entry — full record with timestamps.
  const contactId = phone
    ? `phone_${phone.replace(/[^0-9]/g, "")}`
    : email
    ? `email_${email.toLowerCase().replace(/[^a-z0-9]/g, "")}`
    : undefined;
  const contactData = {
    name: name || null,
    role: contact.role ?? "manual",
    phone: phone || null,
    email: email || null,
    source: contact.source ?? "manual",
    createdAt: serverTimestamp(),
  };
  const col = collection(db, "leads", leadId, "contacts");
  if (contactId) await setDoc(doc(col, contactId), contactData, { merge: true });
  else await addDoc(col, contactData);

  // Denormalize onto the lead doc so the snapshot / export can use it without
  // a subcollection read. Set as primaryContact if the contact has a name.
  if (name) {
    await updateDoc(doc(db, "leads", leadId), {
      primaryContact: { name, phone: phone || null, email: email || null, role: contact.role ?? "manual" },
      updatedAt: serverTimestamp(),
    });
  }
}

/** Promote any stored contact to the primary contact used in RadioWorkflow exports. */
export async function setPrimaryContact(leadId: string, contact: { name?: string; phone?: string; email?: string; role?: string }) {
  await updateDoc(doc(db, "leads", leadId), {
    primaryContact: {
      name: contact.name ?? null,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      role: contact.role ?? "manual",
    },
    updatedAt: serverTimestamp(),
  });
}
