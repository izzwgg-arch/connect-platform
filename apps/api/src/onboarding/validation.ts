import { z } from "zod";

// Public save (autosave) payload
export const publicSaveSchema = z.object({
  currentStep: z.string().min(1).max(80).optional(),
  answers: z.unknown().optional(),
});

// Extension input (public submit)
export const extensionInputSchema = z.object({
  extNumber: z.string().regex(/^[0-9]+$/),
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  vmPassword: z.string().regex(/^[0-9*]*$/).max(20).optional(),
  smsEnabled: z.boolean().optional(),
});

// Public submit payload
export const publicSubmitSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactFirstName: z.string().min(1).max(120),
  contactLastName: z.string().min(1).max(120),
  mainEmail: z.string().email(),
  billingEmail: z.string().email(),
  mainPhone: z.string().optional(),
  phoneNumberChoice: z.string().optional(),
  smsEnabled: z.boolean().optional(),
  extensions: z.array(extensionInputSchema).min(0).max(500).default([]),
});

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
