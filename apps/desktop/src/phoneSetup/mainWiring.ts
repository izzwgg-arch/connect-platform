/**
 * Wiring the phone-setup capability into the app customers already have.
 *
 * ⛔⛔ ONE CHANNEL, ONE SHAPE. The renderer can send exactly one message —
 * `phoneSetup:run` with an operation from the allowlist — and gets one result back.
 * There is no channel that takes a URL, a command or a host. That is deliberate:
 * the renderer loads the hosted portal, so anything it can express is something a
 * compromised server could express too.
 *
 * ⛔ Credentials live in the operating system's own protection (Electron's
 * safeStorage, which on Windows is DPAPI keyed to the logged-in user). The renderer
 * hands over a REFERENCE and never a password, so a secret never crosses this
 * boundary in either direction and cannot be read out of an IPC message.
 */

import { createPhoneCapability, type OperationRequest, type OperationResult } from "./capability";
import { createPnpResident, type PnpResident } from "./pnpResident";
import type { HttpRequest, HttpResponse, YealinkCredentials } from "./yealink";

/** The pieces of Electron this needs, injected so the wiring itself is testable. */
export type WiringDeps = {
  ipcMain: { handle(channel: string, fn: (event: unknown, ...args: any[]) => any): void };
  safeStorage?: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(cipher: Buffer): string;
  };
  http?: (req: HttpRequest) => Promise<HttpResponse>;
  /** The standing PnP responder; injectable for tests. */
  pnpResident?: PnpResident;
  /** Where to say what the responder did (never packet contents). */
  log?: (line: string) => void;
};

export const PHONE_SETUP_CHANNEL = "phoneSetup:run";
export const PHONE_SETUP_STORE_CREDENTIAL_CHANNEL = "phoneSetup:store-credential";
export const PHONE_SETUP_FORGET_CREDENTIALS_CHANNEL = "phoneSetup:forget-credentials";

/**
 * ⛔ In memory only, and only for as long as the app is open. A phone password the
 * customer typed once to finish a setup has no business surviving a restart, and
 * writing it to disk would mean a file that has to be protected, rotated and
 * eventually explained. Encrypted at rest in memory via safeStorage so it is not
 * sitting in a heap dump in the clear.
 */
type Vault = Map<string, Buffer | string>;

export function registerPhoneSetup(deps: WiringDeps): { forgetAll: () => void; disarmPnp: () => void } {
  const vault: Vault = new Map();
  const canEncrypt = Boolean(deps.safeStorage?.isEncryptionAvailable?.());

  const put = (ref: string, creds: YealinkCredentials) => {
    const plain = JSON.stringify(creds);
    vault.set(ref, canEncrypt ? deps.safeStorage!.encryptString(plain) : plain);
  };
  const get = (ref: string): YealinkCredentials | null => {
    const stored = vault.get(ref);
    if (!stored) return null;
    try {
      const plain = typeof stored === "string" ? stored : deps.safeStorage!.decryptString(stored);
      const parsed = JSON.parse(plain);
      if (!parsed || typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
      return parsed;
    } catch {
      // ⛔ An unreadable credential is "we do not have one", never a crash and never
      // an attempt without it.
      return null;
    }
  };

  const pnpResident = deps.pnpResident ?? createPnpResident({ log: deps.log });
  const capability = createPhoneCapability({
    http: deps.http ?? nodeHttp,
    resolveCredential: async (ref) => get(ref),
    pnpResident,
  });

  deps.ipcMain.handle(PHONE_SETUP_CHANNEL, async (_e: unknown, req: OperationRequest): Promise<OperationResult> => {
    try {
      return await capability.run(req);
    } catch {
      // ⛔ The message is swallowed on purpose. An adapter error can contain a URL
      // or a header, and this value goes straight back to a web page.
      return { ok: false, refused: "operation_failed" };
    }
  });

  deps.ipcMain.handle(
    PHONE_SETUP_STORE_CREDENTIAL_CHANNEL,
    (_e: unknown, payload: { ref?: unknown; username?: unknown; password?: unknown }) => {
      const ref = String(payload?.ref ?? "").trim();
      const username = String(payload?.username ?? "").trim();
      const password = String(payload?.password ?? "");
      if (!ref || !username || !password) return { ok: false as const, refused: "incomplete" };
      if (vault.size >= 64) return { ok: false as const, refused: "too_many" };
      put(ref, { username, password });
      // ⛔ Nothing about the value is returned, not even its length.
      return { ok: true as const, encrypted: canEncrypt };
    },
  );

  deps.ipcMain.handle(PHONE_SETUP_FORGET_CREDENTIALS_CHANNEL, () => {
    vault.clear();
    return { ok: true as const };
  });

  return { forgetAll: () => vault.clear(), disarmPnp: () => pnpResident.disarm() };
}

/**
 * The real transport.
 *
 * ⛔ Deliberately built on node:http / node:https rather than fetch: a desk phone
 * answers on the office LAN with a self-signed certificate at best, and this must
 * never follow a redirect. A redirect from a device is a device choosing where our
 * request goes next, which is exactly the thing the private-address fence exists to
 * prevent.
 *
 * ⛔ HTTPS to a phone accepts ANY certificate (`rejectUnauthorized: false`) ON
 * PURPOSE: a handset's web interface presents a self-signed, per-device cert and
 * there is nothing to verify it against. That is safe only because every request
 * here is fenced to a PRIVATE IPv4 address by the builders in yealink.ts — the
 * certificate is not what keeps this from reaching the internet, the fence is.
 */
async function nodeHttp(req: HttpRequest): Promise<HttpResponse> {
  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") throw new Error("refused: unsupported scheme");
  const mod = secure ? await import("node:https") : await import("node:http");
  return new Promise<HttpResponse>((resolve, reject) => {
    const r = mod.request(
      {
        host: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
        timeout: req.timeoutMs,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (c: Buffer) => {
          bytes += c.length;
          // ⛔ Bounded. A device could otherwise stream forever into the app's memory.
          if (bytes <= 64 * 1024) chunks.push(c);
        });
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(response.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}
