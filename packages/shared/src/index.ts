import { z } from "zod";

export * from "./phoneE164";
export * from "./voicemailIngest";
export * from "./voicemailSyncFair";
export * from "./portalPermissions";
export * from "./smsInbox";
export * from "./smsText";
export * from "./voipMsWebhook";
export * from "./mohRuntimeClass";
export * from "./mohCallSource";
export * from "./mohProvision";
export * from "./mohSourcePublish";
export * from "./mohCatalog";
export * from "./canonicalTenantSlug";
export * from "./ivrPlainLanguage";
export * from "./teamNumbering";
export * from "./onboardingPricing";
export * from "./ariBridgedSnapshot";
export * from "./expoMobilePushFormat";
export * from "./crmEmailTemplates";
export * from "./webrtcCallDiagnostics";
export * from "./webrtcBlackbox";
export * from "./webrtcIncidentAlerts";
export * from "./webrtcGlobalOutageAlerts";
export * from "./localDevCredentials";
export * from "./elevenLabsKeyFormat";
export * from "./chatPermissionGrants";
export * from "./agentProvisioningParams";
export * from "./adminAlertBudget";
export * from "./agentKnowledgeDoc";
export * from "./agentFixByText";
/* chatSignedUrl uses node:crypto — import from "@connect/shared/chatSignedUrl" in Node only */
/* chatPermissionGrantHash uses node:crypto — import from "@connect/shared/chatPermissionGrantHash" in Node only */

export const UserSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  email: z.string().email(),
  role: z.string()
});

export const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string()
});

export const TenDlcSubmissionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  legalName: z.string(),
  status: z.enum(["draft", "submitted", "approved", "rejected"]),
  createdAt: z.string()
});

export const SmsCampaignSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  message: z.string(),
  audience: z.string(),
  status: z.enum(["draft", "queued", "sent", "failed"]),
  createdAt: z.string()
});

export const PhoneNumberSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  e164: z.string(),
  status: z.enum(["available", "purchased", "assigned"]),
  createdAt: z.string()
});

export type User = z.infer<typeof UserSchema>;
export type Tenant = z.infer<typeof TenantSchema>;
export type TenDlcSubmission = z.infer<typeof TenDlcSubmissionSchema>;
export type SmsCampaign = z.infer<typeof SmsCampaignSchema>;
export type PhoneNumber = z.infer<typeof PhoneNumberSchema>;
export * from "./personDisplayName";
export * from "./supportReport";
export * from "./assistantGreeting";
