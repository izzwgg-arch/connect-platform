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
import { createSetupDriver } from "./setupDriver";

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
  id, state: "ASSIGNED", status: "Preparing", ip: "192.168.1.20",
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
  // ⛔ and nothing password-shaped is ever POSTed to the api
  for (const c of api.calls) {
    assert.ok(!JSON.stringify(c.body ?? {}).toLowerCase().includes("password"),
      `a password reached the api: ${c.path}`);
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
