/**
 * How a texting registration's registry states read to a person (2026-09-16).
 *
 * ⛔ Pure. The engine re-reads Telnyx and hands the raw states here; nothing
 * advances from a webhook body. Every raw status Telnyx's spec lists is
 * handled explicitly — an unknown status reads as "still reviewing", never as
 * approved.
 */
import type { BrandDetail, CampaignDetail } from "./registryClient";

export type RegistrationStatus =
  | "draft"            // created by staff, no link sent yet
  | "awaiting_customer"// link created/sent, customer hasn't sent the form
  | "submitted"        // customer sent it — ready for staff to file
  | "needs_fix"        // sent back to the customer to correct fields
  | "filing"           // staff pressed File; brand create in flight
  | "awaiting_pin"     // sole proprietor: PIN texted, waiting for the owner
  | "brand_review"     // brand created, registry verifying the business
  | "brand_failed"     // registry could not verify the business
  | "campaign_review"  // campaign filed; Telnyx + carriers reviewing
  | "campaign_rejected"
  | "assigning"        // approved; attaching numbers
  | "live"
  | "suspended"
  | "deactivated"
  | "error";           // an unexpected failure staff must look at

export const STATUS_LABEL: Record<RegistrationStatus, string> = {
  draft: "No link yet",
  awaiting_customer: "Waiting on customer",
  submitted: "Ready to file",
  needs_fix: "Sent back to customer",
  filing: "Filing",
  awaiting_pin: "Waiting for owner's PIN",
  brand_review: "Verifying business",
  brand_failed: "Business not verified",
  campaign_review: "Carriers reviewing",
  campaign_rejected: "Campaign rejected",
  assigning: "Attaching numbers",
  live: "Texting is live",
  suspended: "Suspended",
  deactivated: "Deactivated",
  error: "Needs attention",
};

/** Statuses the background re-check walks. */
export const SWEEP_STATUSES: RegistrationStatus[] = ["filing", "awaiting_pin", "brand_review", "campaign_review", "assigning", "live"];

/** Statuses that sort into "Needs you" on the board. */
export const NEEDS_STAFF: RegistrationStatus[] = ["submitted", "brand_failed", "campaign_rejected", "suspended", "error"];

export const TERMINAL: RegistrationStatus[] = ["deactivated"];

export function isRegistrationStatus(v: string): v is RegistrationStatus {
  return v in STATUS_LABEL;
}

export type BrandPhase = "verified" | "failed" | "pending";

export function brandPhase(b: Pick<BrandDetail, "identityStatus" | "status">): BrandPhase {
  const identity = String(b.identityStatus || "").toUpperCase();
  const status = String(b.status || "").toUpperCase();
  if (status === "REGISTRATION_FAILED") return "failed";
  if (identity === "VERIFIED" || identity === "VETTED_VERIFIED") return status === "REGISTRATION_PENDING" ? "pending" : "verified";
  if (identity === "UNVERIFIED" && status === "OK") return "failed";
  return "pending";
}

export type CampaignPhase = "approved" | "rejected" | "suspended" | "reviewing";

const REJECTED = new Set(["TCR_FAILED", "TELNYX_FAILED", "MNO_REJECTED", "MNO_PROVISIONING_FAILED"]);
const SUSPENDED = new Set(["TCR_SUSPENDED", "TCR_EXPIRED"]);
const APPROVED = new Set(["MNO_ACCEPTED", "MNO_PROVISIONED"]);

export function campaignPhase(c: Pick<CampaignDetail, "campaignStatus" | "status">): CampaignPhase {
  const s = String(c.campaignStatus || "").toUpperCase();
  if (REJECTED.has(s)) return "rejected";
  if (SUSPENDED.has(s) || String(c.status || "").toUpperCase() === "EXPIRED") return "suspended";
  if (APPROVED.has(s)) return "approved";
  return "reviewing";
}

export type CarrierReview = { networkId: string; carrier: string; state: "approved" | "rejected" | "reviewing" };

const KNOWN_MNO: Record<string, string> = {};

export function carrierReviews(op: Record<string, string>, names: Record<string, string>): CarrierReview[] {
  return Object.entries(op)
    .map(([id, raw]) => {
      const v = String(raw).toUpperCase();
      const state: CarrierReview["state"] = /APPROV|ACCEPT|REGISTERED|PROVISIONED|ACTIVE/.test(v)
        ? "approved"
        : /REJECT|FAIL|DECLIN|SUSPEND/.test(v)
          ? "rejected"
          : "reviewing";
      return { networkId: id, carrier: names[id] || KNOWN_MNO[id] || `Carrier ${id}`, state };
    })
    .sort((a, b) => a.carrier.localeCompare(b.carrier));
}

export type AssignmentPhase = "assigned" | "pending" | "failed" | "none";

export function assignmentPhase(a: { assignmentStatus: string | null; campaignId: string | null } | null, campaignId: string): AssignmentPhase {
  if (!a) return "none";
  if (a.campaignId && a.campaignId !== campaignId) return "failed";
  const s = String(a.assignmentStatus || "").toUpperCase();
  if (s === "ASSIGNED") return "assigned";
  if (s === "FAILED_ASSIGNMENT") return "failed";
  return "pending";
}

/** Pick the live spelling of the low-volume conversational class from the registry's own enum. */
export function pickConversationalUsecase(available: string[]): string | null {
  const set = new Set(available.map((s) => s.toUpperCase()));
  for (const name of ["LOW_VOLUME", "LOW_VOLUME_MIXED"]) if (set.has(name)) return name;
  return null;
}

export const CONVERSATIONAL_SUB_USECASES = ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATION"];
