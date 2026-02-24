import { z } from "zod";

export const tenDlcSubmissionSchema = z.object({
  legalName: z.string().min(2),
  dba: z.string().optional(),
  ein: z.string().min(5),
  businessType: z.enum(["LLC", "CORP", "SOLE_PROP", "NONPROFIT"]),
  websiteUrl: z.string().url(),
  businessAddress: z.object({
    street: z.string().min(2),
    city: z.string().min(2),
    state: z.string().min(2),
    zip: z.string().min(2),
    country: z.string().min(2)
  }),
  supportEmail: z.string().email(),
  supportPhone: z.string().min(7),
  useCaseCategory: z.enum(["marketing", "notifications", "2fa", "customer_care", "mixed"]),
  messageSamples: z.array(z.string().min(1)).length(3),
  optInMethod: z.enum(["website_form", "paper_form", "verbal", "keyword", "other"]),
  optInWorkflowDescription: z.string().min(10),
  optInProofUrl: z.string().url().optional().or(z.literal("")),
  volumeEstimate: z.object({
    messagesPerDay: z.number().int().positive(),
    messagesPerMonth: z.number().int().positive()
  }),
  includesEmbeddedLinks: z.boolean(),
  includesEmbeddedPhoneNumbers: z.boolean(),
  includesAffiliateMarketing: z.boolean(),
  ageGatedContent: z.boolean(),
  termsAccepted: z.literal(true),
  signatureName: z.string().min(2),
  signatureDate: z.string().min(8)
});

const forbiddenPatterns = [
  /guaranteed\s+income/i,
  /free\s+money/i,
  /crypto\s+giveaway/i,
  /bitcoin\s+doubling/i
];

export function validateCampaignMessage(message: string): { ok: boolean; reason?: string } {
  if (message.length < 3 || message.length > 320) {
    return { ok: false, reason: "Message length must be 3-320 chars" };
  }
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(message)) {
      return { ok: false, reason: "Message content failed compliance screening" };
    }
  }
  return { ok: true };
}
