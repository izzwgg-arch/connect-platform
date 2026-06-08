/**
 * Active TURN reachability probe.
 *
 * Performs a real STUN/TURN Allocate against a relay endpoint to verify that:
 *   - the transport (UDP / TCP / TLS) is actually reachable, and
 *   - the HMAC `use-auth-secret` credentials the API generates are accepted, and
 *   - the server can allocate a relay address.
 *
 * Why (incident 2026-06-08): coturn's TLS listener (5349) had been down for over
 * a week and relay usage was 0% system-wide, but nothing actively verified the
 * relay path — the only "health" signal was "a TurnConfig row exists". This probe
 * turns that into a real end-to-end allocation check that can drive alerting.
 *
 * Implements just enough of RFC 5389 (STUN) / RFC 5766 (TURN) long-term
 * credential Allocate to get a definitive answer. No third-party deps.
 */
import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";
import { createHash, createHmac, randomBytes } from "node:crypto";

const MAGIC_COOKIE = 0x2112a442;

// STUN message types
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;

// Attributes
const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_FINGERPRINT = 0x8028;

export type TurnTransport = "udp" | "tcp" | "tls";

export type TurnProbeResult = {
  transport: TurnTransport;
  host: string;
  port: number;
  /** Got any valid STUN response back (server is reachable + speaking STUN). */
  reachable: boolean;
  /** Allocate succeeded with a relay address (full relay path works). */
  allocateOk: boolean;
  relayAddress?: string;
  /** STUN error code from the server when Allocate failed, e.g. 401/403/486. */
  errorCode?: number;
  errorReason?: string;
  /** Coarse failure stage for logs/alerts. */
  stage: "reachability" | "auth" | "allocate" | "ok";
  error?: string;
  elapsedMs: number;
};

function pad4(n: number): number {
  return (n + 3) & ~3;
}

type Attr = { type: number; value: Buffer };

function encodeAttrs(attrs: Attr[]): Buffer {
  const parts: Buffer[] = [];
  for (const a of attrs) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(a.type, 0);
    header.writeUInt16BE(a.value.length, 2);
    parts.push(header, a.value);
    const padLen = pad4(a.value.length) - a.value.length;
    if (padLen) parts.push(Buffer.alloc(padLen));
  }
  return Buffer.concat(parts);
}

function buildHeader(type: number, transactionId: Buffer, attrsLen: number): Buffer {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(attrsLen, 2);
  h.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(h, 8);
  return h;
}

/** Long-term credential integrity key: MD5(username ":" realm ":" password). */
export function longTermKey(username: string, realm: string, password: string): Buffer {
  return createHash("md5").update(`${username}:${realm}:${password}`).digest();
}

// CRC32 (IEEE) for FINGERPRINT.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type BuildAllocateOptions = {
  transactionId?: Buffer;
  /** UDP relay transport requested from the TURN server (protocol 17 = UDP). */
  requestedTransport?: number;
  auth?: { username: string; realm: string; nonce: string; password: string };
};

/**
 * Build an Allocate request. Without `auth` this is the unauthenticated first
 * leg (expected to draw a 401 + REALM/NONCE). With `auth` it is the signed
 * retry carrying MESSAGE-INTEGRITY (and FINGERPRINT).
 */
export function buildAllocateRequest(opts: BuildAllocateOptions = {}): Buffer {
  const transactionId = opts.transactionId ?? randomBytes(12);
  const reqTransport = opts.requestedTransport ?? 17; // UDP
  const rt = Buffer.alloc(4);
  rt[0] = reqTransport;
  const attrs: Attr[] = [{ type: ATTR_REQUESTED_TRANSPORT, value: rt }];

  if (!opts.auth) {
    const body = encodeAttrs(attrs);
    return Buffer.concat([buildHeader(ALLOCATE_REQUEST, transactionId, body.length), body]);
  }

  const { username, realm, nonce, password } = opts.auth;
  attrs.push({ type: ATTR_USERNAME, value: Buffer.from(username, "utf8") });
  attrs.push({ type: ATTR_REALM, value: Buffer.from(realm, "utf8") });
  attrs.push({ type: ATTR_NONCE, value: Buffer.from(nonce, "utf8") });

  const preMiBody = encodeAttrs(attrs);
  // MESSAGE-INTEGRITY is computed with the header length set as if MI (24 bytes
  // total: 4 header + 20 value) were already appended, but excludes MI itself.
  const lenWithMi = preMiBody.length + 24;
  const headerForMi = buildHeader(ALLOCATE_REQUEST, transactionId, lenWithMi);
  const key = longTermKey(username, realm, password);
  const integrity = createHmac("sha1", key).update(Buffer.concat([headerForMi, preMiBody])).digest();

  const miAttr = encodeAttrs([{ type: ATTR_MESSAGE_INTEGRITY, value: integrity }]);

  // FINGERPRINT covers everything before it; header length now also includes it
  // (8 bytes total: 4 header + 4 value).
  const lenWithFp = lenWithMi + 8;
  const headerForFp = buildHeader(ALLOCATE_REQUEST, transactionId, lenWithFp);
  const beforeFp = Buffer.concat([headerForFp, preMiBody, miAttr]);
  const fp = (crc32(beforeFp) ^ 0x5354554e) >>> 0;
  const fpVal = Buffer.alloc(4);
  fpVal.writeUInt32BE(fp, 0);
  const fpAttr = encodeAttrs([{ type: ATTR_FINGERPRINT, value: fpVal }]);

  return Buffer.concat([headerForFp, preMiBody, miAttr, fpAttr]);
}

export type ParsedStunMessage = {
  type: number;
  transactionId: Buffer;
  attrs: Map<number, Buffer>;
};

export function parseStunMessage(buf: Buffer): ParsedStunMessage | null {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const cookie = buf.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return null;
  if (buf.length < 20 + len) return null;
  const transactionId = buf.subarray(8, 20);
  const attrs = new Map<number, Buffer>();
  let off = 20;
  const end = 20 + len;
  while (off + 4 <= end) {
    const atype = buf.readUInt16BE(off);
    const alen = buf.readUInt16BE(off + 2);
    const start = off + 4;
    if (start + alen > buf.length) break;
    attrs.set(atype, buf.subarray(start, start + alen));
    off = start + pad4(alen);
  }
  return { type, transactionId, attrs };
}

function parseErrorCode(buf: Buffer | undefined): { code: number; reason: string } | null {
  if (!buf || buf.length < 4) return null;
  const cls = buf[2] & 0x07;
  const num = buf[3];
  const code = cls * 100 + num;
  const reason = buf.length > 4 ? buf.subarray(4).toString("utf8") : "";
  return { code, reason };
}

function parseXorRelayedAddress(buf: Buffer | undefined, transactionId: Buffer): string | null {
  if (!buf || buf.length < 8) return null;
  const family = buf[1];
  const xport = buf.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  if (family === 0x01) {
    const ip = buf.readUInt32BE(4) ^ MAGIC_COOKIE;
    const a = (ip >>> 24) & 0xff, b = (ip >>> 16) & 0xff, c = (ip >>> 8) & 0xff, d = ip & 0xff;
    return `${a}.${b}.${c}.${d}:${xport}`;
  }
  // IPv6: XOR with cookie||transactionId — best-effort, return port only marker.
  return `[ipv6]:${xport}`;
}

type SendFn = (payload: Buffer) => Promise<Buffer>;

async function withUdp<T>(host: string, port: number, timeoutMs: number, fn: (send: SendFn) => Promise<T>): Promise<T> {
  const socket = dgram.createSocket("udp4");
  const pending: Array<(b: Buffer) => void> = [];
  socket.on("message", (msg) => {
    const r = pending.shift();
    if (r) r(msg);
  });
  const send: SendFn = (payload) =>
    new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      pending.push((b) => { clearTimeout(timer); resolve(b); });
      socket.send(payload, port, host, (err) => { if (err) { clearTimeout(timer); reject(err); } });
    });
  try {
    return await fn(send);
  } finally {
    socket.close();
  }
}

async function withStream<T>(
  kind: "tcp" | "tls",
  host: string,
  port: number,
  timeoutMs: number,
  fn: (send: SendFn) => Promise<T>,
): Promise<T> {
  const socket: net.Socket | tls.TLSSocket = kind === "tls"
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
    : net.connect({ host, port });
  let buffer = Buffer.alloc(0);
  const waiters: Array<(b: Buffer) => void> = [];
  function tryDeliver() {
    // STUN over TCP/TLS is length-prefixed by the 2-byte length at offset 2.
    while (buffer.length >= 20) {
      const len = buffer.readUInt16BE(2);
      const total = 20 + len;
      if (buffer.length < total) break;
      const msg = buffer.subarray(0, total);
      buffer = buffer.subarray(total);
      const w = waiters.shift();
      if (w) w(Buffer.from(msg));
    }
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
    socket.once(kind === "tls" ? "secureConnect" : "connect", () => { clearTimeout(t); resolve(); });
    socket.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  socket.on("data", (d: Buffer) => { buffer = Buffer.concat([buffer, d]); tryDeliver(); });
  const send: SendFn = (payload) =>
    new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      waiters.push((b) => { clearTimeout(timer); resolve(b); });
      socket.write(payload, (err) => { if (err) { clearTimeout(timer); reject(err); } });
    });
  try {
    return await fn(send);
  } finally {
    socket.destroy();
  }
}

/**
 * Parse a client-facing relay url (`turn:`/`turns:`) into a probe target.
 * `turns:` → TLS (default port 5349); `turn:?transport=tcp` → TCP; else UDP
 * (default port 3478).
 */
export function parseRelayUrlForProbe(
  url: string,
): { host: string; port: number; transport: TurnTransport } | null {
  const m = /^(turns?):([^?]+)/i.exec(String(url || "").trim());
  if (!m) return null;
  const isTls = m[1].toLowerCase() === "turns";
  let transport: TurnTransport = isTls ? "tls" : "udp";
  if (!isTls) {
    const tp = /[?&]transport=([a-z]+)/i.exec(url);
    if (tp && tp[1].toLowerCase() === "tcp") transport = "tcp";
  }
  let host = m[2];
  let port = isTls ? 5349 : 3478;
  const portMatch = /:(\d+)$/.exec(host);
  if (portMatch) {
    port = Number(portMatch[1]);
    host = host.slice(0, host.length - portMatch[0].length);
  }
  if (!host) return null;
  return { host, port, transport };
}

export type ProbeTurnInput = {
  host: string;
  port: number;
  transport: TurnTransport;
  /** HMAC shared secret (coturn use-auth-secret). */
  authSecret: string;
  realm: string;
  /** Credential TTL for the ephemeral username timestamp. */
  credTtlSecs?: number;
  timeoutMs?: number;
};

/**
 * Run a single Allocate probe against one relay endpoint/transport.
 * Never throws — failures are returned in the result.
 */
export async function probeTurnAllocate(input: ProbeTurnInput): Promise<TurnProbeResult> {
  const { host, port, transport, authSecret, realm } = input;
  const timeoutMs = input.timeoutMs ?? 4000;
  const ttl = input.credTtlSecs ?? 300;
  const started = Date.now();
  const base: Omit<TurnProbeResult, "stage" | "reachable" | "allocateOk" | "elapsedMs"> = { transport, host, port };

  const username = String(Math.floor(Date.now() / 1000) + ttl);
  const password = createHmac("sha1", authSecret).update(username).digest("base64");

  const run = async (send: SendFn): Promise<TurnProbeResult> => {
    const txId = randomBytes(12);
    // Leg 1: unauthenticated Allocate → expect 401 with REALM/NONCE.
    const resp1 = await send(buildAllocateRequest({ transactionId: txId }));
    const m1 = parseStunMessage(resp1);
    if (!m1) {
      return { ...base, reachable: false, allocateOk: false, stage: "reachability", error: "bad_stun_response", elapsedMs: Date.now() - started };
    }
    const nonceBuf = m1.attrs.get(ATTR_NONCE);
    const realmBuf = m1.attrs.get(ATTR_REALM);
    if (m1.type === ALLOCATE_SUCCESS) {
      // Unauthenticated success (unusual) — relay works.
      const relay = parseXorRelayedAddress(m1.attrs.get(ATTR_XOR_RELAYED_ADDRESS), txId) || undefined;
      return { ...base, reachable: true, allocateOk: true, relayAddress: relay, stage: "ok", elapsedMs: Date.now() - started };
    }
    if (!nonceBuf) {
      const ec = parseErrorCode(m1.attrs.get(ATTR_ERROR_CODE));
      return {
        ...base, reachable: true, allocateOk: false, stage: "auth",
        errorCode: ec?.code, errorReason: ec?.reason, error: "no_nonce_challenge", elapsedMs: Date.now() - started,
      };
    }
    const serverRealm = realmBuf ? realmBuf.toString("utf8") : realm;
    const nonce = nonceBuf.toString("utf8");

    // Leg 2: signed Allocate with MESSAGE-INTEGRITY.
    const txId2 = randomBytes(12);
    const resp2 = await send(buildAllocateRequest({
      transactionId: txId2,
      auth: { username, realm: serverRealm, nonce, password },
    }));
    const m2 = parseStunMessage(resp2);
    if (!m2) {
      return { ...base, reachable: true, allocateOk: false, stage: "allocate", error: "bad_stun_response_2", elapsedMs: Date.now() - started };
    }
    if (m2.type === ALLOCATE_SUCCESS) {
      const relay = parseXorRelayedAddress(m2.attrs.get(ATTR_XOR_RELAYED_ADDRESS), txId2) || undefined;
      return { ...base, reachable: true, allocateOk: true, relayAddress: relay, stage: "ok", elapsedMs: Date.now() - started };
    }
    const ec = parseErrorCode(m2.attrs.get(ATTR_ERROR_CODE));
    return {
      ...base, reachable: true, allocateOk: false, stage: m2.type === ALLOCATE_ERROR ? "auth" : "allocate",
      errorCode: ec?.code, errorReason: ec?.reason, error: `allocate_error_${ec?.code ?? "unknown"}`, elapsedMs: Date.now() - started,
    };
  };

  try {
    if (transport === "udp") return await withUdp(host, port, timeoutMs, run);
    return await withStream(transport === "tls" ? "tls" : "tcp", host, port, timeoutMs, run);
  } catch (err) {
    return {
      ...base, reachable: false, allocateOk: false, stage: "reachability",
      error: String((err as Error)?.message ?? err), elapsedMs: Date.now() - started,
    };
  }
}
