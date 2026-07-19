// Smart-home IVR configuration — loaded from a JSON file on disk
// (SMARTHOME_CONFIG_PATH). File-based for v1; can move to Prisma later.
//
// Callers authenticate with a PIN; the PIN identifies the account, so PINs
// must be unique across accounts. PINs are stored as scrypt hashes — use
// `pnpm --filter @connect/telephony exec tsx src/smarthome/hashPinCli.ts 1234`
// to generate one. Plaintext `pinPlain` is accepted for local dev only.

import { readFileSync } from "fs";
import { z } from "zod";

/** Generic HTTP action — lets a menu digit drive ANY system with an API,
 *  not just Home Assistant (SmartThings, openHAB, Node-RED, home-grown…). */
const webhookSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  /** Extra headers, e.g. { "Authorization": "Bearer …" }. */
  headers: z.record(z.string()).optional(),
  /** JSON body sent for POST/PUT. */
  body: z.record(z.unknown()).optional(),
});

const menuItemSchema = z.object({
  /** Single DTMF digit 1-9 ("0" and "*" are reserved: repeat menu / goodbye). */
  digit: z.string().regex(/^[1-9]$/),
  /** Human label, used in logs only (audio prompts are separate files). */
  label: z.string().min(1),
  /** Home Assistant service domain, e.g. "light", "switch", "climate". */
  domain: z.string().min(1).optional(),
  /** Home Assistant service, e.g. "turn_on", "turn_off", "toggle". */
  service: z.string().min(1).optional(),
  /** Target entity, e.g. "light.living_room". */
  entityId: z.string().min(1).optional(),
  /** Extra service data merged into the HA call body. */
  serviceData: z.record(z.unknown()).optional(),
  /** Alternative to the HA fields above: fire a raw HTTP request. */
  webhook: webhookSchema.optional(),
  /** Optional per-item confirmation prompt file (defaults to prompts.ok). */
  okPrompt: z.string().optional(),
});

const accountSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  /** scrypt:<salt>:<hash> — generate with hashPinCli. */
  pinHash: z.string().optional(),
  /** Local dev only. Ignored when pinHash is set. */
  pinPlain: z.string().regex(/^\d{4,10}$/).optional(),
  /** Optional when every menu item is a webhook action. */
  ha: z
    .object({
      baseUrl: z.string().url(),
      token: z.string().min(1),
    })
    .optional(),
  menu: z.array(menuItemSchema).min(1),
});

const promptsSchema = z
  .object({
    enterPin: z.string().default("vm-password"),
    invalidPin: z.string().default("vm-incorrect"),
    invalidOption: z.string().default("invalid"),
    menu: z.string().default("beep"),
    ok: z.string().default("auth-thankyou"),
    fail: z.string().default("sorry"),
    goodbye: z.string().default("vm-goodbye"),
  })
  .default({});

const configSchema = z.object({
  prompts: promptsSchema,
  accounts: z.array(accountSchema).min(1),
});

export type SmartHomeWebhook = z.infer<typeof webhookSchema>;
export type SmartHomeMenuItem = z.infer<typeof menuItemSchema>;
export type SmartHomeAccount = z.infer<typeof accountSchema>;
export type SmartHomePrompts = z.infer<typeof promptsSchema>;
export type SmartHomeConfig = z.infer<typeof configSchema>;

export function parseSmartHomeConfig(json: unknown): SmartHomeConfig {
  const cfg = configSchema.parse(json);
  const seenDigitsPerAccount = new Map<string, Set<string>>();
  for (const acc of cfg.accounts) {
    if (!acc.pinHash && !acc.pinPlain) {
      throw new Error(`smarthome config: account "${acc.id}" needs pinHash (or pinPlain for dev)`);
    }
    const digits = seenDigitsPerAccount.get(acc.id) ?? new Set<string>();
    for (const item of acc.menu) {
      if (digits.has(item.digit)) {
        throw new Error(`smarthome config: account "${acc.id}" maps digit ${item.digit} twice`);
      }
      digits.add(item.digit);
      const isHa = Boolean(item.domain || item.service || item.entityId);
      const isWebhook = Boolean(item.webhook);
      if (isHa === isWebhook) {
        throw new Error(
          `smarthome config: account "${acc.id}" digit ${item.digit} must define either an HA action (domain+service+entityId) or a webhook, not both/neither`,
        );
      }
      if (isHa) {
        if (!item.domain || !item.service || !item.entityId) {
          throw new Error(
            `smarthome config: account "${acc.id}" digit ${item.digit} HA action needs domain, service, and entityId`,
          );
        }
        if (!acc.ha) {
          throw new Error(
            `smarthome config: account "${acc.id}" uses HA actions but has no "ha" section (baseUrl/token)`,
          );
        }
      }
    }
    seenDigitsPerAccount.set(acc.id, digits);
  }
  return cfg;
}

export function loadSmartHomeConfig(path: string): SmartHomeConfig {
  const raw = readFileSync(path, "utf8");
  return parseSmartHomeConfig(JSON.parse(raw));
}
