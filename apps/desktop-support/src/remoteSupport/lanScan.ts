/**
 * Finding the desk phones on a customer's own network.
 *
 * Why this is worth having: the MAC on the PBX record is the one thing in
 * phone provisioning that nothing verifies. VitalPBX writes a config file named
 * after the MAC it was told, and the phone downloads the file named after the
 * MAC it has. When those differ there is no error anywhere — the panel looks
 * right, the log shows a clean 200 for a different filename, and the handset
 * serves a config from weeks ago. This module produces the other half of that
 * comparison: what the phones on the network actually are.
 *
 * ⛔ IT ONLY EVER SEES ONE SUBNET — the one the Windows machine is sitting on.
 * An office with several networks needs the app running on each, or the results
 * are quietly partial. The scan reports the subnet it looked at for exactly
 * this reason: a short list must be readable as "here is where I looked",
 * never as "this office has three phones".
 *
 * ⛔ SCANNING IS AN EXPLICIT ACTION. Nothing here runs on a timer. A support
 * tool that inventories a customer's network in the background is a different
 * product, and the difference is consent.
 */
import { exec } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";

export type DiscoveredHost = {
  ip: string;
  mac: string;
  /** Set when the host answered on a web port — phones nearly always do. */
  respondedOnHttp?: boolean;
};

export type ScanResult = {
  subnet: string | null;
  hostsSeen: number;
  hosts: DiscoveredHost[];
  outcome: "ok" | "partial" | "failed";
  note?: string;
};

/**
 * The web ports a desk phone answers on. Hitting one both proves something is
 * there and forces the OS to resolve its MAC into the ARP table, which is where
 * we actually read it from.
 */
const PHONE_PORTS = [80, 443];

/** How many addresses to probe at once. Bounded so a scan cannot swamp a small office LAN. */
const CONCURRENCY = 32;

/** Per-address connect timeout. Short: a phone on the same LAN answers in single-digit ms. */
const PROBE_TIMEOUT_MS = 400;

/**
 * Local IPv4 networks worth scanning.
 *
 * ⛔ Restricted to /24 and to private ranges on purpose. A corporate /16 is
 * 65,000 addresses — probing that would look exactly like a port scan to any
 * monitoring the customer runs, and would take far too long to be useful.
 */
export function localScannableSubnets(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.netmask !== "255.255.255.0") continue;
      if (!isPrivateIpv4(addr.address)) continue;
      const base = addr.address.split(".").slice(0, 3).join(".");
      const cidr = `${base}.0/24`;
      if (!out.includes(cidr)) out.push(cidr);
    }
  }
  return out;
}

/** RFC1918 only — never probe a public range from a customer's machine. */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Every host address in a /24, skipping the network and broadcast addresses. */
export function hostsInSubnet(cidr: string): string[] {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/);
  if (!m) return [];
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  const out: string[] = [];
  for (let i = 1; i <= 254; i += 1) out.push(`${base}.${i}`);
  return out;
}

/**
 * Parse Windows `arp -a` output.
 *
 * ⛔ Pure and unit-tested because everything downstream depends on reading the
 * MAC correctly, and a parser that silently returns nothing is indistinguishable
 * from an office with no phones.
 */
export function parseArpTable(output: string): DiscoveredHost[] {
  const out: DiscoveredHost[] = [];
  const seen = new Set<string>();

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    // "  192.168.1.20   80-5e-0c-4d-7e-6b   dynamic"
    const m = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})\s*(\S+)?/);
    if (!m) continue;

    const ip = m[1];
    const macRaw = m[2].toLowerCase().replace(/[^0-9a-f]/g, "");
    const type = (m[3] || "").toLowerCase();

    // Multicast and broadcast entries are not hosts. `static` rows in the ARP
    // table are overwhelmingly these, and including them would put phantom
    // "devices" in a customer's inventory.
    if (macRaw === "ffffffffffff" || macRaw === "000000000000") continue;
    if (ip.endsWith(".255")) continue;
    if (ip.startsWith("224.") || ip.startsWith("239.")) continue;
    // Multicast MACs start 01:00:5e.
    if (macRaw.startsWith("01005e")) continue;
    if (type === "invalid") continue;

    if (seen.has(macRaw)) continue;
    seen.add(macRaw);
    out.push({ ip, mac: macRaw });
  }
  return out;
}

/** Open a TCP connection just long enough to prove something is listening. */
function probe(ip: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    const socket = createConnection({ host: ip, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    // A refused connection still proves a host is there, but we only care about
    // things answering on a web port, so this counts as no.
    socket.on("error", () => done(false));
  });
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function runArp(): Promise<string> {
  return new Promise((resolve) => {
    exec("arp -a", { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      // ⛔ Never reject. A failed arp means an empty inventory, which the caller
      // reports honestly as a failed scan rather than as "no phones".
      resolve(err ? "" : String(stdout || ""));
    });
  });
}

/**
 * Sweep the local /24, then read the ARP table it populated.
 *
 * The order matters: ARP only holds hosts the machine has recently spoken to,
 * so reading it cold returns the router and little else. The sweep is what
 * makes the table complete.
 */
export async function scanLan(options: { subnet?: string } = {}): Promise<ScanResult> {
  const subnets = localScannableSubnets();
  const subnet = options.subnet || subnets[0] || null;

  if (!subnet) {
    return {
      subnet: null,
      hostsSeen: 0,
      hosts: [],
      outcome: "failed",
      // Said in plain words, because this reaches a screen a person reads.
      note: "This computer is not on a normal office network, so there was nothing to scan.",
    };
  }

  const addresses = hostsInSubnet(subnet);
  if (addresses.length === 0) {
    return { subnet, hostsSeen: 0, hosts: [], outcome: "failed", note: "That network address could not be read." };
  }

  const responsive = new Set<string>();
  await inBatches(addresses, CONCURRENCY, async (ip) => {
    for (const port of PHONE_PORTS) {
      if (await probe(ip, port)) {
        responsive.add(ip);
        return;
      }
    }
  });

  const arpOutput = await runArp();
  if (!arpOutput) {
    return {
      subnet,
      hostsSeen: responsive.size,
      hosts: [],
      outcome: "failed",
      note: "Windows would not report the network address table, so no phones could be identified.",
    };
  }

  const table = parseArpTable(arpOutput);
  const base = subnet.replace(/\.0\/24$/, "");
  const hosts = table
    .filter((h) => h.ip.startsWith(`${base}.`))
    .map((h) => ({ ...h, respondedOnHttp: responsive.has(h.ip) }));

  return {
    subnet,
    hostsSeen: hosts.length,
    hosts,
    outcome: "ok",
    note: subnets.length > 1
      ? `This computer is on ${subnets.length} networks; only ${subnet} was scanned.`
      : undefined,
  };
}
