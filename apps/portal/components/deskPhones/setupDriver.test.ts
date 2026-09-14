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
import {
  createSetupDriver, MAX_CANNOT_LISTEN_ATTEMPTS, classifyResetAnswer,
  HINT_RESET_SENT, HINT_RESET_SKIPPED, HINT_APP_TOO_OLD,
  HINT_CLEARING, HINT_CONNECTED,
  HINT_RESTARTING, HINT_NEEDS_SERIAL, HINT_CANNOT_LISTEN,
  CLOUD_ASK_INTERVAL_MS, CLOUD_RESTART_WAIT_MS, PROVISIONING_REBOOT_ATTEMPTS,
} from "./setupDriver";

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
  assert.deepEqual(bridge.ops[0], { op: "test_credentials", ip: "192.168.1.20", useDefault: true, vendor: "yealink" });
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

test("a brand with no HTTP executor is never poked with another vendor's mechanisms", async () => {
  // ⛔ The local adapters speak Yealink and Grandstream; a Poly or a Fanvil gets configured
  // server-side and locally we WAIT — sending another vendor's requests is not "worth a try".
  const api = fakeApi(
    [phone("poly", { vendor: "polycom", model: "VVX411" }), phone("yl", { vendor: "yealink" })],
    { poly: { action: "trigger_autop" }, yl: { action: "trigger_autop" } },
  );
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();
  assert.equal(bridge.ops.length, 1, `expected 1 local action, saw ${bridge.ops.length}`);
  assert.deepEqual(out.performed.map((p) => p.phoneId), ["yl"]);
});

test("...but a non-Yealink phone IS listened for — that is the whole difference", async () => {
  // ⛔⛔ THE DEFECT THIS PINS, AND IT IS THE ONE IZZY REPORTED: one gate answered
  // two different questions, so every brand except Yealink was refused even the
  // PASSIVE step and sat on "Preparing" until somebody gave up.
  //
  //   SPEAKING to a phone — an HTTP request aimed AT it — is vendor-specific, and
  //   pointing Yealink shapes at a Grandstream configures nothing while looking
  //   like it worked. That stays Yealink's alone (the test above).
  //
  //   LISTENING for a phone that asks US is plain RFC 6080 SIP, and it is the SAME
  //   request on every brand that sends it: ten of them, covering 369 of the PBX's
  //   427 models. There is nothing vendor-specific to get wrong, and a factory-reset
  //   phone multicasts it once per boot whatever badge is on the front.
  const api = fakeApi(
    [phone("poly", { vendor: "polycom", model: "VVX411", mac: "0004f2aabbcc" })],
    { poly: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" } },
  );
  const bridge = fakeBridge();
  bridge.run = async (req: any) => { bridge.ops.push(req); return { ok: true, op: req.op, listening: true, rebooted: false, delivered: false }; };
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();

  assert.equal(bridge.ops.length, 1, "the responder is armed for it");
  assert.equal(bridge.ops[0].op, "set_provisioning");
  // ⛔ And armed WITHOUT a restart: we hold no Poly HTTP shapes, so the person is asked to
  // power-cycle instead — the documented mechanism for a factory-reset phone anyway, since one
  // on defaults asks at the handset before obeying a remote restart.
  assert.equal(bridge.ops[0].reboot, false, "no restart is sent at a brand whose HTTP shapes we do not hold");
  assert.match(out.hints.poly, /Plug this phone in/);
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

test("set_provisioning: two restarts from here, then listen-and-check FOREVER — a listening machine never gives up", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  bridge.run = async (req: any) => { bridge.ops.push(req); return { ok: true, op: req.op, listening: true, rebooted: req.reboot !== false, delivered: false, acknowledged: false, deliveredAt: null }; };
  let t = 1_000_000;
  const d = createSetupDriver("r1", api, bridge, () => t);
  const hints: string[] = [];
  // Four hours of the wizard's 4-second tick. The OLD driver gave up after one.
  for (let i = 0; i < 3_600; i += 1) { hints.push((await d.tick()).hints.p1); t += 4000; }
  assert.deepEqual(bridge.ops.slice(0, 5).map((o) => o.reboot), [true, true, false, false, false], "two restarts from here, then listen-and-check");
  assert.ok(bridge.ops.slice(2).every((o) => o.reboot === false), "no third restart, ever");
  assert.match(hints[0], /restarting/);
  assert.match(hints[2], /Plug this phone in/);
  assert.match(hints[2], /keeps listening/);
  assert.match(hints[2], /Windows asks/);

  // ⛔⛔ THE POINT OF THIS TEST NOW: the server is NEVER told to give up while this
  // machine is listening. It used to be told after an hour, and the customer was
  // shown "We could not point this phone at Loopcom from your computer — Support can
  // finish this one." That was FALSE: the desktop responder is STANDING, so the
  // phone is provisioned the moment somebody power-cycles it, tonight or tomorrow.
  // Saying we had given up, while the machine was still listening and would still
  // finish the job, is the single most misleading thing this wizard ever said.
  const advances = api.calls.filter((c) => c.path.endsWith("/advance"));
  assert.ok(advances.length > 3_000, "sanity: the ticks really ran");
  assert.ok(
    advances.every((c) => c.body.provisioningHandoffFailed === false),
    "a listening machine must never tell the server to halt the phone, however long it waits",
  );
});

test("set_provisioning: a cannot_listen that RECOVERS resets the count — one bad reading is not a verdict", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  let n = 0;
  (bridge as any).run = async (req: any) => {
    bridge.ops.push(req);
    n += 1;
    // refuse, refuse, then the port frees up and stays free
    if (n <= 2) return { ok: false, refused: "cannot_listen" };
    return { ok: true, op: req.op, listening: true, rebooted: false, delivered: false, acknowledged: false, deliveredAt: null };
  };
  const d = createSetupDriver("r1", api, bridge);
  for (let i = 0; i < 10; i += 1) await d.tick();
  const advances = api.calls.filter((c) => c.path.endsWith("/advance"));
  assert.ok(advances.every((c) => c.body.provisioningHandoffFailed === false), "a recovered machine is never reported as having given up");
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

test("set_provisioning: cannot_listen never spends a RESTART, and the give-up needs three in a row", async () => {
  const api = fakeApi([phone("p1", { mac: "805e0c4d796d" })], {
    p1: { action: "set_provisioning", provisioningUrl: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" },
  });
  const bridge = fakeBridge();
  (bridge as any).run = async (req: any) => { bridge.ops.push(req); return { ok: false, refused: "cannot_listen" }; };
  const d = createSetupDriver("r1", api, bridge);
  const hints: string[] = [];
  for (let i = 0; i < 7; i += 1) hints.push((await d.tick()).hints.p1 ?? "");

  // ⛔ A REFUSAL IS NOT AN ATTEMPT. Nothing listened and nothing restarted, so the
  // restart budget must be exactly where it started — otherwise a machine that never
  // managed to try once would burn through its two restarts on error messages.
  assert.ok(bridge.ops.every((o) => o.reboot === true), "the restart budget is untouched while nothing has run");
  // ⛔ And once we HAVE given up, the phone is left alone entirely: no further op is
  // sent, so a wedged port cannot become a machine poking a handset every four seconds.
  assert.equal(bridge.ops.length, MAX_CANNOT_LISTEN_ATTEMPTS, "we stop asking the moment we admit we cannot listen");

  // The person is told what to do on EVERY tick they might be looking at, not only
  // the first — a hint that names Windows once and then goes quiet is a dead end.
  for (const h of hints.slice(0, MAX_CANNOT_LISTEN_ATTEMPTS)) assert.match(h, /Windows/);

  // ⛔⛔ THIS IS THE ONE PLACE THE SERVER IS EVER TOLD TO STOP, and the threshold is
  // the whole point of the assertion. The wizard used to say it had given up after an
  // hour of a perfectly healthy machine listening — a statement to a customer that was
  // simply untrue. It may only say that when nothing will EVER arrive, i.e. when the
  // socket itself cannot be opened; and not on the first reading, because a port can be
  // momentarily held by something else.
  const advances = api.calls.filter((c) => c.path.endsWith("/advance"));
  for (let i = 0; i < MAX_CANNOT_LISTEN_ATTEMPTS - 1; i += 1) {
    assert.equal(advances[i].body.provisioningHandoffFailed, false, `told the server to stop on refusal ${i + 1}`);
  }
  assert.equal(advances[advances.length - 1].body.provisioningHandoffFailed, true, "three in a row is a real verdict");
});

/* ── reset_over_lan: the one destructive step, proven with a fake bridge only ── */

const RESET_DECISION = { action: "reset_over_lan", resetAuthorizationId: "run_1.1789000000000" };

function resetBridge(answer: (req: any) => any, model = "T54W") {
  const ops: any[] = [];
  return {
    ops,
    run: async (req: any) => {
      ops.push(req);
      if (req.op === "fingerprint") return { ok: true, fingerprint: { vendor: "yealink", model, firmware: "96.86.0.1", confidence: "high" } };
      return answer(req);
    },
  };
}
const resetReports = (api: any) => api.calls.filter((c: any) => c.path.endsWith("/reset-sent"));

test("reset_over_lan: reads the model off the phone, then asks for the wipe with this run's approval", async () => {
  const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
  const bridge = resetBridge(() => ({ ok: true, op: "factory_reset", sent: true }));
  const out = await createSetupDriver("r1", api, bridge).tick();
  assert.equal(bridge.ops[0].op, "fingerprint", "the fence judges what the phone says, so ask it first");
  assert.deepEqual(bridge.ops[1], {
    op: "factory_reset", ip: "192.168.1.20", model: "T54W", link: "unknown", authorizationId: RESET_DECISION.resetAuthorizationId, vendor: "yealink",
  });
  const reports = resetReports(api);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].body, { authorizationId: RESET_DECISION.resetAuthorizationId });
  assert.equal(out.hints.p1, HINT_RESET_SENT);
});

test("reset_over_lan: no approval id on the instruction means nothing is asked of the phone", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "reset_over_lan" } });
  const bridge = resetBridge(() => ({ ok: true, sent: true }));
  await createSetupDriver("r1", api, bridge).tick();
  assert.equal(bridge.ops.length, 0);
  assert.equal(resetReports(api).length, 0);
});

test("reset_over_lan: a brand we hold no reset shape for is never wiped, and the server hears so", async () => {
  const api = fakeApi([phone("p1", { vendor: "polycom", model: "VVX411" })], { p1: RESET_DECISION });
  const bridge = resetBridge(() => ({ ok: true, sent: true }));
  const d = createSetupDriver("r1", api, bridge);
  const out = await d.tick();
  assert.equal(bridge.ops.length, 0, "no fingerprint, no wipe");
  assert.equal(out.hints.p1, HINT_RESET_SKIPPED);
  await d.tick();
  const adv = api.calls.filter((c: any) => c.path.endsWith("/advance")).at(-1)!;
  assert.equal(adv.body.resetRefusedLocally, true);
  assert.equal(resetReports(api).length, 0);
});

test("reset_over_lan: the desktop fence refusing is never reported as a reset", async () => {
  for (const refused of ["reset_unsafe:ata", "reset_unsafe:wireless_link", "not_a_private_address"]) {
    const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
    const bridge = resetBridge(() => ({ ok: false, refused }));
    const d = createSetupDriver("r1", api, bridge);
    const out = await d.tick();
    assert.equal(resetReports(api).length, 0, `${refused} was counted as a wipe`);
    assert.equal(out.hints.p1, HINT_RESET_SKIPPED);
    await d.tick();
    assert.equal(api.calls.filter((c: any) => c.path.endsWith("/advance")).at(-1)!.body.resetRefusedLocally, true);
  }
});

test("reset_over_lan: an app too old for the step says update, and spends nothing", async () => {
  const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
  const out = await createSetupDriver("r1", api, resetBridge(() => ({ ok: false, refused: "unknown_operation" }))).tick();
  assert.equal(out.hints.p1, HINT_APP_TOO_OLD);
  assert.equal(resetReports(api).length, 0);
});

test("reset_over_lan: an answer that may have reached the phone IS counted (one wipe never becomes two)", async () => {
  for (const answer of [{ ok: false, refused: "timeout" }, { ok: false, refused: "unreachable" }, { ok: false, refused: "already_reset_this_session" }]) {
    const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
    await createSetupDriver("r1", api, resetBridge(() => answer)).tick();
    assert.equal(resetReports(api).length, 1, `${answer.refused} was not reported`);
  }
});

test("reset_over_lan: nothing left the machine (not authorised, too soon, bridge threw) — no report", async () => {
  for (const run of [
    async () => ({ ok: false, refused: "reset_not_authorized" }),
    async () => ({ ok: false, refused: "too_soon_for_this_phone" }),
    async () => { throw new Error("bridge gone"); },
  ]) {
    const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
    const ops: any[] = [];
    const bridge = { ops, run: async (req: any) => { ops.push(req); return req.op === "fingerprint" ? { ok: false } : run(); } };
    await createSetupDriver("r1", api, bridge).tick();
    assert.equal(resetReports(api).length, 0);
  }
});

test("reset_over_lan: a lost report is retried, never re-wiped", async () => {
  const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
  let failures = 2;
  const post = api.post;
  (api as any).post = async (path: string, body?: unknown) => {
    if (path.endsWith("/reset-sent") && failures > 0) { failures -= 1; api.calls.push({ method: "POST", path, body }); throw new Error("net"); }
    return post(path, body);
  };
  const bridge = resetBridge(() => ({ ok: true, sent: true }));
  await createSetupDriver("r1", api, bridge).tick();
  assert.equal(bridge.ops.filter((o: any) => o.op === "factory_reset").length, 1);
  assert.equal(resetReports(api).length, 3);
});

/* ── what the person sees, live ──────────────────────────────────────────── */

test("the wipe is announced BEFORE it is asked of the phone, not after", async () => {
  const log: string[] = [];
  const api = fakeApi([phone("p1")], { p1: RESET_DECISION });
  const bridge = {
    ops: [] as any[],
    run: async (req: any) => {
      log.push(`op:${req.op}`);
      if (req.op === "fingerprint") return { ok: true, fingerprint: { vendor: "yealink", model: "T54W" } };
      return { ok: true, op: req.op, sent: true };
    },
  };
  const d = createSetupDriver("r1", api, bridge as any, undefined, (id, text) => log.push(`say:${id}:${text}`));
  await d.tick();
  const said = log.indexOf(`say:p1:${HINT_CLEARING}`);
  const wiped = log.indexOf("op:factory_reset");
  assert.ok(said >= 0, "the clearing step was never shown");
  assert.ok(said < wiped, "the row must say it is clearing while the wipe is under way");
});

test("a tick that only waits keeps the last thing the row said — it never goes blank", async () => {
  const decisions: Record<string, any> = { p1: RESET_DECISION };
  const api = fakeApi([phone("p1")], decisions);
  const bridge = resetBridge(() => ({ ok: true, op: "factory_reset", sent: true }));
  const d = createSetupDriver("r1", api, bridge);
  const first = await d.tick();
  assert.equal(first.hints.p1, HINT_RESET_SENT);
  decisions.p1 = { action: "do_nothing" }; // the phone is restarting; nothing to perform
  const second = await d.tick();
  assert.equal(second.hints.p1, HINT_RESET_SENT, "a waiting phone read as the wizard having stopped");
});

test("a registered phone says it can make calls", async () => {
  const api = fakeApi([phone("p1", { state: "REGISTERED", status: "Ready" })], {});
  const out = await createSetupDriver("r1", api, fakeBridge()).tick();
  assert.equal(out.hints.p1, HINT_CONNECTED);
});

test("a progress listener that throws never stops the setup", async () => {
  const api = fakeApi([phone("p1")], { p1: { action: "try_default_credentials" } });
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge, undefined, () => { throw new Error("screen gone"); });
  await d.tick();
  assert.equal(bridge.ops[0].op, "test_credentials");
});

test("classifyResetAnswer: the counting policy, exhaustively", () => {
  assert.equal(classifyResetAnswer(null), "wait");
  assert.equal(classifyResetAnswer({ ok: true, sent: true }), "sent");
  assert.equal(classifyResetAnswer({ ok: true, sent: false }), "wait");
  assert.equal(classifyResetAnswer({ ok: false, refused: "reset_unsafe:unknown_model" }), "refused");
  assert.equal(classifyResetAnswer({ ok: false, refused: "unknown_operation" }), "refused");
  assert.equal(classifyResetAnswer({ ok: false, refused: "not_a_private_address" }), "refused");
  assert.equal(classifyResetAnswer({ ok: false, refused: "reset_not_authorized" }), "wait");
  assert.equal(classifyResetAnswer({ ok: false, refused: "too_soon_for_this_phone" }), "wait");
  assert.equal(classifyResetAnswer({ ok: false, refused: "already_reset_this_session" }), "sent");
  assert.equal(classifyResetAnswer({ ok: false, refused: "http_500" }), "sent");
});

/* ── the maker's cloud: the server names the mechanism, this machine listens and asks ── */

const FOLDER = "https://m.connectcomunications.com/phoneprov/0123456789abcdef/";
const gsPhone = (over: any = {}) => phone("p1", { vendor: "grandstream", model: "GXP2170", mac: "c074ad8c605f", ...over });
// A brand the server may route to a maker cloud but which this machine holds NO local reset for,
// so when the cloud is unavailable the fallback is the non-destructive hand-off, not a LAN reset.
const cloudOnlyPhone = (over: any = {}) => phone("p1", { vendor: "polycom", model: "VVX411", mac: "0004f2aabbcc", ...over });

/** An api whose /prepare answers come from a queue, so each tick's cloud outcome is scripted. */
function cloudApi(phones: any[], decision: any, prepareReplies: any[]) {
  const api = fakeApi(phones, { p1: decision });
  const post = api.post;
  (api as any).post = async (path: string, body?: any) => {
    if (path.endsWith("/prepare")) {
      api.calls.push({ method: "POST", path, body });
      const next = prepareReplies.length > 1 ? prepareReplies.shift() : prepareReplies[0];
      if (next instanceof Error) throw next;
      return next;
    }
    return post(path, body);
  };
  return api;
}
const prepares = (api: any) => api.calls.filter((c: any) => c.path.endsWith("/prepare"));

test("cloud reset: LISTEN first, then the server runs the clear; nothing is wiped from this machine", async () => {
  const api = cloudApi([gsPhone()], { action: "reset_over_lan", via: "vendor_cloud", provisioningUrl: FOLDER, resetAuthorizationId: "run_1.1" },
    [{ ok: true, plan: { manualAction: null }, ran: [{ step: "claim", ok: true }, { step: "factory_reset", ok: true }] }]);
  const bridge = fakeBridge();
  const out = await createSetupDriver("r1", api, bridge).tick();
  assert.equal(bridge.ops[0].op, "set_provisioning", "the listener is armed before the maker is asked");
  assert.equal(bridge.ops[0].reboot, false);
  assert.equal(bridge.ops[0].url, FOLDER);
  assert.ok(!bridge.ops.some((o: any) => o.op === "factory_reset"), "the office machine never wipes a cloud brand");
  assert.equal(prepares(api).length, 1);
  assert.equal(resetReports(api).length, 0, "the server counted the cloud reset itself");
  assert.equal(out.hints.p1, HINT_RESET_SENT);
  assert.ok(out.performed.some((p) => p.action === "reset_via_cloud"));
});

test("cloud reset: nothing is cleared while this machine cannot listen", async () => {
  const api = cloudApi([gsPhone()], { action: "reset_over_lan", via: "vendor_cloud", provisioningUrl: FOLDER }, [{ ok: true, ran: [] }]);
  const bridge = { ops: [] as any[], run: async (req: any) => { bridge.ops.push(req); return { ok: false, refused: "cannot_listen" }; } };
  const out = await createSetupDriver("r1", api, bridge).tick();
  assert.equal(prepares(api).length, 0);
  assert.equal(out.hints.p1, HINT_CANNOT_LISTEN);
});

test("cloud reset: the maker needs the serial — the person is asked, the maker is not hammered, and the answer resumes it", async () => {
  let clock = 1_000_000;
  const api = cloudApi([gsPhone()], { action: "reset_over_lan", via: "vendor_cloud", provisioningUrl: FOLDER }, [
    { ok: true, plan: { manualAction: { code: "serial_required", message: "Scan the label." } }, ran: [] },
    { ok: true, plan: { manualAction: null }, ran: [{ step: "factory_reset", ok: true }] },
  ]);
  const d = createSetupDriver("r1", api, fakeBridge(), () => clock);
  const first = await d.tick();
  assert.deepEqual(first.needs.map((n) => n.kind), ["serial"]);
  assert.equal(first.hints.p1, HINT_NEEDS_SERIAL);

  clock += 4_000;
  const paced = await d.tick();
  assert.equal(prepares(api).length, 1, `asked again inside ${CLOUD_ASK_INTERVAL_MS} ms`);
  // ⛔⛔ THE REGRESSION IZZY HIT: the ask is paced, the QUESTION is not. A need raised only on the
  // asking tick vanished from the screen on every tick in between — "the field to put it in keeps
  // disappearing every few seconds" — taking whatever was half-typed with it.
  assert.deepEqual(paced.needs.map((n) => n.kind), ["serial"], "the serial question survives a paced tick");
  assert.equal(paced.hints.p1, HINT_NEEDS_SERIAL);
  for (let i = 0; i < 5; i += 1) {
    clock += 4_000;
    const still = await d.tick();
    assert.deepEqual(still.needs.map((n) => n.kind), ["serial"], `tick ${i} dropped the serial question`);
  }
  assert.equal(prepares(api).length, 1, "and none of those ticks re-asked the maker");

  d.serialProvided("p1");
  const resumed = await d.tick();
  assert.equal(prepares(api).length, 2, "a saved serial is tried on the very next tick");
  assert.equal(resumed.hints.p1, HINT_RESET_SENT);
});

test("cloud reset: 'I can't find it' ends the cloud for that phone, which continues the way it did before", async () => {
  const api = cloudApi([cloudOnlyPhone()], { action: "reset_over_lan", via: "vendor_cloud", provisioningUrl: FOLDER, resetAuthorizationId: "run_1.1" },
    [{ ok: true, plan: { manualAction: { code: "serial_required", message: "Scan the label." } }, ran: [] }]);
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge);
  await d.tick();
  d.serialUnavailable("p1");
  const next = await d.tick();
  assert.equal(prepares(api).length, 1);
  assert.equal(next.hints.p1, HINT_RESET_SKIPPED);
  // The observation travels on the NEXT advance, which is what turns the server to the hand-off.
  await d.tick();
  const adv = api.calls.filter((c: any) => c.path.endsWith("/advance")).at(-1)!;
  assert.equal(adv.body.resetRefusedLocally, true, "the server hands the phone its folder instead");
  assert.equal(prepares(api).length, 1);
});

test("cloud reset: a refusal that will not change ends the cloud; a retryable one is asked again later", async () => {
  let clock = 5_000_000;
  const api = cloudApi([cloudOnlyPhone()], { action: "reset_over_lan", via: "vendor_cloud", provisioningUrl: FOLDER, resetAuthorizationId: "run_1.1" }, [
    { ok: true, plan: { manualAction: null }, ran: [{ step: "factory_reset", ok: false, retryable: true, message: "Busy, try again." }] },
    { ok: true, plan: { manualAction: null }, ran: [{ step: "factory_reset", ok: false, retryable: false, message: "Not allowed." }] },
  ]);
  const d = createSetupDriver("r1", api, fakeBridge(), () => clock);
  const busy = await d.tick();
  assert.equal(busy.hints.p1, "Busy, try again.");
  clock += CLOUD_ASK_INTERVAL_MS;
  const refused = await d.tick();
  assert.equal(refused.hints.p1, "Not allowed.");
  clock += CLOUD_ASK_INTERVAL_MS;
  const after = await d.tick();
  assert.equal(prepares(api).length, 2, "a permanent refusal is not asked again");
  assert.equal(after.hints.p1, HINT_RESET_SKIPPED);
});

test("cloud restart: listening first, the maker restarts the phone at most twice, spaced out, never every tick", async () => {
  let clock = 9_000_000;
  const api = cloudApi([gsPhone({ resetCount: 1 })], { action: "set_provisioning", via: "vendor_cloud", provisioningUrl: FOLDER },
    [{ ok: true, plan: { manualAction: null }, ran: [{ step: "reboot", ok: true }] }]);
  const bridge = fakeBridge();
  const d = createSetupDriver("r1", api, bridge, () => clock);

  const first = await d.tick();
  assert.equal(bridge.ops[0].op, "set_provisioning");
  assert.equal(bridge.ops[0].reboot, false, "the office machine never restarts a cloud brand itself");
  assert.equal(prepares(api).length, 1);
  assert.equal(first.hints.p1, HINT_RESTARTING);

  for (let i = 0; i < 10; i += 1) { clock += 4_000; await d.tick(); }
  assert.equal(prepares(api).length, 1, "a restart that is under way is waited for");

  clock += CLOUD_RESTART_WAIT_MS;
  await d.tick();
  assert.equal(prepares(api).length, 2);

  for (let i = 0; i < 5; i += 1) { clock += CLOUD_RESTART_WAIT_MS; await d.tick(); }
  assert.equal(prepares(api).length, PROVISIONING_REBOOT_ATTEMPTS, "restarts are bounded like every restart");
});

test("cloud restart: a phone that already asked and got its folder is not restarted", async () => {
  const api = cloudApi([gsPhone({ resetCount: 1 })], { action: "set_provisioning", via: "vendor_cloud", provisioningUrl: FOLDER },
    [{ ok: true, ran: [{ step: "reboot", ok: true }] }]);
  const bridge = { ops: [] as any[], run: async (req: any) => { bridge.ops.push(req); return { ok: true, op: req.op, delivered: true }; } };
  await createSetupDriver("r1", api, bridge).tick();
  assert.equal(prepares(api).length, 0);
});

test("a brand with no LAN executor and no cloud is not wiped from this machine — it takes the hand-off", async () => {
  // Polycom has neither a shipped HTTP executor nor (here) a maker cloud, so a LAN reset cannot
  // be sent: the phone is handed its settings instead. (Grandstream and Yealink DO reset over LAN.)
  const poly = phone("p1", { vendor: "polycom", model: "VVX411", mac: "0004f2aabbcc" });
  const api = cloudApi([poly], { action: "reset_over_lan", resetAuthorizationId: "run_1.1" }, [{ ok: true, ran: [] }]);
  const bridge = fakeBridge();
  const out = await createSetupDriver("r1", api, bridge).tick();
  assert.equal(prepares(api).length, 0);
  assert.equal(bridge.ops.length, 0);
  assert.equal(out.hints.p1, HINT_RESET_SKIPPED);
});

test("a Grandstream with no cloud is cleared over the LAN with the customer's password (login → RESET)", async () => {
  const api = fakeApi([gsPhone()], { p1: { action: "reset_over_lan", resetAuthorizationId: "run_1.1" } });
  const bridge = { ops: [] as any[], run: async (req: any) => { bridge.ops.push(req); return req.op === "factory_reset" ? { ok: true, op: "factory_reset", sent: true } : { ok: true, op: req.op, fingerprint: { model: "GXP2170" } }; } };
  const out = await createSetupDriver("r1", api, bridge).tick();
  const wipe = bridge.ops.find((o: any) => o.op === "factory_reset");
  assert.ok(wipe, JSON.stringify(bridge.ops));
  assert.equal(wipe.vendor, "grandstream", "the desktop is told the brand so it uses the Grandstream reset");
  assert.equal(resetReports(api).length, 1);
  assert.equal(out.hints.p1, HINT_RESET_SENT);
});
