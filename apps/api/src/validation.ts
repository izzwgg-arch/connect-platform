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

export function assessSmsRisk(message: string): { riskScore: number; reasons: string[] } {
  const text = message.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (text.length < 12) {
    score += 20;
    reasons.push("message_too_short");
  }

  const suspiciousShorteners = /(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly)/i;
  if (suspiciousShorteners.test(text)) {
    score += 45;
    reasons.push("suspicious_shortener");
  }

  const phishingKeywords = /(verify\s+your\s+account|password\s+reset|confirm\s+your\s+identity|urgent\s+action\s+required)/i;
  if (phishingKeywords.test(text) && /(https?:\/\/|www\.)/i.test(text)) {
    score += 55;
    reasons.push("credential_harvest_pattern");
  }

  if (/(https?:\/\/|www\.)/i.test(text) && text.replace(/https?:\/\/\S+/gi, "").trim().length < 8) {
    score += 50;
    reasons.push("link_only_message");
  }

  if (/(free\s+money|guaranteed\s+income|crypto\s+giveaway|bitcoin\s+doubling)/i.test(lower)) {
    score += 40;
    reasons.push("financial_scam_pattern");
  }

  return { riskScore: score, reasons };
}

export function normalizeSmsWithStop(message: string):
  | { ok: true; message: string; appendedStop: boolean }
  | { ok: false; reason: string } {
  const cleaned = message.trim();
  if (!/\bstop\b/i.test(cleaned)) {
    const appended = `${cleaned} Reply STOP to opt out.`;
    if (appended.length > 160) {
      return { ok: false, reason: "stop_append_would_exceed_160_chars" };
    }
    return { ok: true, message: appended, appendedStop: true };
  }
  return { ok: true, message: cleaned, appendedStop: false };
}
