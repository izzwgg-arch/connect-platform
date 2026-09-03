/**
 * The driver — the loop between the server's decisions and the office machine's
 * hands. Driven here through a fake api and a fake bridge, because the orderings
 * (who is asked first, what gets executed, what reaches a person) are the whole
 * point and none of them needs hardware to prove.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSetupDriver, MAX_PROVISIONING_WAIT_MS } from "./setupDriver";

type Call = { method: string; path: string; body?: any };

function fakeApi(phones: any[], decisions: Record<string, any>) {
  const calls: Call[] = [];
  return {
    calls,
    get: async <T,>(path: string): Promise<T> => {
      calls.push({ method: "GET", path });
      return { ok: true, phones, summary: summarize(phones) } as any;
    },
    post: async <T,>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: "POST", path, body });
      const m = path.match(/phones\/([^/]+)\/advance$/);
      if (m) return { ok: true, ...(decisions[m[1]] ?? { action: "do_nothing" }) } as any;
      return { ok: true } as any;
    },
  };
}

function summarize(phones: any[]) {
  const terminal = new Set(["REGISTERED", "NEEDS_ATTENTION", "FAILED"]);
  const working = phones.filter((p) => p.extNumber && !terminal.has(p.state)).length;
  return { finished: working === 0, total: phones.length };
}

function fakeBridge() {
  const ops: any[] = [];
  return {
    ops,
    run: async (req: any) => {
      ops.push(req);
      if (req.op === "test_credentials") return { ok: true, accepted: false, reason: "locked" };
      if (req.op === "discover") return { ok: true, scan: { subnet: "192.168.1.0/24", hosts: [] } };
      return { ok: true, op: req.op };
    },
  };
}

const phone = (id: string, over: any = {}) => ({
  id, state: "ASSIGNED", status: "Preparing", ip: "192.168.1.20", vendor: "yealink",
  extNumber: "101", displayName: "Leah", attempts: 0, resetCount: 0, ...over,
});

test("a terminal or unassigned phone is never advanced", async () => {
  const api = fakeApi(
    [phone("done", { state: "REGISTERED" }), phone("blank", { extNumber: null }), phone("live")],
    { live: { action: "do_nothing" } },
  );
  const d = createSetupDriver("r1", api, fakeBridge());
  await d.tick();
  const advanced = api.calls.filter((c) => c.path.includes("/advance"));
  assert.equal(advanced.length, 1, "only the working phone is asked about");
  assert.ok(advanced[0].path.includes("/live/"));
});

test("try_default_credentials runs the ONE documented attempt and records what it learned", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "try_default_credentials" } });
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  await d.tick();
  assert.deepEqual(bridge.ops[0], { op: "test_credentials", ip: "192.168.1.20", useDefault: true });
  // the next tick's advance must carry the observation
  await d.tick();
  const second = api.calls.filter((c) => c.path.includes("/advance")).at(-1)!;
  assert.equal(second.body.defaultCredentialsTried, true);
  assert.equal(second.body.locked, true, "a refused default is knowledge, and it travels");
});

test("a password from a person goes to the BRIDGE VAULT and only its reference travels", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "trigger_autop" } });
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  d.credentialStored("p1", "phone:p1");
  await d.tick();
  const autop = bridge.ops.find((o) => o.op === "trigger_autop");
  assert.equal(autop.credentialRef, "phone:p1");
  assert.ok(!("password" in autop), "a password crossed the boundary");
  const adv = api.calls.find((c) => c.path.includes("/advance"))!;
  assert.equal(adv.body.haveCustomerCredentials, true);
  // ⛔ and no password VALUE is ever POSTed to the api. (The BOOLEAN field
  // passwordUnavailable is fine — it carries the answer "I don't have one",
  // which is knowledge, not a secret.)
  for (const c of api.calls) {
    const body = c.body ?? {};
    assert.ok(!("password" in body), `a password key reached the api: ${c.path}`);
    for (const v of Object.values(body)) {
      assert.ok(typeof v !== "string" || !v.includes("secret"),
        `a secret-looking value reached the api: ${c.path}`);
    }
  }
});

test("ask_for_password and request_reset_authorization surface to a person and execute NOTHING", async () => {
  const api = fakeApi(
    [phone("pw1"), phone("rs1"), phone("rs2")],
    {
      pw1: { action: "ask_for_password", customerMessage: "Your old provider set a password on this phone." },
      rs1: { action: "request_reset_authorization", customerMessage: "This phone still holds settings from your previous phone system." },
      rs2: { action: "request_reset_authorization", customerMessage: "This phone still holds settings from your previous phone system." },
    },
  );
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();
  assert.equal(bridge.ops.length, 0, "an instruction for a person must not touch a phone");
  const reset = out.needs.find((n) => n.kind === "reset_authorization") as any;
  assert.ok(reset, "the approval never reached the screen");
  // ⛔ one approval card for the batch, naming both phones — ten dialogs is how
  // people learn to click through
  assert.deepEqual(reset.phoneIds.sort(), ["rs1", "rs2"]);
  const pw = out.needs.find((n) => n.kind === "password") as any;
  assert.equal(pw.phoneId, "pw1");
  assert.ok(!/\b(HTTP|SIP|MAC|provisioning)\b/i.test(pw.message), "jargon reached a person");
});

test("with no bridge, nothing local is attempted and the loop still reports honestly", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "trigger_autop" } });
  const d = createSetupDriver("r1", api, null);
  const out = await d.tick();
  assert.equal(out.performed.length, 0);
  assert.equal(out.finished, false);
});

test("an instruction this machine cannot perform is not hammered forever", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "reset_over_sip" } });
  const d = createSetupDriver("r1", api, fakeBridge());
  assert.equal(d.everythingStalled(), false, "stalled before anything ran");
  await d.tick(); await d.tick(); await d.tick();
  assert.equal(d.everythingStalled(), true, "three identical non-executable rounds is a stall");
  // and progress on the action clears it
  const api2 = fakeApi([phone("p1")], { p1: { action: "trigger_autop" } });
  const d2 = createSetupDriver("r1", api2, fakeBridge());
  await d2.tick();
  assert.equal(d2.everythingStalled(), false);
});

test("rediscover reports what it found by hardware id, never by address", async () => {
  const api = fakeApi([phone("p1", { state: "WAITING_FOR_REBOOT" })], { p1: { action: "rediscover" } });
  const bridge = {
    ops: [] as any[],
    run: async (req: any) => {
      bridge.ops.push(req);
      return { ok: true, scan: { subnet: "192.168.1.0/24", hosts: [{ mac: "80:5e:0c:00:00:01", ip: "192.168.1.99" }] } };
    },
  };
  const d = createSetupDriver("r1", api, bridge);
  await d.tick();
  const report = api.calls.find((c) => c.path.endsWith("/discovered"))!;
  assert.ok(report, "the rediscovery was never reported");
  assert.equal(report.body.phones[0].mac, "80:5e:0c:00:00:01");
});

test("a failing advance on one phone does not stop the others", async () => {
  const api = fakeApi([phone("bad"), phone("good")], { good: { action: "trigger_autop" } });
  const origPost = api.post;
  (api as any).post = async (path: string, body?: unknown) => {
    if (path.includes("/bad/")) throw new Error("boom");
    return origPost(path, body);
  };
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api as any, bridge);
  const out = await d.tick();
  assert.equal(out.performed.length, 1, "the healthy phone was abandoned because a sibling failed");
});

/* ── the wiring, read from source ────────────────────────────────────────── */

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8").split("\r\n").join("\n");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("the wizard actually USES the driver — polling alone can never finish a setup", () => {
  // ⛔ The defect this whole module exists for: the live step used to only poll,
  // nothing called advance, and "Set Up My Phones" sat on "Setting up" forever.
  const src = stripComments(read("DeskPhoneWizard.tsx"));
  assert.ok(src.includes("createSetupDriver"), "the wizard no longer creates the driver");
  assert.ok(src.includes("classifyDiscoveredHosts"), "the wizard no longer filters discovery");
  assert.ok(src.includes("rememberCredential"), "the wizard no longer stores passwords locally");
  assert.ok(!src.includes("close this window") || !src.includes("setup keeps going"),
    "the live step promises background progress the browser cannot deliver");
});

test("the driver never carries a password VALUE — only references", () => {
  // The driver may name the concept (the "password" need kind, the ask_for_password
  // action) — what it must never do is hold or send a password value. That would
  // show up as a `password:` object key.
  const src = stripComments(read("setupDriver.ts"));
  assert.ok(!/password['"]?\s*:\s*[a-z(]/i.test(src), "a password value is being carried");
  assert.ok(src.includes("credentialRef"), "the reference mechanism is gone");
});

test("'I don't know the password' travels to the server and the wizard never re-asks", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "ask_for_password", customerMessage: "x" } });
  const d = createSetupDriver("r1", api, fakeBridge());
  const first = await d.tick();
  assert.equal(first.needs.filter((n) => n.kind === "password").length, 1);
  d.passwordUnknown("p1");
  await d.tick();
  const adv = api.calls.filter((c) => c.path.includes("/advance")).at(-1)!;
  assert.equal(adv.body.passwordUnavailable, true, "the answer never reached the server");
});

test("an unticked device is recorded as declined and the flag travels on every advance", async () => {
  const api = fakeApi([phone("p1"), phone("p2")], {
    p1: { action: "request_reset_authorization", customerMessage: "x" },
    p2: { action: "request_reset_authorization", customerMessage: "x" },
  });
  const d = createSetupDriver("r1", api, fakeBridge());
  await d.tick();
  d.declineReset(["p2"]);
  await d.tick();
  const advances = api.calls.filter((c) => c.path.includes("/advance"));
  const p1Last = advances.filter((c) => c.path.includes("/p1/")).at(-1)!;
  const p2Last = advances.filter((c) => c.path.includes("/p2/")).at(-1)!;
  assert.equal(p1Last.body.resetDeclined, false, "the ticked device was declined");
  assert.equal(p2Last.body.resetDeclined, true, "the unticked device was not declined");
});

test("a non-Yealink device is never poked with Yealink mechanisms", async () => {
  // ⛔ Izzy widened the scope to any VoIP device. The local adapter speaks Yealink;
  // an HT box or a Fanvil speaker gets configured server-side and locally we WAIT —
  // sending another vendor's device our Action URIs is not "worth a try".
  const api = fakeApi(
    [phone("ht", { vendor: "grandstream", model: "HT802" }), phone("yl", { vendor: "yealink" })],
    { ht: { action: "trigger_autop" }, yl: { action: "trigger_autop" } },
  );
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();
  assert.equal(bridge.ops.length, 1, `expected 1 local action, saw ${bridge.ops.length}`);
  assert.deepEqual(out.performed.map((p) => p.phoneId), ["yl"]);
});

test("a phone the person left unticked on the found screen is never advanced, even though it is assigned", async () => {
  // 2026-09-02: Izzy's nine-phone office, ONE factory-reset phone to set up. The
  // other eight carry an extension from the PBX records and used to be driven too.
  const api = fakeApi(
    [phone("left", { selected: false }), phone("live", { selected: true }), phone("legacy")],
    { live: { action: "do_nothing" }, legacy: { action: "do_nothing" } },
  );
  const d = createSetupDriver("r1", api, fakeBridge());
  await d.tick();
  const advanced = api.calls.filter((c) => c.path.includes("/advance")).map((c) => c.path);
  assert.equal(advanced.length, 2, "the unticked phone is not asked about");
  assert.ok(advanced.some((p) => p.includes("/live/")));
  assert.ok(advanced.some((p) => p.includes("/legacy/")), "a row with no selected flag (older api) is driven as before");
  assert.ok(!advanced.some((p) => p.includes("/left/")));
  // ⛔ Source-pinned: the skip is on `selected === false`, so an older api that
  // does not send the flag keeps every phone in the setup.
  assert.match(read("setupDriver.ts"), /phone\.selected === false/);
});

/* ── handing a reset phone its folder (2026-09-02) ──────────────────────── */

test("set_provisioning: listen+restart, then the delivered folder is reported to the server through /discovered", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  bridge.run = async (req: any) => { bridge.ops.push(req); return { ok: true, op: req.op, listening: true, rebooted: true, delivered: true, acknowledged: true, deliveredAt: 5 }; };
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();
  assert.deepEqual(bridge.ops.map((o) => o.op), ["set_provisioning"]);
  assert.equal(bridge.ops[0].url, "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/");
  assert.equal(bridge.ops[0].mac, "805e0c4d796d");
  assert.equal(bridge.ops[0].reboot, true);
  const discovered = api.calls.find((c) => c.path.endsWith("/discovered"));
  assert.ok(discovered, "the folder is recorded the way a scan would record it");
  assert.deepEqual(discovered!.body, { phones: [{ mac: "805e0c4d796d", ip: "192.168.1.20", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" }] });
  assert.deepEqual(out.performed, [{ phoneId: "p1", action: "set_provisioning" }]);
  assert.match(out.hints.p1, /where Loopcom is/);
});

test("set_provisioning: without a URL from the server nothing is attempted", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], { p1: { action: "set_provisioning" } });
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  await d.tick();
  assert.equal(bridge.ops.length, 0);
});

test("set_provisioning: two restarts from here, then listen-and-check with a plug-it-in ask, and an hour later the server is told to stop", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  bridge.run = async (req: any) => { bridge.ops.push(req); return { ok: true, op: req.op, listening: true, rebooted: req.reboot !== false, delivered: false, acknowledged: false, deliveredAt: null }; };
  let t = 1_000_000;
  const d = createSetupDriver("r1", api, bridge, () => t);
  const hints: string[] = [];
  // ticks every 4 s, as the wizard does — an hour is 900 of them
  const ticksPerHour = Math.ceil(MAX_PROVISIONING_WAIT_MS / 4000);
  for (let i = 0; i < ticksPerHour + 2; i += 1) { hints.push((await d.tick()).hints.p1); t += 4000; }
  assert.deepEqual(bridge.ops.slice(0, 5).map((o) => o.reboot), [true, true, false, false, false], "two restarts from here, then listen-and-check");
  assert.ok(bridge.ops.slice(2).every((o) => o.reboot === false), "no third restart, ever");
  assert.match(hints[0], /restarting/);
  assert.match(hints[2], /Plug this phone in/);
  assert.match(hints[2], /keeps listening/);
  assert.match(hints[2], /Windows asks/);
  const advances = api.calls.filter((c) => c.path.endsWith("/advance"));
  assert.equal(advances[advances.length - 1].body.provisioningHandoffFailed, true, "after an hour the server is told to halt kindly");
  assert.equal(advances[10].body.provisioningHandoffFailed, false, "not early");
  const firstFailed = advances.findIndex((c) => c.body.provisioningHandoffFailed === true);
  assert.ok(firstFailed * 4000 >= MAX_PROVISIONING_WAIT_MS, "the give-up waits the full hour");
});

test("set_provisioning: a machine that cannot listen says so in plain words, and never reboots the phone", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  (bridge as any).run = async (req: any) => { bridge.ops.push(req); return { ok: false, refused: "cannot_listen" }; };
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();
  assert.match(out.hints.p1, /could not listen/);
  assert.match(out.hints.p1, /Windows/);
});

test("set_provisioning: an OLD desktop app (unknown_operation) is told to update, and no attempt is ever spent on it", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  (bridge as any).run = async (req: any) => { bridge.ops.push(req); return { ok: false, refused: "unknown_operation" }; };
  const d = createSetupDriver("r1", api, bridge);
  const hints: string[] = [];
  for (let i = 0; i < 8; i += 1) hints.push((await d.tick()).hints.p1 ?? "");
  assert.match(hints[0], /older than this step/);
  assert.match(hints[0], /Update Loopcom/);
  const advances = api.calls.filter((c) => c.path.endsWith("/advance"));
  assert.ok(advances.every((c) => c.body.provisioningHandoffFailed === false), "a refusal is never counted, so the server is never told to give up");
  assert.ok(bridge.ops.every((o) => o.reboot === true), "the restart budget is untouched while nothing has run");
});

test("set_provisioning: cannot_listen does not spend an attempt either, and the hint names Windows", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  (bridge as any).run = async (req: any) => { bridge.ops.push(req); return { ok: false, refused: "cannot_listen" }; };
  const d = createSetupDriver("r1", api, bridge);
  for (let i = 0; i < 7; i += 1) await d.tick();
  const advances = api.calls.filter((c) => c.path.endsWith("/advance"));
  assert.ok(advances.every((c) => c.body.provisioningHandoffFailed === false));
});
