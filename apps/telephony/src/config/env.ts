import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  JWT_SECRET: z.string().min(8),

  PBX_HOST: z.string().min(1).default("209.145.60.79"),

  AMI_PORT: z.coerce.number().int().min(1).max(65535).default(5038),
  AMI_USERNAME: z.string().min(1),
  AMI_PASSWORD: z.string().min(1),

  ARI_BASE_URL: z.string().url(),
  ARI_USERNAME: z.string().min(1),
  ARI_PASSWORD: z.string().min(1),
  ARI_APP_NAME: z.string().min(1).default("connectcomms"),

  TELEPHONY_WS_PATH: z.string().default("/ws/telephony"),
  TELEPHONY_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  TELEPHONY_EVENT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(100),
  ENABLE_TELEPHONY_DEBUG: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),

  // CDR ingest — when set, completed calls are POSTed to this URL so the API
  // can persist them in ConnectCdr. If unset, CDR persistence is skipped.
  CDR_INGEST_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  CDR_INGEST_SECRET: z.string().optional().or(z.literal("").transform(() => undefined)),
});

function loadEnv() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export type Env = z.infer<typeof schema>;
export const env: Env = loadEnv();
