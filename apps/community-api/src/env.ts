import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3101),
  COMMUNITY_DATABASE_URL: z.string().min(1),
  COMMUNITY_JWT_SECRET: z.string().min(32, "COMMUNITY_JWT_SECRET must be at least 32 chars"),
  COMMUNITY_PUBLIC_URL: z.string().url().default("http://localhost:3100"),
  COMMUNITY_API_URL: z.string().url().default("http://localhost:3101"),
  COMMUNITY_MAIL_MODE: z.enum(["mailbox", "smtp", "off"]).default("mailbox"),
  SMTP_URL: z.string().optional().default(""),
  MAIL_FROM: z.string().default("Loopcom Community <community@loopcom.net>"),
  COMMUNITY_STORAGE_DIR: z.string().default("./.storage"),
  COMMUNITY_S3_BUCKET: z.string().optional().default(""),
  COMMUNITY_S3_REGION: z.string().optional().default(""),
  COMMUNITY_S3_ENDPOINT: z.string().optional().default(""),
  LOOPCOM_API_URL: z.string().optional().default(""),
  REDIS_URL: z.string().optional().default(""),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  APPLE_CLIENT_ID: z.string().optional().default(""),
  WEBAUTHN_RP_ID: z.string().default("localhost"),
  WEBAUTHN_ORIGIN: z.string().default("http://localhost:3100"),
  /** Test-only: lets the tier-1 loop read verification codes back. Never set in production. */
  COMMUNITY_TEST_HOOKS: z.string().optional().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Community api env invalid — ${issues}`);
  }
  cached = parsed.data;
  if (cached.NODE_ENV === "production" && cached.COMMUNITY_TEST_HOOKS) {
    throw new Error("COMMUNITY_TEST_HOOKS must never be set in production");
  }
  return cached;
}

export const isProd = () => env().NODE_ENV === "production";
export const testHooksEnabled = () => !isProd() && env().COMMUNITY_TEST_HOOKS === "1";
