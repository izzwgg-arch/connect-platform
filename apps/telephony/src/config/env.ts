import { z } from "zod";
import { resolveAriBridgedPollMs } from "./resolveAriBridgedPollMs";

function readOptionalIntEnv(name: string): number | undefined {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

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
  // Extension/queue WS upserts — floor 1s recommended to avoid CPU spikes alongside AMI.
  TELEPHONY_EVENT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(1000),
  ENABLE_TELEPHONY_DEBUG: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),
  ENABLE_BLF_DEBUG: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),

  /** When true or `1`, emit structured `pbx_outbound_profile` logs for ARI poll timing (short-lived production profiling). */
  CONNECT_PBX_PROFILE: z
    .string()
    .transform((v) => v === "1" || v.toLowerCase() === "true")
    .default("false"),

  /** When true, allow ARI_BRIDGED_ACTIVE_POLL_MS down to 1000 (tests / emergency only). */
  ARI_BRIDGED_ACTIVE_POLL_DEBUG: z
    .string()
    .transform((v) => v === "1" || v.toLowerCase() === "true")
    .default("false"),

  /** Redis snapshot TTL (seconds). Published after each bridged ARI poll. */
  TELEPHONY_ARI_SNAPSHOT_TTL_SEC: z.coerce.number().int().min(10).max(120).default(15),
  /** Max age of snapshot JSON `producedAt` before API treats it as stale (defaults to ~1.5× TTL). */
  TELEPHONY_ARI_SNAPSHOT_STALE_MS: z.coerce.number().int().min(5_000).max(180_000).optional(),
  /** Override PBX host segment in Redis key (must match API). Defaults to PBX_HOST. */
  TELEPHONY_ARI_SNAPSHOT_PBX_HOST: z.string().optional().or(z.literal("").transform(() => undefined)),
  REDIS_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),

  // CDR ingest — when set, completed calls are POSTed to this URL so the API
  // can persist them in ConnectCdr. If unset, CDR persistence is skipped.
  CDR_INGEST_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  CDR_INGEST_SECRET: z.string().optional().or(z.literal("").transform(() => undefined)),
  TELEPHONY_PBX_MAP_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
});

function loadEnv() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const d = result.data;
  const ARI_BRIDGED_ACTIVE_POLL_MS = resolveAriBridgedPollMs({
    pollMs: readOptionalIntEnv("ARI_BRIDGED_ACTIVE_POLL_MS"),
    debug: d.ARI_BRIDGED_ACTIVE_POLL_DEBUG,
  });
  const TELEPHONY_ARI_SNAPSHOT_STALE_MS =
    d.TELEPHONY_ARI_SNAPSHOT_STALE_MS ?? Math.round(d.TELEPHONY_ARI_SNAPSHOT_TTL_SEC * 1500);
  return {
    ...d,
    ARI_BRIDGED_ACTIVE_POLL_MS,
    TELEPHONY_ARI_SNAPSHOT_STALE_MS,
  };
}

type BaseEnv = z.infer<typeof schema>;
export type Env = Omit<BaseEnv, never> & {
  ARI_BRIDGED_ACTIVE_POLL_MS: number;
  TELEPHONY_ARI_SNAPSHOT_STALE_MS: number;
};
export const env: Env = loadEnv();
