/**
 * Yealink PnP — telling a factory-reset phone where Loopcom is.
 *
 * A Yealink handset that has been reset knows nothing: no server, no account. On
 * every boot it multicasts a SIP SUBSCRIBE for the `ua-profile` event to
 * 224.0.1.75:5060 and believes whoever answers with a NOTIFY carrying a URL — no
 * password, no web login, nothing installed. That is the documented zero-touch
 * mechanism (RFC 6080 / Yealink "PnP"), and it is the ONLY way the office machine can
 * hand a reset phone its provisioning address: the web interface needs a per-firmware
 * encrypted login, and the PBX cannot NOTIFY a phone that is not registered to it.
 *
 * ⛔⛔ THE URL IS THE WHOLE PAYLOAD, SO THE URL IS THE WHOLE RISK. This module never
 * decides the URL; it is handed one that `capability.ts` has already fenced to a
 * Loopcom provisioning folder, and it checks the fence AGAIN before a byte goes out.
 * A responder that would answer any phone with any URL is a way to hijack every
 * handset on a customer's network — which is exactly why only the ONE target phone
 * (matched by hardware address, or by the address it was found at) is ever answered,
 * and only once.
 *
 * ⛔ PnP fires ONCE PER BOOT. A phone that already booted has already asked and got
 * silence, so the caller restarts it (Action URI reboot, or the person power-cycles
 * it) while this is listening. Listening first, then rebooting — the other order
 * can miss a fast phone.
 *
 * ⛔ Pure by injection: the socket factory, the local address and the clock arrive
 * as arguments, so the exchange is proven without a phone on a desk.
 */

import { createSocket as nodeCreateSocket, type RemoteInfo } from "node:dgram";
import { networkInterfaces } from "node:os";
import { canonicalPrivateIpv4, isLoopcomProvisioningUrl } from "./yealink";

export const PNP_MULTICAST_GROUP = "224.0.1.75";
export const PNP_PORT = 5060;
/** A T5x boots in 40–80 s; 90 s covers a reboot plus the phone's own retry. */
export const PNP_DEFAULT_WAIT_MS = 90_000;
export const PNP_MAX_WAIT_MS = 150_000;
/** How long to wait for the phone's 200 OK to our NOTIFY before calling it done. */
export const PNP_ACK_WAIT_MS = 3_000;
/** What almost every brand asks for, and what we answer when a phone names nothing. */
export const PNP_DEFAULT_CONTENT_TYPE = "application/url";

/**
 * A media type is only usable if it is a plain `type/subtype` of RFC 7230 token
 * characters.
 *
 * ⛔⛔ THIS VALUE ARRIVES FROM THE PHONE AND IS WRITTEN STRAIGHT INTO A HEADER, so
 * it is an injection surface in the most literal sense: a CR or LF in it would end
 * the header and let a device dictate the rest of our message. Bounded, character
 * classed, and anything that is not exactly a token pair is refused in favour of the
 * default — never sanitised into something "close enough".
 */
const MEDIA_TYPE_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}\/[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

export function usableContentType(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // An Accept header may list several; take the first we can safely echo.
  for (const part of String(raw).split(",")) {
    const candidate = part.split(";")[0].trim();
    if (!candidate || candidate.length > 129) continue;
    if (candidate === "*/*") return null;
    if (MEDIA_TYPE_RE.test(candidate)) return candidate;
  }
  return null;
}

export type PnpSubscribe = {
  requestUri: string;
  vias: string[];
  from: string;
  to: string;
  callId: string;
  cseq: string;
  contact: string | null;
  userAgent: string | null;
  event: string;
  /** Normalised 12-hex hardware address, when the phone put one in the request. */
  mac: string | null;
  /**
   * The body type the phone asked for, when it named one it will actually take.
   *
   * ⛔ Brands disagree: most want `application/url`, and Grandstream documentation
   * also describes `application/x-gs-ucm-url`. Rather than pick a side per vendor —
   * which is a guess made against somebody's hardware — we answer with what the
   * phone itself asked for, and fall back to the near-universal default when it
   * asked for nothing usable.
   */
  accept: string | null;
};

const COMPACT_HEADERS: Record<string, string> = {
  v: "via", f: "from", t: "to", i: "call-id", m: "contact", o: "event",
};

export function normalizeMac(input: unknown): string | null {
  const cleaned = String(input ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (cleaned.length !== 12) return null;
  if (cleaned === "000000000000" || cleaned === "ffffffffffff") return null;
  return cleaned;
}

/**
 * Read a PnP SUBSCRIBE off the wire. Anything that is not a SUBSCRIBE for
 * `ua-profile` with the headers a reply needs is `null` — never a guess.
 */
export function parsePnpSubscribe(text: string): PnpSubscribe | null {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = (lines[0] ?? "").trim();
  const m = /^SUBSCRIBE\s+(\S+)\s+SIP\/2\.0$/i.exec(start);
  if (!m) return null;
  const headers: Record<string, string[]> = {};
  for (const raw of lines.slice(1)) {
    if (raw.trim() === "") break;
    const i = raw.indexOf(":");
    if (i < 1) continue;
    let name = raw.slice(0, i).trim().toLowerCase();
    name = COMPACT_HEADERS[name] ?? name;
    (headers[name] ??= []).push(raw.slice(i + 1).trim());
  }
  const one = (n: string): string | null => headers[n]?.[0] ?? null;
  const event = one("event");
  if (!event || !/^ua-profile\b/i.test(event)) return null;
  const from = one("from"), to = one("to"), callId = one("call-id"), cseq = one("cseq");
  if (!from || !to || !callId || !cseq || !headers.via?.length) return null;
  const hay = `${m[1]} ${from} ${one("user-agent") ?? ""}`;
  const tagged = /MAC(?:%3a|:)([0-9a-f]{12})/i.exec(hay);
  const dotted = /\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i.exec(hay);
  const mac = tagged ? normalizeMac(tagged[1]) : dotted ? normalizeMac(dotted[1]) : null;
  return {
    requestUri: m[1], vias: headers.via, from, to, callId, cseq,
    contact: one("contact"), userAgent: one("user-agent"), event, mac,
    accept: usableContentType(one("accept")),
  };
}

export type LocalEndpoint = { ip: string; port: number };

/** ⛔ CRLF is the SIP wire format. A header value cannot carry CRLF: the parser split on it. */
const CRLF = "\r\n";

export function buildPnpOk(sub: PnpSubscribe, local: LocalEndpoint, tag: string): string {
  const to = /;tag=/i.test(sub.to) ? sub.to : `${sub.to};tag=${tag}`;
  return [
    "SIP/2.0 200 OK",
    ...sub.vias.map((v) => `Via: ${v}`),
    `From: ${sub.from}`,
    `To: ${to}`,
    `Call-ID: ${sub.callId}`,
    `CSeq: ${sub.cseq}`,
    `Contact: <sip:pnp@${local.ip}:${local.port}>`,
    "Expires: 0",
    "Content-Length: 0",
    "", "",
  ].join(CRLF);
}

/**
 * The NOTIFY that carries the URL. Shape follows the responders proven on current
 * firmware (T43U 108.8x, T46S 66.8x): `Event: ua-profile;effective-by=0`,
 * `Subscription-State: terminated`, body `application/url`.
 */
export function buildPnpNotify(
  sub: PnpSubscribe, url: string, local: LocalEndpoint, tag: string, branchSeed: string, target: string,
): string {
  if (!isLoopcomProvisioningUrl(url)) throw new Error("refused: not a Loopcom provisioning folder");
  if (!/^[0-9A-Za-z]+$/.test(branchSeed) || !/^[0-9A-Za-z]+$/.test(tag)) throw new Error("refused: bad token");
  // ⛔ Re-validated here even though the parser already checked it: this is the
  // function that writes the header, and it must not depend on a caller having been
  // careful. Same belt-and-braces as the URL fence two lines above.
  const contentType = usableContentType(sub.accept) ?? PNP_DEFAULT_CONTENT_TYPE;
  const body = url;
  return [
    `NOTIFY ${target} SIP/2.0`,
    `Via: SIP/2.0/UDP ${local.ip}:${local.port};branch=z9hG4bK${branchSeed};rport`,
    "Max-Forwards: 70",
    `From: <sip:pnp@${local.ip}:${local.port}>;tag=${tag}`,
    `To: ${sub.from}`,
    `Call-ID: ${sub.callId}`,
    "CSeq: 1 NOTIFY",
    `Contact: <sip:pnp@${local.ip}:${local.port}>`,
    "Event: ua-profile;effective-by=0",
    "Subscription-State: terminated;reason=timeout",
    `Content-Type: ${contentType}`,
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    "",
    body,
  ].join(CRLF);
}

/** Where to send the NOTIFY: the phone's Contact when it is a plain sip URI, else where the SUBSCRIBE came from. */
export function notifyTarget(sub: PnpSubscribe, rinfo: { address: string; port: number }): string {
  const c = sub.contact ? /<(sip:[^>]+)>/i.exec(sub.contact)?.[1] ?? (/^sip:\S+$/i.test(sub.contact) ? sub.contact : null) : null;
  if (c && /^sip:[0-9A-Za-z.:@_-]+$/.test(c)) return c;
  return `sip:${rinfo.address}:${rinfo.port}`;
}

/** Is this a 2xx answer to OUR NOTIFY in this dialog? */
export function isNotifyAck(text: string, callId: string): boolean {
  const t = String(text ?? "");
  if (!/^SIP\/2\.0\s+2\d\d\b/i.test(t)) return false;
  if (!new RegExp(`^(?:Call-ID|i)\\s*:\\s*${escapeRe(callId)}\\s*$`, "im").test(t)) return false;
  return /^CSeq\s*:\s*1\s+NOTIFY\s*$/im.test(t);
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);

/**
 * The address on THIS machine that sits on the phone's network, so the multicast
 * join and the NOTIFY's Via both name the right interface. Falls back to any
 * private IPv4, else null (the socket then joins on the OS default).
 */
export function pickLocalAddressFor(
  phoneIp: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  let firstPrivate: string | null = null;
  const target = canonicalPrivateIpv4(phoneIp);
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" && (entry.family as unknown) !== 4) continue;
      if (entry.internal) continue;
      const addr = canonicalPrivateIpv4(entry.address);
      if (!addr) continue;
      if (!firstPrivate) firstPrivate = addr;
      if (!target || !entry.netmask) continue;
      const mask = ipToInt(entry.netmask);
      if ((ipToInt(addr) & mask) === (ipToInt(target) & mask)) return addr;
    }
  }
  return firstPrivate;
}

/**
 * Every address on this machine that a phone could plausibly multicast to us on.
 *
 * ⛔⛔ THE RESIDENT USED TO JOIN THE GROUP ON ONE INTERFACE — the OS default — and
 * on a machine with more than one network that is a coin toss. A PC with a cable
 * and Wi-Fi, or an office where the phones sit behind an extender handing out a
 * second range, would simply never hear the SUBSCRIBE, and the failure is silent:
 * the socket is open, nothing is wrong, the phone just asks into a void.
 *
 * ⛔ DELIBERATELY MORE PERMISSIVE THAN THE SCANNER. `localScannableNetworks` skips
 * virtual adapters by NAME (Hyper-V, WSL, Docker, Tailscale) because sweeping them
 * wastes a 3,000-address budget on nothing. Joining a multicast group on one costs
 * nothing at all, while skipping the wrong adapter costs the whole feature — and a
 * real office NIC can carry "VPN" in its name. So membership asks only the question
 * that matters: is this a real, private, non-loopback IPv4 address?
 */
export function localMulticastInterfaces(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" && (entry.family as unknown) !== 4) continue;
      if (entry.internal) continue;
      const addr = canonicalPrivateIpv4(entry.address);
      if (!addr || out.includes(addr)) continue;
      out.push(addr);
    }
  }
  return out;
}

export type PnpOutcome =
  | { ok: true; delivered: true; acknowledged: boolean; agent: string | null; waitedMs: number }
  | { ok: true; delivered: false; reason: "no_subscribe"; waitedMs: number }
  | { ok: false; refused: "bad_target" | "bad_url" | "cannot_listen" };

/** The socket surface this module needs — node's dgram socket, or a fake in tests. */
export type PnpSocket = {
  bind(port: number, address: string, cb: () => void): void;
  addMembership(group: string, iface?: string): void;
  send(msg: Buffer, port: number, address: string, cb?: (err: Error | null) => void): void;
  close(): void;
  on(event: "message", cb: (msg: Buffer, rinfo: RemoteInfo) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
};

export type PnpHandoffOptions = {
  ip: string;
  mac: string;
  url: string;
  waitMs?: number;
  localAddress?: string | null;
  createSocket?: () => PnpSocket;
  now?: () => number;
  randomToken?: () => string;
};

export type PnpHandoff = {
  /** Resolves true once the socket is bound and joined — reboot the phone AFTER this. */
  listening: Promise<boolean>;
  outcome: Promise<PnpOutcome>;
};

const defaultCreateSocket = (): PnpSocket => nodeCreateSocket({ type: "udp4", reuseAddr: true }) as unknown as PnpSocket;
const defaultToken = () => Math.random().toString(36).slice(2, 12).replace(/[^0-9a-z]/g, "") || "a1b2c3";

/**
 * Listen for ONE phone's PnP SUBSCRIBE and answer it with ONE URL.
 *
 * ⛔ Only the target phone is answered: a SUBSCRIBE whose hardware address is the
 * target's, or (when the phone did not say its MAC) one arriving from the address
 * the phone was found at. Everything else on the network is ignored, not logged
 * with its contents, and never replied to.
 */
export function startPnpHandoff(opts: PnpHandoffOptions): PnpHandoff {
  const now = opts.now ?? (() => Date.now());
  const token = opts.randomToken ?? defaultToken;
  const ip = canonicalPrivateIpv4(opts.ip);
  const mac = normalizeMac(opts.mac);
  const url = String(opts.url ?? "");
  const waitMs = Math.min(PNP_MAX_WAIT_MS, Math.max(5_000, Number(opts.waitMs) || PNP_DEFAULT_WAIT_MS));

  let resolveListening!: (v: boolean) => void;
  const listening = new Promise<boolean>((r) => { resolveListening = r; });

  const outcome = new Promise<PnpOutcome>((resolve) => {
    if (!ip || !mac) { resolveListening(false); resolve({ ok: false, refused: "bad_target" }); return; }
    if (!isLoopcomProvisioningUrl(url)) { resolveListening(false); resolve({ ok: false, refused: "bad_url" }); return; }

    const startedAt = now();
    const local = opts.localAddress === undefined ? pickLocalAddressFor(ip) : opts.localAddress;
    let socket: PnpSocket;
    try { socket = (opts.createSocket ?? defaultCreateSocket)(); }
    catch { resolveListening(false); resolve({ ok: false, refused: "cannot_listen" }); return; }

    let settled = false;
    let answered: { callId: string; agent: string | null } | null = null;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (out: PnpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ackTimer) clearTimeout(ackTimer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(out);
    };
    const timer = setTimeout(() => finish({ ok: true, delivered: false, reason: "no_subscribe", waitedMs: now() - startedAt }), waitMs);

    socket.on("error", () => {
      // Before the bind completed this is "cannot listen"; afterwards a socket error
      // simply ends the wait — the caller decides what to do with "not delivered".
      resolveListening(false);
      finish({ ok: false, refused: "cannot_listen" });
    });

    socket.on("message", (msg, rinfo) => {
      const text = msg.toString("utf8");
      if (answered) {
        if (isNotifyAck(text, answered.callId)) {
          finish({ ok: true, delivered: true, acknowledged: true, agent: answered.agent, waitedMs: now() - startedAt });
        }
        return;
      }
      const sub = parsePnpSubscribe(text);
      if (!sub) return;
      // ⛔ The target and only the target. A MAC in the request is authoritative; a
      // phone that did not name itself must at least be where we found it.
      const matches = sub.mac ? sub.mac === mac : rinfo.address === ip;
      if (!matches) return;

      const tag = token();
      const localEp: LocalEndpoint = { ip: local ?? "0.0.0.0", port: PNP_PORT };
      let ok: string, notify: string;
      try {
        ok = buildPnpOk(sub, localEp, tag);
        notify = buildPnpNotify(sub, url, localEp, tag, token(), notifyTarget(sub, rinfo));
      } catch { finish({ ok: false, refused: "bad_url" }); return; }
      answered = { callId: sub.callId, agent: sub.userAgent };
      try {
        socket.send(Buffer.from(ok, "utf8"), rinfo.port, rinfo.address);
        socket.send(Buffer.from(notify, "utf8"), rinfo.port, rinfo.address, (err) => {
          if (err) { finish({ ok: true, delivered: false, reason: "no_subscribe", waitedMs: now() - startedAt }); return; }
          // Delivered. The phone's 200 OK is confirmation, not a requirement — a
          // phone that is already fetching may not bother answering.
          ackTimer = setTimeout(() => finish({ ok: true, delivered: true, acknowledged: false, agent: sub.userAgent, waitedMs: now() - startedAt }), PNP_ACK_WAIT_MS);
        });
      } catch {
        finish({ ok: true, delivered: false, reason: "no_subscribe", waitedMs: now() - startedAt });
      }
    });

    try {
      socket.bind(PNP_PORT, "0.0.0.0", () => {
        // ⛔ A failed multicast join is not fatal: some interfaces refuse the join
        // while still delivering the group's traffic, and a unicast SUBSCRIBE
        // (some firmware sends both) still arrives. We listen either way.
        try { socket.addMembership(PNP_MULTICAST_GROUP, local ?? undefined); } catch { /* listen anyway */ }
        resolveListening(true);
      });
    } catch {
      resolveListening(false);
      finish({ ok: false, refused: "cannot_listen" });
    }
  });

  return { listening, outcome };
}
