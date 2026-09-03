/**
 * The RESIDENT PnP responder — the office machine's standing answer to "where are
 * my settings?".
 *
 * ⛔⛔ WHY THIS EXISTS (2026-09-02, the first live run at A plus center): the
 * one-shot responder in `pnp.ts` listened for 90 seconds around a restart command,
 * and the restart command never reached a factory-reset phone (it answers only on
 * HTTPS, and on factory defaults it asks the person at the phone before obeying an
 * Action URI at all). So the whole job rested on a person unplugging the phone
 * INSIDE a 90-second window somebody else had started. That is not automation.
 *
 * The durable shape is a listener that is simply THERE: while the Loopcom app is
 * open on a computer in the office, any of the customer's OWN phones that boots on
 * that network and asks is told its folder — a reset phone gets provisioned the
 * moment it is plugged in, with no wizard open and no restart trick. The wizard's
 * `set_provisioning` step rides this same responder (it just adds one hardware
 * address and, where a phone will accept it, asks the phone to restart).
 *
 * ⛔⛔ THE FENCES ARE THE SAME AS THE ONE-SHOT'S, AND THEY ARE NOT NEGOTIABLE:
 *   • the URL is checked with `isLoopcomProvisioningUrl` before a socket exists
 *     AND inside the NOTIFY builder — a phone downloads its whole config,
 *     including SIP credentials, from that folder;
 *   • only hardware addresses on the ARMED LIST are answered — the customer's own
 *     phones, as the PBX records them. A stranger's phone on the LAN (a visitor's,
 *     a neighbour's over a bridged Wi-Fi, a phone still owned by the previous
 *     provider) gets nothing, is not logged with its contents, and is never replied
 *     to. A phone that does not name its MAC is not answered by the resident at all
 *     (the one-shot may match by address because a person just found the phone
 *     there; a standing listener has no such fact);
 *   • each boot is answered ONCE (per Call-ID) — never a NOTIFY storm.
 *
 * ⛔ Pure by injection, exactly like `pnp.ts`: the socket, the clock and the token
 * source arrive as options, so every ordering is provable with no handset.
 */

import { createSocket as nodeCreateSocket } from "node:dgram";
import { isLoopcomProvisioningUrl } from "./yealink";
import {
  buildPnpNotify, buildPnpOk, isNotifyAck, normalizeMac, notifyTarget, parsePnpSubscribe,
  pickLocalAddressFor, PNP_MULTICAST_GROUP, PNP_PORT, type LocalEndpoint, type PnpSocket,
} from "./pnp";

/** The most hardware addresses one arm() may carry — a tenant, not a directory. */
export const PNP_RESIDENT_MAX_MACS = 512;

export type PnpDelivery = {
  mac: string;
  /** Where the SUBSCRIBE came from. */
  ip: string;
  /** The folder it was told. */
  url: string;
  at: number;
  acknowledged: boolean;
  agent: string | null;
};

export type PnpResidentStatus = {
  armed: boolean;
  listening: boolean;
  url: string | null;
  macs: number;
  /** Hardware addresses told their folder since the last arm(), newest first. */
  deliveries: PnpDelivery[];
  /** Why the socket is not listening, when it is not. */
  problem: "cannot_listen" | null;
};

export type PnpResident = {
  /**
   * Arm (or re-arm) the listener for ONE folder and a list of hardware addresses.
   * Re-arming with the same folder keeps the socket and the delivery log; a
   * different folder replaces the list and clears the log (a super-admin switching
   * tenants). Resolves to the listening state — false means the socket could not
   * bind, which the caller must say in plain words.
   */
  arm(opts: { url: string; macs: string[] }): Promise<boolean>;
  /** Add one hardware address to the armed list (the wizard's per-phone step). */
  addMac(mac: string): boolean;
  disarm(): void;
  status(): PnpResidentStatus;
  /** The delivery for one hardware address since `sinceMs` (or any), if there was one. */
  deliveryFor(mac: string, sinceMs?: number): PnpDelivery | null;
  /** Resolves when that hardware address is delivered to, or after `waitMs`. */
  waitForDelivery(mac: string, waitMs: number, sinceMs?: number): Promise<PnpDelivery | null>;
};

export type PnpResidentOptions = {
  createSocket?: () => PnpSocket;
  now?: () => number;
  randomToken?: () => string;
  /** Interface to listen on; undefined = pick from the first armed address's subnet. */
  localAddress?: string | null;
  /** Where to say what happened (never with packet contents). */
  log?: (line: string) => void;
};

const defaultCreateSocket = (): PnpSocket => nodeCreateSocket({ type: "udp4", reuseAddr: true }) as unknown as PnpSocket;
const defaultToken = () => Math.random().toString(36).slice(2, 12).replace(/[^0-9a-z]/g, "") || "a1b2c3";

export function createPnpResident(opts: PnpResidentOptions = {}): PnpResident {
  const now = opts.now ?? (() => Date.now());
  const token = opts.randomToken ?? defaultToken;
  const log = opts.log ?? (() => {});

  let url: string | null = null;
  const macs = new Set<string>();
  let socket: PnpSocket | null = null;
  let listening = false;
  let problem: PnpResidentStatus["problem"] = null;
  const answeredCallIds = new Map<string, { mac: string; agent: string | null; at: number }>();
  const deliveries: PnpDelivery[] = [];
  const waiters: Array<{ mac: string; since: number; resolve: (d: PnpDelivery | null) => void }> = [];

  const settle = (d: PnpDelivery) => {
    deliveries.unshift(d);
    if (deliveries.length > 64) deliveries.length = 64;
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.mac === d.mac && d.at >= w.since) { waiters.splice(i, 1); w.resolve(d); }
    }
  };

  const closeSocket = () => {
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    socket = null;
    listening = false;
  };

  const openSocket = (): Promise<boolean> => new Promise<boolean>((resolve) => {
    let s: PnpSocket;
    try { s = (opts.createSocket ?? defaultCreateSocket)(); }
    catch { problem = "cannot_listen"; resolve(false); return; }
    socket = s;
    let bound = false;
    s.on("error", () => {
      // Before the bind completed: cannot listen. After: the socket died — the
      // next arm() (the hourly refresh) opens a fresh one.
      problem = "cannot_listen";
      if (socket === s) closeSocket();
      if (!bound) resolve(false);
      log("pnp resident: socket error; not listening");
    });
    s.on("message", (msg, rinfo) => {
      if (socket !== s || !url) return;
      const text = msg.toString("utf8");
      // An ack for a NOTIFY we sent: mark the delivery acknowledged.
      for (const [callId, a] of answeredCallIds) {
        if (isNotifyAck(text, callId)) {
          const d = deliveries.find((x) => x.mac === a.mac && x.at === a.at);
          if (d) d.acknowledged = true;
          return;
        }
      }
      const sub = parsePnpSubscribe(text);
      if (!sub) return;
      // ⛔ Armed list only, by hardware address only. No address-based matching
      // in a standing listener — see the header.
      if (!sub.mac || !macs.has(sub.mac)) return;
      if (answeredCallIds.has(sub.callId)) return; // once per boot
      const local = opts.localAddress === undefined ? pickLocalAddressFor(rinfo.address) : opts.localAddress;
      const localEp: LocalEndpoint = { ip: local ?? "0.0.0.0", port: PNP_PORT };
      const tag = token();
      let ok: string, notify: string;
      try {
        ok = buildPnpOk(sub, localEp, tag);
        notify = buildPnpNotify(sub, url, localEp, tag, token(), notifyTarget(sub, rinfo));
      } catch { return; }
      const at = now();
      answeredCallIds.set(sub.callId, { mac: sub.mac, agent: sub.userAgent, at });
      if (answeredCallIds.size > 256) {
        const oldest = answeredCallIds.keys().next().value;
        if (oldest !== undefined) answeredCallIds.delete(oldest);
      }
      try {
        s.send(Buffer.from(ok, "utf8"), rinfo.port, rinfo.address);
        s.send(Buffer.from(notify, "utf8"), rinfo.port, rinfo.address, (err) => {
          if (err) { log(`pnp resident: notify to ${sub.mac} failed to send`); return; }
          log(`pnp resident: told ${sub.mac} at ${rinfo.address} its folder`);
          settle({ mac: sub.mac!, ip: rinfo.address, url: url!, at, acknowledged: false, agent: sub.userAgent });
        });
      } catch {
        log(`pnp resident: notify to ${sub.mac} threw`);
      }
    });
    try {
      s.bind(PNP_PORT, "0.0.0.0", () => {
        bound = true;
        // ⛔ A failed multicast join is not fatal — see pnp.ts. Join on the
        // interface that faces the phones when one is known; the OS default otherwise.
        const first = macs.size ? null : null;
        void first;
        const iface = opts.localAddress === undefined ? undefined : (opts.localAddress ?? undefined);
        try { s.addMembership(PNP_MULTICAST_GROUP, iface); } catch { /* listen anyway */ }
        listening = true;
        problem = null;
        log("pnp resident: listening on udp/5060");
        resolve(true);
      });
    } catch {
      problem = "cannot_listen";
      closeSocket();
      resolve(false);
    }
  });

  return {
    async arm({ url: nextUrl, macs: nextMacs }) {
      // ⛔ The fence, before anything else — a bad folder never becomes state.
      if (!isLoopcomProvisioningUrl(nextUrl)) return false;
      const normalized = (Array.isArray(nextMacs) ? nextMacs : []).map(normalizeMac).filter((m): m is string => Boolean(m));
      if (normalized.length > PNP_RESIDENT_MAX_MACS) normalized.length = PNP_RESIDENT_MAX_MACS;
      if (url !== nextUrl) {
        // A different folder: this is another tenant. Nothing from the old one may
        // leak into the new — list and log both start over.
        macs.clear();
        deliveries.length = 0;
        answeredCallIds.clear();
        url = nextUrl;
      }
      for (const m of normalized) macs.add(m);
      if (socket && listening) return true;
      closeSocket();
      return openSocket();
    },
    addMac(mac) {
      const m = normalizeMac(mac);
      if (!m || !url) return false;
      if (macs.size >= PNP_RESIDENT_MAX_MACS && !macs.has(m)) return false;
      macs.add(m);
      return true;
    },
    disarm() {
      closeSocket();
      url = null;
      macs.clear();
      deliveries.length = 0;
      answeredCallIds.clear();
      for (const w of waiters.splice(0)) w.resolve(null);
      problem = null;
      log("pnp resident: disarmed");
    },
    status() {
      return { armed: Boolean(url), listening, url, macs: macs.size, deliveries: [...deliveries], problem };
    },
    deliveryFor(mac, sinceMs) {
      const m = normalizeMac(mac);
      if (!m) return null;
      return deliveries.find((d) => d.mac === m && (sinceMs === undefined || d.at >= sinceMs)) ?? null;
    },
    waitForDelivery(mac, waitMs, sinceMs) {
      const m = normalizeMac(mac);
      if (!m) return Promise.resolve(null);
      const have = deliveries.find((d) => d.mac === m && (sinceMs === undefined || d.at >= sinceMs));
      if (have) return Promise.resolve(have);
      if (!listening) return Promise.resolve(null);
      return new Promise<PnpDelivery | null>((resolve) => {
        const w = { mac: m, since: sinceMs ?? 0, resolve: (d: PnpDelivery | null) => { clearTimeout(t); resolve(d); } };
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, Math.max(0, waitMs));
        waiters.push(w);
      });
    },
  };
}
