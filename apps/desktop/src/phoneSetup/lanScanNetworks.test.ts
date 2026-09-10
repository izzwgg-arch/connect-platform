/**
 * The scanner looks at every network this computer is on.
 *
 * ⛔⛔ WHY THIS EXISTS. `scanLan` took `localScannableSubnets()[0]` and swept that
 * one, then attached a note reading "This computer is on N networks; only X was
 * scanned." It described its own defect instead of fixing it. A computer with a
 * cable and Wi-Fi, or one behind a mesh extender that hands out a second range,
 * swept one network and silently missed the other — which reaches a customer as
 * "the phones are definitely here and it cannot find them".
 *
 * ⛔ And the filtering matters as much as the looping: Hyper-V, WSL and Docker
 * Desktop all sit in 172.16–172.31, which IS RFC1918, so the old private-address
 * test admitted them. On a developer's machine that is four fake networks, each a
 * thousand wasted probes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  localScannableNetworks,
  localScannableSubnets,
  scanLan,
  type ScannableNetwork,
} from "./lanScan";

type Ifaces = Parameters<typeof localScannableNetworks>[0];

/** Shaped exactly like os.networkInterfaces() on Windows. */
function ifaces(entries: Record<string, { address: string; netmask: string; internal?: boolean }[]>): Ifaces {
  const out: Record<string, any[]> = {};
  for (const [name, addrs] of Object.entries(entries)) {
    out[name] = addrs.map((a) => ({
      address: a.address, netmask: a.netmask, family: "IPv4",
      internal: a.internal ?? false, mac: "00:00:00:00:00:00", cidr: null,
    }));
  }
  return out as Ifaces;
}

const REAL_WORKSTATION = ifaces({
  // Izzy's own machine: a /22 from the mesh router, plus the virtual adapters that
  // Docker Desktop, WSL and Hyper-V install. Every one of the virtual ones is inside
  // RFC1918 and would have passed the old test.
  "Wi-Fi": [{ address: "192.168.6.24", netmask: "255.255.252.0" }],
  "Ethernet": [{ address: "10.0.14.7", netmask: "255.255.255.0" }],
  "vEthernet (WSL)": [{ address: "172.20.16.1", netmask: "255.255.240.0" }],
  "vEthernet (Default Switch)": [{ address: "172.28.0.1", netmask: "255.255.255.0" }],
  "Tailscale": [{ address: "100.92.168.53", netmask: "255.255.255.0" }],
  "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
});

test("both real networks are returned, and every virtual one is dropped", () => {
  const nets = localScannableNetworks(REAL_WORKSTATION);
  const cidrs = nets.map((n) => n.cidr);

  assert.deepEqual(cidrs, ["10.0.14.0/24", "192.168.4.0/22"]);
  // The Hyper-V switch is the one that gets through a private-address-only test.
  assert.ok(!cidrs.some((c) => c.startsWith("172.")), "no virtual adapter may be swept");
  assert.ok(!cidrs.some((c) => c.startsWith("100.")), "Tailscale is not an office network");
});

test("the smallest network is swept first", () => {
  const nets = localScannableNetworks(REAL_WORKSTATION);
  // A /24 finishes in seconds; a /22 is four times the work. Doing the small one
  // first means a customer sees results fast, and a big network can never delay a
  // small one that had the phones on it.
  assert.equal(nets[0].cidr, "10.0.14.0/24");
  assert.equal(nets[0].size, 254);
  assert.equal(nets[1].size, 1022);
});

test("the adapter name is carried, because a person reads it", () => {
  const nets = localScannableNetworks(REAL_WORKSTATION);
  assert.equal(nets.find((n) => n.cidr === "192.168.4.0/22")!.iface, "Wi-Fi");
  assert.equal(nets.find((n) => n.cidr === "10.0.14.0/24")!.iface, "Ethernet");
});

test("a phone on the far side of a /22 is inside the swept range", () => {
  // Izzy's HT812 is on 192.168.4.22 while the computer is on 192.168.6.24. Those
  // look like different networks and are the same /22 — which is exactly why the
  // /22 support exists.
  const nets = localScannableNetworks(REAL_WORKSTATION);
  assert.ok(nets.some((n) => n.cidr === "192.168.4.0/22"));
});

test("the string form still answers, for callers that have always used it", () => {
  assert.deepEqual(localScannableSubnets(REAL_WORKSTATION), ["10.0.14.0/24", "192.168.4.0/22"]);
});

test("a machine on no ordinary network says so in plain words", async () => {
  const res = await scanLan({ networks: [] });
  assert.equal(res.outcome, "failed");
  assert.equal(res.subnet, null);
  assert.deepEqual(res.subnets, []);
  assert.match(res.note!, /not on a normal office network/);
});

// ── the loop itself ────────────────────────────────────────────────────────────

const NETS: ScannableNetwork[] = [
  { cidr: "10.0.14.0/24", iface: "Ethernet", localAddress: "10.0.14.7", size: 254 },
  { cidr: "192.168.4.0/22", iface: "Wi-Fi", localAddress: "192.168.6.24", size: 1022 },
];

/** A sweep that reports one device per network, named after the network. */
function fakeSweep(perNetwork: Record<string, string[]>) {
  const seen: string[] = [];
  const sweep = async (subnet: string) => {
    seen.push(subnet);
    return {
      hosts: (perNetwork[subnet] ?? []).map((mac) => ({
        ip: "0.0.0.0", mac, respondedOnHttp: true, respondedOnSip: false, fingerprint: null,
      })),
      tableRead: true,
    };
  };
  return { sweep, seen };
}

test("EVERY network is swept, and the devices are merged", async () => {
  const { sweep, seen } = fakeSweep({
    "10.0.14.0/24": ["aaaaaaaaaaaa"],
    "192.168.4.0/22": ["bbbbbbbbbbbb", "cccccccccccc"],
  });

  const res = await scanLan({ networks: NETS, sweep });

  assert.deepEqual(seen, ["10.0.14.0/24", "192.168.4.0/22"], "both, smallest first");
  assert.equal(res.hosts.length, 3, "devices from both networks reach the caller");
  assert.equal(res.outcome, "ok");
  assert.equal(res.subnets.length, 2);
  assert.equal(res.subnets[1].hostsSeen, 2);
  assert.equal(res.note, undefined, "nothing to apologise for when everything was swept");
});

test("the same phone seen on two networks is reported once", async () => {
  // A dual-homed computer can see one device from both sides. The MAC is the
  // identity — a duplicate row would show the customer a phone that is not there.
  const { sweep } = fakeSweep({
    "10.0.14.0/24": ["aaaaaaaaaaaa"],
    "192.168.4.0/22": ["aaaaaaaaaaaa"],
  });
  const res = await scanLan({ networks: NETS, sweep });
  assert.equal(res.hosts.length, 1);
});

test("an explicit subnet still sweeps exactly that one", async () => {
  const { sweep, seen } = fakeSweep({ "192.168.4.0/22": ["bbbbbbbbbbbb"] });
  const res = await scanLan({ networks: NETS, subnet: "192.168.4.0/22", sweep });
  assert.deepEqual(seen, ["192.168.4.0/22"], "the wizard's 'look here' beats the enumeration");
  assert.equal(res.subnet, "192.168.4.0/22");
});

test("a network too big for the remaining budget is NAMED, never dropped silently", async () => {
  const { sweep, seen } = fakeSweep({ "10.0.14.0/24": ["aaaaaaaaaaaa"] });
  // Room for the /24 and nowhere near enough for the /22.
  const res = await scanLan({ networks: NETS, sweep, maxAddresses: 300 });

  assert.deepEqual(seen, ["10.0.14.0/24"]);
  assert.equal(res.outcome, "partial", "partial is not ok — the customer is owed the difference");
  assert.match(res.note!, /192\.168\.4\.0\/22/, "the network we did not look at is named");
  assert.equal(res.hosts.length, 1, "what we did find still comes back");
});

test("`subnet` stays the first network swept, for the callers that store it", async () => {
  // The portal writes this onto the run and the API has always been handed one
  // string. Widening the result must not change what that field means.
  const { sweep } = fakeSweep({ "10.0.14.0/24": [], "192.168.4.0/22": ["bbbbbbbbbbbb"] });
  const res = await scanLan({ networks: NETS, sweep });
  assert.equal(typeof res.subnet, "string");
  assert.equal(res.subnet, "10.0.14.0/24");
});

test("Windows refusing the address table is not the same as an empty office", async () => {
  const sweep = async () => ({ hosts: [], tableRead: false });
  const res = await scanLan({ networks: NETS, sweep });
  assert.equal(res.outcome, "failed");
  assert.match(res.note!, /would not report the network address table/);
});

test("every network swept is written to the log", async () => {
  const lines: string[] = [];
  const { sweep } = fakeSweep({ "10.0.14.0/24": ["aaaaaaaaaaaa"], "192.168.4.0/22": [] });
  await scanLan({ networks: NETS, sweep, log: (l) => lines.push(l) });

  assert.equal(lines.length, 2);
  assert.match(lines[0], /10\.0\.14\.0\/24 \(Ethernet\) 254 addresses -> 1 devices/);
  assert.match(lines[1], /192\.168\.4\.0\/22 \(Wi-Fi\)/);
});
