import { Socket } from "net";

// Read-only AMI live-endpoint check.
//
// Connect's extension sync (`apps/api/src/pbxExtensionSync.ts`) decides
// `webrtcEnabled` from whatever VitalPBX's REST API (`/api/v2/extensions`,
// `/api/v2/extensions/:id/devices`) happens to return. That is a config-DB
// snapshot, not the live Asterisk truth — an admin-created "_1" WebRTC device
// can be fully live on the PBX (wss transport + DTLS, registering fine) while
// VitalPBX's own API omits it from those responses. This module adds a live,
// read-only cross-check straight against Asterisk via AMI's `PJSIPShowEndpoint`
// reporting action (never a config write, never "Apply Changes" — see
// AGENTS.md "Cursor is STRICTLY READ-ONLY on the PBX").
//
// Pattern mirrors the previously hand-run diagnostic probe at
// `_latency_logs/ami_webrtc_endpoint_dump.js` (raw `net.Socket`, AMI login,
// `\r\n\r\n`-delimited frames), formalized here as a reusable, testable module.

export interface PjsipEndpointLiveDetail {
  endpoint: string;
  /** True when Asterisk reports a live PJSIP endpoint object by this exact name. */
  exists: boolean;
  /** All "Key: Value" fields seen across the EndpointDetail/AorDetail/AuthDetail blocks, lowercased keys. */
  fields: Record<string, string>;
  transport: string | null;
  aor: string | null;
  auth: string | null;
  mediaEncryption: string | null;
  /** Asterisk's own `Webrtc: yes/no` endpoint field, when present. */
  webrtcFlag: boolean | null;
  /** Our heuristic: exists, has an aor + auth, and (webrtc=yes OR wss transport OR dtls media encryption). */
  isWebrtcCapable: boolean;
}

export interface AmiLiveReadConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

function resolveAmiConfig(cfg?: AmiLiveReadConfig): {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  timeoutMs: number;
} {
  const host = cfg?.host || process.env.PBX_AMI_HOST || process.env.PBX_HOST || "";
  const port = Number(cfg?.port || process.env.PBX_AMI_PORT || process.env.AMI_PORT || 5038);
  const username = cfg?.username || process.env.PBX_AMI_USERNAME || process.env.AMI_USERNAME || null;
  const password = cfg?.password || process.env.PBX_AMI_PASSWORD || process.env.AMI_PASSWORD || null;
  const timeoutMs = Number(cfg?.timeoutMs || 8000);
  return { host, port, username, password, timeoutMs };
}

/**
 * Pure parser for a raw AMI `PJSIPShowEndpoint` response transcript (one or
 * more `\r\n\r\n`-delimited blocks concatenated with newlines). No network
 * I/O — safe to unit test with fixture text.
 */
export function parsePjsipShowEndpointTranscript(endpoint: string, raw: string): PjsipEndpointLiveDetail {
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim();
    // EndpointDetail is emitted first; keep the first non-empty value per key
    // so a later TransportDetail/AorDetail block can't silently overwrite it.
    if (fields[key] === undefined || fields[key] === "") fields[key] = value;
  }

  const hasError = /response:\s*error/i.test(raw);
  const hasEndpointDetail = /objecttype:\s*endpoint\b/i.test(raw);
  const exists = !hasError && hasEndpointDetail;

  const transport = fields["transport"] || null;
  const aor = fields["aor"] || fields["aors"] || null;
  const auth = fields["auth"] || fields["auths"] || null;
  const mediaEncryption = fields["mediaencryption"] || fields["media_encryption"] || null;
  const webrtcFieldRaw = fields["webrtc"];
  const webrtcFlag = webrtcFieldRaw === undefined ? null : /^y(es)?$/i.test(webrtcFieldRaw);

  const transportLooksWebrtc = !!transport && /wss|websocket|\bws\b/i.test(transport);
  const dtlsEncryption = !!mediaEncryption && /dtls/i.test(mediaEncryption);

  const isWebrtcCapable =
    exists && !!aor && !!auth && !!(webrtcFlag || transportLooksWebrtc || dtlsEncryption);

  return { endpoint, exists, fields, transport, aor, auth, mediaEncryption, webrtcFlag, isWebrtcCapable };
}

/**
 * Live, read-only AMI query for a single PJSIP endpoint's configuration.
 * `PJSIPShowEndpoint` is a reporting action — this never mutates PBX config,
 * never triggers Apply Changes. Always resolves (never throws/rejects) so
 * callers can treat a failure (unreachable AMI, bad creds, timeout, endpoint
 * not configured) as "inconclusive" and fall back to their existing
 * detection, mirroring the non-fatal contract already used for
 * `deviceProfiles.webrtc` lookups in `pbxExtensionSync.ts`.
 */
export async function queryPjsipEndpointLive(
  endpoint: string,
  cfg?: AmiLiveReadConfig,
): Promise<PjsipEndpointLiveDetail | null> {
  const { host, port, username, password, timeoutMs } = resolveAmiConfig(cfg);
  if (!host || !username || !password) return null;

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sock = new Socket();

    const finish = (result: PjsipEndpointLiveDetail | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    timer = setTimeout(() => finish(null), timeoutMs);

    let buf = "";
    let loggedIn = false;
    const blocks: string[] = [];

    const send = (action: string, params?: Record<string, string>) => {
      let msg = `Action: ${action}\r\n`;
      for (const [k, v] of Object.entries(params || {})) msg += `${k}: ${v}\r\n`;
      sock.write(msg + "\r\n");
    };

    sock.on("connect", () => send("Login", { Username: username!, Secret: password! }));
    sock.on("error", () => finish(null));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (!loggedIn) {
        if (/Response:\s*Success[\s\S]*Authentication accepted/i.test(buf)) {
          loggedIn = true;
          buf = "";
          send("PJSIPShowEndpoint", { Endpoint: endpoint, ActionID: `syncsip_${Date.now()}` });
        } else if (/Response:\s*Error/i.test(buf)) {
          finish(null);
        }
        return;
      }
      let idx: number;
      while ((idx = buf.indexOf("\r\n\r\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        blocks.push(block);
        if (/EndpointDetailComplete|Authentication failed|not allowed|Response:\s*Error/i.test(block)) {
          send("Logoff");
          finish(parsePjsipShowEndpointTranscript(endpoint, blocks.join("\n")));
          return;
        }
      }
    });

    sock.connect(port, host);
  });
}

/** Deterministic VitalPBX WebRTC device-name convention: `T<code>_<ext>_1`. */
export function buildWebrtcCandidateEndpointName(tenantPrefix: string, extNumber: string): string {
  const prefix = String(tenantPrefix || "").trim().replace(/_+$/, "");
  const ext = String(extNumber || "").trim();
  return `${prefix}_${ext}_1`;
}
