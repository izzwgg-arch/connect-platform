import { z } from "zod";

// Public save (autosave) payload.
// The wizard sends currentStep as a NUMBER (step index); the DB stores a
// string. Rejecting numbers made every autosave 500 (live incident
// 2026-07-27: the resulting error flood helped get a customer IP auto-banned
// mid-wizard, and progress was never saved). Coerce instead.
export const publicSaveSchema = z.object({
  currentStep: z.coerce.string().min(1).max(80).optional(),
  answers: z.unknown().optional(),
});

// Extension input (public submit)
export const extensionInputSchema = z.object({
  extNumber: z.string().regex(/^[0-9]+$/),
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  vmPassword: z.string().regex(/^[0-9*]*$/).max(20).optional(),
  smsEnabled: z.boolean().optional(),
  // Cell-phone routing ("virtual device" on the PBX): also = ring cell alongside
  // desk/app; only = calls go straight to the cell.
  cellMode: z.enum(["also", "only"]).optional(),
  cellNumber: z.string().regex(/^[0-9]{10}$/).optional(),
});

// Public submit payload
export const publicSubmitSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactFirstName: z.string().min(1).max(120),
  contactLastName: z.string().min(1).max(120),
  mainEmail: z.string().email(),
  // Optional — when omitted, billing goes to the main email.
  billingEmail: z.string().email().optional(),
  mainPhone: z.string().optional(),
  phoneNumberChoice: z.string().optional(),
  selectedNumber: z.string().optional(),
  porting: z.unknown().optional(),
  smsEnabled: z.boolean().optional(),
  extensions: z.array(extensionInputSchema).min(0).max(500).default([]),
});

// Public apply-number payload (fires as the customer leaves the number step)
export const publicApplyNumberSchema = z.object({
  choice: z.enum(["new", "port"]),
  selectedNumber: z.string().optional(),
  porting: z.unknown().optional(),
  smsEnabled: z.boolean().optional(),
  companyName: z.string().min(1).max(200).optional(),
});

// Write policy for the public wizard: ONLY pre-submit statuses may write.
// Listing blocked statuses instead was a hole — the orchestrator moves a
// finished submission to ACTIVE, which silently made the wizard writable
// again (live 2026-07-27: a second submit renamed a submission two minutes
// after its PBX tenant was already built). Reusable test templates are
// spawn-only and never writable.
export function isReusableTemplate(row: { answers?: unknown; status?: unknown } | null | undefined): boolean {
  return !!(row?.answers as any)?.reusableTestLink;
}

export function isSubmissionWriteBlocked(row: { status?: unknown; answers?: unknown } | null | undefined): boolean {
  if (isReusableTemplate(row)) return true; // spawn-only
  const s = String(row?.status || "");
  return !["INVITE_SENT", "IN_PROGRESS"].includes(s);
}

// Admin create public link
export const createPublicLinkSchema = z.object({
  companyName: z.string().min(1).max(200).optional(),
  mainEmail: z.string().email().optional(),
});

// Admin status update
export const adminStatusUpdateSchema = z.object({
  status: z.enum([
    "INVITE_SENT",
    "IN_PROGRESS",
    "SUBMITTED",
    "AWAITING_PBX_SETUP",
    "AWAITING_PORT",
    "AWAITING_PAYMENT",
    "READY_TO_SYNC",
    "ACTIVE",
    "COMPLETED",
    "CANCELED",
  ] as const),
});

// Admin checklist update
export const adminChecklistUpdateSchema = z.object({
  provisioningChecklist: z.unknown(),
});

// Admin notes update
export const adminNotesUpdateSchema = z.object({
  internalNotes: z.string().max(20000),
});

export type PublicSaveInput = z.infer<typeof publicSaveSchema>;
export type PublicSubmitInput = z.infer<typeof publicSubmitSchema>;
export type CreatePublicLinkInput = z.infer<typeof createPublicLinkSchema>;
export type AdminStatusUpdateInput = z.infer<typeof adminStatusUpdateSchema>;
export type AdminChecklistUpdateInput = z.infer<typeof adminChecklistUpdateSchema>;
export type AdminNotesUpdateInput = z.infer<typeof adminNotesUpdateSchema>;
