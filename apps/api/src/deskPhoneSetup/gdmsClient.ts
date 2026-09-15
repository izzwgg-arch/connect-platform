/**
 * Grandstream Device Management System (GDMS) Open API client.
 *
 * Contract, from Grandstream's own GDMS API guide (read 2026-09-14):
 *   - Token: POST https://<host>/oapi/oauth/token, form-encoded,
 *     username + password=SHA256(MD5(password)) + grant_type=password + client_id (API ID)
 *     + client_secret (Secret Key). Refresh with grant_type=refresh_token.
 *   - Every API call: POST https://<host>/oapi/v1.0.0/<api>?access_token=&signature=&timestamp=
 *     where timestamp is epoch milliseconds and
 *     signature = SHA256("&access_token=<t>&client_id=<id>&client_secret=<secret>&timestamp=<ts>&"
 *                        + (JSON body ? SHA256(body) + "&" : "")).
 *   - Envelope: { data, msg, retCode } — retCode 0 is success.
 *   - device/add takes MAC + serial number (sn) + siteId; task/add taskType 1 = reboot, 2 = factory reset.
 *
 * ⛔⛔ THE FIELD NAMES INSIDE A DEVICE ROW ARE NOT VERIFIED against a live account (no
 * credentials exist yet). `parseGdmsDevice` reads them defensively and reports "unknown"
 * rather than inventing a value — an online/offline answer we cannot read is null, never false.
 *
 * ⛔ Never propagates a vendor body or a fetch error: either can carry credentials or tokens.
 * ⛔ A creating write (device/add, task/add) is sent ONCE and never retried — a timed-out
 *    write may have landed, so the caller re-reads instead.
 * ⛔ Only Grandstream's own hosts are ever contacted, over HTTPS, with redirects refused.
 */
import { createHash } from "node:crypto";
import { cleanDeviceText, cleanSerialNumber, formatMac, normalizeMac } from "@connect/shared";
import { DeviceError } from "./yealinkRps";

export type GdmsRegion = "us" | "eu";

/** US and EU data centres. The host comes ONLY from this table, never from input. */
export const GDMS_HOSTS: Record<GdmsRegion, string> = { us: "www.gdms.cloud", eu: "eu.gdms.cloud" };

export type GdmsCredentials = {
  region: GdmsRegion;
  /** GDMS "API ID" (OAuth client_id). */
  apiId: string;
  /** GDMS "Secret Key" (OAuth client_secret). */
  secretKey: string;
  /** The GDMS account the API acts as. */
  username: string;
  password: string;
};

/** A rejection GDMS answered in its envelope. The numeric code is safe to record; the message is not kept. */
export class GdmsRejection extends DeviceError {
  constructor(code: string, public retCode: number, status = 502) { super(code, status); }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

export function gdmsPasswordDigest(password: string): string {
  return sha256(md5(password));
}

export function gdmsSignature(input: {
  accessToken: string; clientId: string; clientSecret: string; timestamp: string; body?: string;
}): string {
  let canonical = `&access_token=${input.accessToken}&client_id=${input.clientId}&client_secret=${input.clientSecret}&timestamp=${input.timestamp}&`;
  if (input.body !== undefined && input.body !== "") canonical += `${sha256(input.body)}&`;
  return sha256(canonical);
}

export function assertGdmsHost(host: string): string {
  if (!/^([a-z0-9-]+\.)*gdms\.cloud$/.test(host)) throw new DeviceError("gdms_endpoint_invalid", 503);
  return host;
}

export type GdmsDevice = {
  mac: string;
  model: string | null;
  serialNumber: string | null;
  firmware: string | null;
  /** null = GDMS did not say in a form we can read. Never guessed. */
  online: boolean | null;
  name: string | null;
  siteId: string | null;
};

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  return undefined;
}

export function parseGdmsDevice(row: unknown): GdmsDevice | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const mac = normalizeMac(pick(r, ["mac", "deviceMac", "macAddress"]));
  if (!mac) return null;
  const text = (keys: string[], max = 80) => {
    const v = pick(r, keys);
    return typeof v === "string" || typeof v === "number" ? cleanDeviceText(String(v), max) : null;
  };
  const status = pick(r, ["status", "deviceStatus", "onlineStatus", "online"]);
  let online: boolean | null = null;
  if (typeof status === "boolean") online = status;
  else if (typeof status === "string" && /^online$/i.test(status.trim())) online = true;
  else if (typeof status === "string" && /^offline$/i.test(status.trim())) online = false;
  return {
    mac,
    model: text(["model", "deviceModel", "productModel", "deviceType"], 40),
    serialNumber: cleanSerialNumber(pick(r, ["sn", "serialNumber", "deviceSn"])),
    firmware: text(["firmwareVersion", "firmware", "version", "programVersion"], 40),
    online,
    name: text(["deviceName", "name"], 80),
    siteId: text(["siteId", "site_id"], 40),
  };
}

type Token = { access: string; refresh: string | null; expiresAt: number };

export class GdmsClient {
  private readonly host: string;
  private token: Token | null = null;

  constructor(
    private readonly creds: GdmsCredentials,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const host = GDMS_HOSTS[creds.region];
    if (!host) throw new DeviceError("gdms_region_invalid", 503);
    if (!creds.apiId || !creds.secretKey || !creds.username || !creds.password) {
      throw new DeviceError("gdms_credentials_required", 503);
    }
    this.host = assertGdmsHost(host);
  }

  get region(): GdmsRegion { return this.creds.region; }

  private async fetchToken(grant: "password" | "refresh"): Promise<void> {
    const form = grant === "password"
      ? new URLSearchParams({
        username: this.creds.username,
        password: gdmsPasswordDigest(this.creds.password),
        grant_type: "password",
        client_id: this.creds.apiId,
        client_secret: this.creds.secretKey,
      })
      : new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.token?.refresh ?? "",
        client_id: this.creds.apiId,
        client_secret: this.creds.secretKey,
      });
    let res: Response;
    try {
      res = await this.request(`https://${this.host}/oapi/oauth/token`, {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new DeviceError("gdms_unreachable_retry_later", 503);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new DeviceError("gdms_authentication_failed", 503);
    if (res.status === 429) throw new DeviceError("gdms_rate_limited_retry_later", 503);
    if (!res.ok) throw new DeviceError("gdms_service_unavailable", 503);
    let body: any;
    try { body = await res.json(); } catch { throw new DeviceError("gdms_invalid_response", 502); }
    if (body && body.retCode !== undefined && Number(body.retCode) !== 0) throw new DeviceError("gdms_authentication_failed", 503);
    const src = body?.data && typeof body.data === "object" ? { ...body, ...body.data } : body;
    const access = src?.access_token ?? src?.token;
    if (typeof access !== "string" || !access) throw new DeviceError("gdms_authentication_failed", 503);
    const refresh = src?.refresh_token ?? src?.rtoken;
    const expiresIn = Number(src?.expires_in);
    this.token = {
      access,
      refresh: typeof refresh === "string" && refresh ? refresh : null,
      expiresAt: this.now() + (Number.isFinite(expiresIn) && expiresIn > 60 ? expiresIn : 3600) * 1000,
    };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 300_000 > this.now()) return this.token.access;
    if (this.token?.refresh) {
      try { await this.fetchToken("refresh"); return this.token!.access; } catch { this.token = null; }
    }
    await this.fetchToken("password");
    return this.token!.access;
  }

  /** Forget the session (credentials changed, or GDMS refused it). */
  forgetToken(): void { this.token = null; }

  async call<T>(api: string, payload: unknown, opts: { write: boolean }): Promise<T> {
    if (!/^v1\.0\.0(\/[a-z]+)+$/.test(api)) throw new DeviceError("gdms_api_path_invalid", 500);
    const send = async (): Promise<Response> => {
      const accessToken = await this.accessToken();
      const timestamp = String(this.now());
      const body = JSON.stringify(payload ?? {});
      const signature = gdmsSignature({
        accessToken, clientId: this.creds.apiId, clientSecret: this.creds.secretKey, timestamp, body,
      });
      const qs = new URLSearchParams({ access_token: accessToken, signature, timestamp }).toString();
      try {
        return await this.request(`https://${this.host}/oapi/${api}?${qs}`, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        });
      } catch {
        throw new DeviceError(opts.write ? "gdms_write_uncertain_check_again" : "gdms_unreachable_retry_later", 503);
      }
    };
    let res = await send();
    // A READ refused for its token is retried once with a fresh session. A write never is.
    if (res.status === 401 && !opts.write) { this.token = null; res = await send(); }
    if (res.status === 401 || res.status === 403) { this.token = null; throw new DeviceError("gdms_authentication_failed", 503); }
    if (res.status === 429) throw new DeviceError("gdms_rate_limited_retry_later", 503);
    if (!res.ok) throw new DeviceError(opts.write ? "gdms_write_uncertain_check_again" : "gdms_service_unavailable", 503);
    let envelope: any;
    try { envelope = await res.json(); } catch { throw new DeviceError("gdms_invalid_response", 502); }
    if (!envelope || typeof envelope !== "object") throw new DeviceError("gdms_invalid_response", 502);
    const retCode = Number(envelope.retCode);
    if (!Number.isFinite(retCode)) throw new DeviceError("gdms_invalid_response", 502);
    if (retCode !== 0) throw new GdmsRejection("gdms_request_rejected", retCode);
    return envelope.data as T;
  }

  private static rowsOf(data: any): unknown[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.result)) return data.result;
    if (data && typeof data === "object") return [data];
    return [];
  }

  /** The device, if it is in THIS account's GDMS. Another account's devices are invisible here. */
  async findDevice(mac: string): Promise<GdmsDevice | null> {
    const n = normalizeMac(mac);
    if (!n) throw new DeviceError("invalid_mac", 400);
    const data = await this.call<any>("v1.0.0/device/list", { mac: formatMac(n), pageNum: 1, pageSize: 10 }, { write: false });
    for (const row of GdmsClient.rowsOf(data)) {
      const d = parseGdmsDevice(row);
      if (d && d.mac === n) return d;
    }
    return null;
  }

  async sites(): Promise<Array<{ id: string; name: string | null }>> {
    const data = await this.call<any>("v1.0.0/site/list", { pageNum: 1, pageSize: 100 }, { write: false });
    return GdmsClient.rowsOf(data)
      .map((row: any) => ({ id: row?.id ?? row?.siteId, name: cleanDeviceText(row?.siteName ?? row?.name, 80) }))
      .filter((s) => s.id !== undefined && s.id !== null && String(s.id).length > 0 && String(s.id).length <= 40)
      .map((s) => ({ id: String(s.id), name: s.name }));
  }

  /** Read-only proof the credentials work: the token plus one list call. */
  async verify(): Promise<{ organizations: number }> {
    const data = await this.call<any>("v1.0.0/org/list", { pageNum: 1, pageSize: 10 }, { write: false });
    return { organizations: GdmsClient.rowsOf(data).length };
  }

  async addDevice(input: { mac: string; serialNumber: string; siteId: string; deviceName?: string | null }): Promise<void> {
    const n = normalizeMac(input.mac);
    if (!n) throw new DeviceError("invalid_mac", 400);
    const sn = cleanSerialNumber(input.serialNumber);
    if (!sn) throw new DeviceError("serial_number_required", 400);
    const item: Record<string, string> = { mac: formatMac(n), sn, siteId: input.siteId };
    const name = cleanDeviceText(input.deviceName, 60);
    if (name) item.deviceName = name;
    const data = await this.call<any>("v1.0.0/device/add", [item], { write: true });
    // ⛔ device/add is a BATCH call: retCode 0 only means the request was well-formed. Each
    // device succeeds or fails on its own inside data — proven on the live cloud 2026-09-15:
    // {"total":1,"success":0,"failure":1,"errorDeviceList":[{"errorMsg":"30010",...}]} for a
    // serial that belongs to a different handset. Ignoring this read a refused add as success,
    // and the read-back's claim_not_verified sent the wizard into a forever-retry.
    const rejected = Array.isArray(data?.errorDeviceList) ? data.errorDeviceList : [];
    const failureCount = Number(data?.failure);
    if (rejected.length > 0 || (Number.isFinite(failureCount) && failureCount > 0)) {
      const itemCode = Number(rejected[0]?.errorMsg);
      throw new GdmsRejection("gdms_request_rejected", Number.isFinite(itemCode) ? itemCode : -1);
    }
  }

  async createTask(input: { mac: string; type: "reboot" | "factory_reset"; name: string }): Promise<{ taskId: string | null }> {
    const n = normalizeMac(input.mac);
    if (!n) throw new DeviceError("invalid_mac", 400);
    const data = await this.call<any>("v1.0.0/task/add", {
      taskName: cleanDeviceText(input.name, 60) ?? "Loopcom task",
      taskType: input.type === "reboot" ? 1 : 2,
      macList: [formatMac(n)],
      execType: 1,
    }, { write: true });
    const id = data?.taskId ?? data?.id ?? (typeof data === "string" || typeof data === "number" ? data : null);
    return { taskId: id === null || id === undefined ? null : String(id).slice(0, 64) };
  }
}

/** ⛔ Runtime may never select a simulated GDMS. The simulator is test-only. */
export function assertGdmsRuntimeMode(env: NodeJS.ProcessEnv = process.env): void {
  const mode = String(env.GDMS_MODE ?? "").toLowerCase();
  if (mode === "test" || mode === "mock" || mode === "simulator") throw new DeviceError("gdms_mock_not_allowed_in_runtime", 503);
}
