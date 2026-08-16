import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hostsInSubnet,
  isPrivateIpv4,
  localScannableSubnets,
  parseArpTable,
} from "./lanScan";

/**
 * The parsing half of the LAN scan. A parser that silently returns nothing is
 * indistinguishable from an office with no phones, which is exactly the kind of
 * confidently-wrong empty result this codebase keeps getting bitten by.
 */

/** Real Windows `arp -a` output, including the rows that must be ignored. */
const ARP_OUTPUT = `
Interface: 192.168.1.10 --- 0x5
  Internet Address      Physical Address      Type
  192.168.1.1           aa-bb-cc-dd-ee-ff     dynamic
  192.168.1.20          80-5e-0c-4d-7e-6b     dynamic
  192.168.1.21          00-04-f2-11-22-33     dynamic
  192.168.1.255         ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
  239.255.255.250       01-00-5e-7f-ff-fa     static
`;

test("the phones are found in a real ARP table", () => {
  const hosts = parseArpTable(ARP_OUTPUT);
  const macs = hosts.map((h) => h.mac);
  assert.ok(macs.includes("805e0c4d7e6b"), "the Yealink should be found");
  assert.ok(macs.includes("0004f21122 33".replace(/\s/g, "")), "the Polycom should be found");
  assert.ok(macs.includes("aabbccddeeff"), "the router should be found");
});

test("⛔ broadcast and multicast rows are NOT reported as devices", () => {
  const hosts = parseArpTable(ARP_OUTPUT);
  const macs = hosts.map((h) => h.mac);
  const ips = hosts.map((h) => h.ip);

  assert.ok(!macs.includes("ffffffffffff"), "broadcast must not appear");
  assert.ok(!ips.includes("192.168.1.255"), "the broadcast address must not appear");
  assert.ok(!ips.includes("224.0.0.22"), "multicast must not appear");
  assert.ok(!ips.includes("239.255.255.250"), "SSDP multicast must not appear");
  assert.ok(!macs.some((m) => m.startsWith("01005e")), "no multicast MACs");
  // Exactly the three real hosts.
  assert.equal(hosts.length, 3);
});

test("MACs are normalised to bare lowercase hex", () => {
  const hosts = parseArpTable("  192.168.1.20   80-5E-0C-4D-7E-6B   dynamic");
  assert.equal(hosts[0].mac, "805e0c4d7e6b");
});

test("both dash and colon MAC spellings parse", () => {
  assert.equal(parseArpTable("10.0.0.5  80:5e:0c:4d:7e:6b  dynamic")[0]?.mac, "805e0c4d7e6b");
  assert.equal(parseArpTable("10.0.0.5  80-5e-0c-4d-7e-6b  dynamic")[0]?.mac, "805e0c4d7e6b");
});

test("a duplicate MAC on two addresses is reported once", () => {
  const hosts = parseArpTable(`
  192.168.1.20   80-5e-0c-4d-7e-6b   dynamic
  192.168.1.99   80-5e-0c-4d-7e-6b   dynamic
`);
  assert.equal(hosts.length, 1);
});

test("noise, headers and empty input produce nothing rather than throwing", () => {
  assert.deepEqual(parseArpTable(""), []);
  assert.deepEqual(parseArpTable("Interface: 192.168.1.10 --- 0x5"), []);
  assert.deepEqual(parseArpTable("  Internet Address      Physical Address      Type"), []);
  assert.deepEqual(parseArpTable(null as any), []);
  assert.deepEqual(parseArpTable("total garbage that is not a table"), []);
});

test("⛔ only private ranges are ever scanned", () => {
  // Probing a public range from a customer's machine is a port scan of somebody
  // else's network, from their IP address.
  assert.equal(isPrivateIpv4("192.168.1.5"), true);
  assert.equal(isPrivateIpv4("10.4.4.4"), true);
  assert.equal(isPrivateIpv4("172.16.0.1"), true);
  assert.equal(isPrivateIpv4("172.31.255.254"), true);

  assert.equal(isPrivateIpv4("172.15.0.1"), false, "just below the private 172 block");
  assert.equal(isPrivateIpv4("172.32.0.1"), false, "just above the private 172 block");
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("45.14.194.179"), false, "our own server is not a LAN");
  assert.equal(isPrivateIpv4("not-an-ip"), false);
  assert.equal(isPrivateIpv4("999.1.1.1"), false);
});

test("a /24 enumerates 254 usable hosts, without network or broadcast", () => {
  const hosts = hostsInSubnet("192.168.1.0/24");
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], "192.168.1.1");
  assert.equal(hosts[253], "192.168.1.254");
  assert.ok(!hosts.includes("192.168.1.0"));
  assert.ok(!hosts.includes("192.168.1.255"));
});

test("anything that is not a /24 enumerates nothing", () => {
  // Deliberate: a /16 is 65,000 probes, which is both slow and looks exactly
  // like an attack to whatever monitoring the customer runs.
  assert.deepEqual(hostsInSubnet("192.168.0.0/16"), []);
  assert.deepEqual(hostsInSubnet("192.168.1.0/25"), []);
  assert.deepEqual(hostsInSubnet("garbage"), []);
});

test("only private, non-internal /24 interfaces are offered for scanning", () => {
  const fake = {
    Ethernet: [
      { family: "IPv4", internal: false, netmask: "255.255.255.0", address: "192.168.44.10" },
    ],
    Loopback: [
      { family: "IPv4", internal: true, netmask: "255.0.0.0", address: "127.0.0.1" },
    ],
    Corporate: [
      // A /16 — too big to sweep.
      { family: "IPv4", internal: false, netmask: "255.255.0.0", address: "10.1.2.3" },
    ],
    Public: [
      { family: "IPv4", internal: false, netmask: "255.255.255.0", address: "45.14.194.179" },
    ],
    Tunnel: [
      { family: "IPv6", internal: false, netmask: "ffff::", address: "fe80::1" },
    ],
  } as any;

  const subnets = localScannableSubnets(fake);
  assert.deepEqual(subnets, ["192.168.44.0/24"]);
});

test("two interfaces on the same subnet are not offered twice", () => {
  const fake = {
    Wifi: [{ family: "IPv4", internal: false, netmask: "255.255.255.0", address: "192.168.1.10" }],
    Ethernet: [{ family: "IPv4", internal: false, netmask: "255.255.255.0", address: "192.168.1.11" }],
  } as any;
  assert.deepEqual(localScannableSubnets(fake), ["192.168.1.0/24"]);
});

test("a machine on no ordinary network offers nothing to scan", () => {
  assert.deepEqual(localScannableSubnets({} as any), []);
});
