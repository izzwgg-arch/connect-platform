import { z } from "zod";

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
EOF
