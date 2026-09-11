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
  buildPnpNotify, buildPnpOk, isNotifyAck, localMulticastInterfaces, normalizeMac, notifyTarget,
  parsePnpSubscribe, pickLocalAddressFor, PNP_MULTICAST_GROUP, PNP_PORT,
  type LocalEndpoint, type PnpSocket,
} from "./pnp";

/** The most hardware addresses one arm() may carry — a tenant, not a directory. */
export const PNP_RESIDENT_MAX_MACS = 512;

/**
 * The ports we listen on.
 *
 * ⛔ 5060 is the port every brand in the PBX catalogue documents, and it is the one
 * that must bind for the responder to be useful. 5080 is here because Grandstream's
 * own sources disagree with each other about which of the two its phones multicast
 * to, and a second socket is a great deal cheaper than a customer whose phone asks
 * on a port nobody is holding. Its failure to bind is logged and otherwise ignored —
 * never let the bonus port decide whether we are listening.
 */
export const PNP_PRIMARY_PORT = PNP_PORT;
export const PNP_SECONDARY_PORT = 5080;
export const PNP_LISTEN_PORTS = [PNP_PRIMARY_PORT, PNP_SECONDARY_PORT] as const;

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
  let sockets: PnpSocket[] = [];
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
    for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
    sockets = [];
    listening = false;
  };

  /**
   * Open ONE socket on one port and wire it up.
   *
   * ⛔ Resolves `true` only when the bind completed. The caller decides what a
   * failure means: on the primary port it means we are not listening, on the
   * secondary it means nothing at all.
   */
  const openOne = (port: number): Promise<boolean> => new Promise<boolean>((resolve) => {
    let s: PnpSocket;
    try { s = (opts.createSocket ?? defaultCreateSocket)(); }
    catch { resolve(false); return; }
    let bound = false;
    const drop = () => {
      sockets = sockets.filter((x) => x !== s);
      try { s.close(); } catch { /* already closed */ }
    };
    s.on("error", () => {
      // Before the bind completed: this port is unusable. After: this socket died —
      // the next arm() (the hourly refresh) opens a fresh one.
      drop();
      if (!bound) resolve(false);
      else log(`pnp resident: socket on udp/${port} errored; dropped`);
    });
    s.on("message", (msg, rinfo) => {
      if (!sockets.includes(s) || !url) return;
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
      if (!sub.mac) { log("pnp resident: heard a request that named no hardware address; ignored"); return; }
      if (!macs.has(sub.mac)) { log(`pnp resident: heard ${sub.mac}, not on the armed list; ignored`); return; }
      if (answeredCallIds.has(sub.callId)) return; // once per boot
      const local = opts.localAddress === undefined ? pickLocalAddressFor(rinfo.address) : opts.localAddress;
      // ⛔ The reply names the port the phone actually reached us on, not a constant:
      // a phone that asked on 5080 must be told where to answer.
      const localEp: LocalEndpoint = { ip: local ?? "0.0.0.0", port };
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
          log(`pnp resident: told ${sub.mac} at ${rinfo.address} its folder (udp/${port}, ${sub.accept ?? "default"} body)`);
          settle({ mac: sub.mac!, ip: rinfo.address, url: url!, at, acknowledged: false, agent: sub.userAgent });
        });
      } catch {
        log(`pnp resident: notify to ${sub.mac} threw`);
      }
    });
    try {
      s.bind(port, "0.0.0.0", () => {
        bound = true;
        sockets.push(s);
        // ⛔⛔ JOIN ON EVERY NETWORK THIS MACHINE IS ON, not just the OS default.
        // A failed join is not fatal — some interfaces refuse it while still
        // delivering the group's traffic, and some firmware sends a unicast
        // SUBSCRIBE as well — so we try them all and listen regardless.
        const ifaces = opts.localAddress === undefined
          ? localMulticastInterfaces()
          : (opts.localAddress ? [opts.localAddress] : []);
        const joined: string[] = [];
        for (const addr of ifaces) {
          try { s.addMembership(PNP_MULTICAST_GROUP, addr); joined.push(addr); } catch { /* try the next */ }
        }
        if (!joined.length) {
          // No interface accepted a join (or there were none to try). Ask for the
          // group on whatever the OS picks rather than giving up on multicast.
          try { s.addMembership(PNP_MULTICAST_GROUP); joined.push("os-default"); } catch { /* listen anyway */ }
        }
        log(`pnp resident: listening on udp/${port}; joined ${joined.length ? joined.join(", ") : "no interface"}`);
        resolve(true);
      });
    } catch {
      drop();
      resolve(false);
    }
  });

  /**
   * Open the listening sockets.
   *
   * ⛔ The PRIMARY port decides whether we are listening. The secondary is a bonus
   * for one brand whose documentation contradicts itself, and a machine where
   * something else already holds 5080 is not a machine that cannot set up phones.
   */
  const openSocket = async (): Promise<boolean> => {
    const primary = await openOne(PNP_PRIMARY_PORT);
    if (!primary) {
      problem = "cannot_listen";
      closeSocket();
      return false;
    }
    const secondary = await openOne(PNP_SECONDARY_PORT);
    if (!secondary) log(`pnp resident: udp/${PNP_SECONDARY_PORT} unavailable; primary port is enough`);
    listening = true;
    problem = null;
    return true;
  };

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
      if (sockets.length && listening) return true;
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
