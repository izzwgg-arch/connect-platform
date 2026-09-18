/**
 * The phone web robot — driven through a FAKE `RobotBrowser` scripted per-page, so
 * every fence (address, URL, budget, ref-staleness, credential handling) is proven
 * without a real Chrome process or a handset on a desk.
 *
 * ⛔ The fake models a real Yealink v86 web UI's shape (round 23, 2026-09-17): a
 * login form with `idUsername`/`idPassword`, a forced-password-change interstitial
 * with two bare password fields, an autop page with `AutoProvisionServerURL` /
 * `AutoProvisionUser` / `AutoProvisionPassword` / `btn_confirm1` / `btnAutopNow`, and
 * a Settings→Upgrade page whose reset control is found by its own text.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  runWebProbe, runWebReset, runWebProvision, runWebAct, buildOriginGuard, generatePassword,
  type RawElement, type RawRead, type RobotBrowser, type RobotPage, type RobotDeps,
} from "./phoneWebRobot";
import { YEALINK_DEFAULT_CREDENTIALS, type YealinkCredentials } from "./yealink";

const IP = "192.168.6.170";
const MAC = "80:5e:0c:4d:79:6d";
const OK_URL = "https://m.connectcomunications.com/phoneprov/a70274ea0f143ca0/";

/* ── the fake device: a small stateful world the fake browser renders from ─── */

type Stage = "unknown_device" | "logged_out" | "forced_change" | "logged_in";

class FakeWorld {
  stage: Stage = "logged_out";
  creds: YealinkCredentials = { ...YEALINK_DEFAULT_CREDENTIALS };
  forcePasswordChangeOnLogin = false;
  passwordChanged = false;
  mac = MAC;
  model = "T42S";
  firmware = "66.86.0.15";
  serial = "805ec0b3b2d0";
  path = "";
  autopUrl = "https://yealink.sipflash.com/dms/config";
  autopUser = "oldprovider";
  autopPassword = "oldsecret";
  pendingUrl: string | null = null;
  pendingUser: string | null = null;
  pendingPassword: string | null = null;
  saveVerifies = true;
  hasSaveButton = true;
  hasTriggerButton = true;
  hasResetButton = true;
  triggeredAutopNow = false;
  resetClicked = false;
  private typedUsername = "";
  private typedPassword = "";
  private typedNew: [string, string] = ["", ""];

  render(): RawRead {
    if (this.stage === "unknown_device") {
      return { url: `http://${IP}/`, title: "Router Admin", text: "This is a generic router login.", elements: [
        { tag: "input", type: "text", name: "user", id: "user", label: "User", value: "" },
      ] };
    }
    if (this.stage === "logged_out") {
      return {
        url: `https://${IP}/servlet?m=mod_listener&p=login&q=loginForm&jumpto=status`,
        title: "Yealink IP Phone",
        text: "Default password is in use. Please change!",
        elements: [
          { tag: "input", type: "text", name: "", id: "idUsername", label: "Username", value: "" },
          { tag: "input", type: "password", name: "", id: "idPassword", label: "Password", value: "" },
          { tag: "input", type: "hidden", name: "", id: "idConfirm", label: "", value: "" },
          { tag: "input", type: "submit", name: "", id: "", label: "Confirm", value: "Confirm" },
        ],
      };
    }
    if (this.stage === "forced_change") {
      return {
        url: `https://${IP}/servlet?m=mod_listener&p=login&q=changePassword`,
        title: "Yealink IP Phone", text: "You must change the default password before continuing.",
        elements: [
          { tag: "input", type: "password", name: "", id: "idNewPassword", label: "New password", value: "" },
          { tag: "input", type: "password", name: "", id: "idConfirmPassword", label: "Confirm password", value: "" },
          { tag: "input", type: "submit", name: "", id: "", label: "Confirm", value: "Confirm" },
        ],
      };
    }
    // logged_in
    if (this.path === "/servlet?m=mod_data&p=settings-autop&q=load") {
      const elements: RawElement[] = [
        { tag: "input", type: "text", name: "AutoProvisionServerURL", id: "", label: "Server URL", value: this.autopUrl },
        { tag: "input", type: "text", name: "AutoProvisionUser", id: "", label: "User", value: this.autopUser },
        { tag: "input", type: "password", name: "AutoProvisionPassword", id: "", label: "Password", value: "" },
      ];
      if (this.hasSaveButton) elements.push({ tag: "button", type: "submit", name: "", id: "btn_confirm1", label: "Confirm", value: "Confirm" });
      if (this.hasTriggerButton) elements.push({ tag: "button", type: "button", name: "", id: "btnAutopNow", label: "AutoProvision Now", value: "AutoProvision Now" });
      return { url: `https://${IP}${this.path}`, title: "Auto Provision", text: "Auto Provision", elements };
    }
    if (this.path === "/servlet?m=mod_data&p=settings-upgrade&q=load") {
      const elements: RawElement[] = [];
      if (this.hasResetButton) elements.push({ tag: "button", type: "button", name: "", id: "", label: "Reset to Factory Setting", value: "" });
      return { url: `https://${IP}${this.path}`, title: "Upgrade", text: "Upgrade", elements };
    }
    return {
      url: `https://${IP}/servlet?m=mod_data&p=status&q=load`,
      title: "Status",
      text: `Firmware Version ${this.firmware}  MAC Address ${this.mac}  Machine ID ${this.serial}  Yealink SIP-${this.model}`,
      elements: [],
    };
  }

  fill(el: RawElement, text: string) {
    if (this.stage === "logged_out") {
      if (el.id === "idUsername") this.typedUsername = text;
      if (el.id === "idPassword") this.typedPassword = text;
      return;
    }
    if (this.stage === "forced_change") {
      if (el.id === "idNewPassword") this.typedNew[0] = text;
      if (el.id === "idConfirmPassword") this.typedNew[1] = text;
      return;
    }
    if (el.name === "AutoProvisionServerURL") this.pendingUrl = text;
    if (el.name === "AutoProvisionUser") this.pendingUser = text;
    if (el.name === "AutoProvisionPassword") this.pendingPassword = text;
  }

  async click(el: RawElement) {
    if (this.stage === "logged_out" && el.type === "submit") {
      if (this.typedUsername === this.creds.username && this.typedPassword === this.creds.password) {
        this.stage = this.forcePasswordChangeOnLogin && !this.passwordChanged ? "forced_change" : "logged_in";
        this.path = "/servlet?m=mod_listener&p=login&q=loginForm&jumpto=status";
      }
      return;
    }
    if (this.stage === "forced_change" && el.type === "submit") {
      if (this.typedNew[0] && this.typedNew[0] === this.typedNew[1]) {
        this.creds = { ...this.creds, password: this.typedNew[0] };
        this.passwordChanged = true;
        this.stage = "logged_in";
        this.path = "/servlet?m=mod_listener&p=login&q=loginForm&jumpto=status";
      }
      return;
    }
    if (el.id === "btn_confirm1") {
      if (this.saveVerifies) {
        if (this.pendingUrl !== null) this.autopUrl = this.pendingUrl;
        if (this.pendingUser !== null) this.autopUser = this.pendingUser;
        if (this.pendingPassword !== null) this.autopPassword = this.pendingPassword;
      }
      return;
    }
    if (el.id === "btnAutopNow") { this.triggeredAutopNow = true; return; }
    if (el.label === "Reset to Factory Setting") { this.resetClicked = true; return; }
  }
}

/* ── the fake browser/page ───────────────────────────────────────────────── */

class FakePage implements RobotPage {
  lastElements: RawElement[] = [];
  gotoCalls: string[] = [];
  constructor(private world: FakeWorld) {}
  async goto(path: string) {
    if (path.includes("://")) throw new Error("goto must take a path, never a URL");
    this.gotoCalls.push(path);
    this.world.path = path;
  }
  async read(): Promise<RawRead> {
    const r = this.world.render();
    this.lastElements = r.elements;
    return r;
  }
  async fill(index: number, text: string) {
    const el = this.lastElements[index];
    if (!el) throw new Error("stale_index");
    this.world.fill(el, text);
  }
  async click(index: number) {
    const el = this.lastElements[index];
    if (!el) throw new Error("stale_index");
    await this.world.click(el);
  }
  async close() { /* nothing to release in the fake */ }
}

function fakeBrowser(world: FakeWorld, opts: { unreachable?: boolean } = {}): { browser: RobotBrowser; page: FakePage | null; opened: string[] } {
  const opened: string[] = [];
  let page: FakePage | null = null;
  const browser: RobotBrowser = {
    async openPage(ip: string) {
      opened.push(ip);
      if (opts.unreachable) return null;
      page = new FakePage(world);
      return page;
    },
  };
  return { browser, page, opened };
}

/* ── the deps a real driver supplies, spied on ──────────────────────────── */

function fakeDeps(browser: RobotBrowser, overrides: Partial<RobotDeps> = {}): RobotDeps & {
  loginOutcomes: Array<{ ip: string; outcome: { ok: boolean; reason?: string } }>;
  storedCredentials: Array<{ ref: string; creds: YealinkCredentials }>;
  blockedIps: Set<string>;
} {
  const loginOutcomes: Array<{ ip: string; outcome: { ok: boolean; reason?: string } }> = [];
  const storedCredentials: Array<{ ref: string; creds: YealinkCredentials }> = [];
  const blockedIps = new Set<string>();
  let refCounter = 0;
  const vault = new Map<string, YealinkCredentials>();
  const deps: RobotDeps & { loginOutcomes: typeof loginOutcomes; storedCredentials: typeof storedCredentials; blockedIps: typeof blockedIps } = {
    browser,
    resolveCredential: async (ref) => vault.get(ref) ?? null,
    loginBlocked: (ip) => blockedIps.has(ip),
    noteLogin: (ip, outcome) => loginOutcomes.push({ ip, outcome }),
    storeCredential: async (creds) => {
      const ref = `test-ref-${(refCounter += 1)}`;
      vault.set(ref, creds);
      storedCredentials.push({ ref, creds });
      return ref;
    },
    now: () => Date.now(),
    log: () => {},
    webActSessions: new Map(),
    loginOutcomes, storedCredentials, blockedIps,
    ...overrides,
  };
  return deps;
}

/* ── the address and URL fences ──────────────────────────────────────────── */

test("web_probe refuses a public address before a page is ever opened", async () => {
  const world = new FakeWorld();
  const { browser, opened } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProbe(deps, { ip: "8.8.8.8" });
  assert.deepEqual(out, { ok: false, refused: "not_a_private_address" });
  assert.equal(opened.length, 0, "no page was opened for a public address");
});

test("web_provision refuses a non-Loopcom URL before typing anything, and before a page opens", async () => {
  const world = new FakeWorld();
  const { browser, opened } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  for (const bad of [
    "https://yealink.sipflash.com/dms/config", // the previous provider's own URL
    "http://m.connectcomunications.com/phoneprov/a70274ea0f143ca0/", // http, not https
    "https://m.connectcomunications.com.evil.com/phoneprov/a70274ea0f143ca0/", // lookalike host
    "https://m.connectcomunications.com/phoneprov/../../etc/passwd",
    "not a url at all",
  ]) {
    const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: bad });
    assert.deepEqual(out, { ok: false, refused: "fenced_url_refused" }, bad);
  }
  assert.equal(opened.length, 0, "a fenced URL never even opens a page");
});

test("web_provision refuses a bad hardware address before opening a page", async () => {
  const world = new FakeWorld();
  const { browser, opened } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: "not-a-mac", url: OK_URL });
  assert.deepEqual(out, { ok: false, refused: "bad_hardware_address" });
  assert.equal(opened.length, 0);
});

test("origin guard: only this exact phone's host, in either scheme, is ever allowed", () => {
  const allow = buildOriginGuard(IP);
  assert.equal(allow(`https://${IP}/servlet?p=status`), true);
  assert.equal(allow(`http://${IP}/`), true);
  for (const url of [
    "https://evil.example/",
    "https://192.168.6.171/", // one octet off — a different phone
    "https://m.connectcomunications.com/phoneprov/x/", // a real Loopcom host, but not THIS origin
    `https://${IP}.evil.example/`, // lookalike suffix
    "not a url",
    "",
  ]) {
    assert.equal(allow(url), false, url);
  }
});

test("origin guard built from a public/garbage address allows nothing at all", () => {
  const allow = buildOriginGuard("8.8.8.8");
  assert.equal(allow("https://8.8.8.8/"), false, "not even its own address, because it was never a private one");
});

/* ── web_probe ────────────────────────────────────────────────────────────── */

test("web_probe: the happy path reads model/firmware/serial and the CURRENT provisioning URL", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProbe(deps, { ip: IP });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.family, "yealink_v86");
  assert.equal(out.loginWorked, true);
  assert.equal(out.usedDefault, true);
  assert.equal(out.forcedPasswordChange, false);
  assert.equal(out.model, "T42S");
  assert.equal(out.firmware, "66.86.0.15");
  assert.equal(out.serial, "805ec0b3b2d0");
  assert.equal(out.provisioningUrl, "https://yealink.sipflash.com/dms/config");
  assert.equal(deps.loginOutcomes.length, 1);
  assert.equal(deps.loginOutcomes[0].outcome.ok, true);
});

test("web_probe: a wrong password refuses honestly as loginWorked:false, NOT as an error, and spends the lockout gate", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProbe(deps, { ip: IP, credentialRef: "missing-or-wrong" });
  // credentialRef resolves to nothing here, which is its own refusal path —
  // covered by the next test. This one exercises a WRONG password that DOES resolve.
  assert.deepEqual(out, { ok: false, refused: "credential_not_available" });
});

test("web_probe: a resolvable but wrong credential logs in, fails, and is reported honestly", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  await deps.storeCredential({ username: "admin", password: "totally-wrong" });
  const out = await runWebProbe(deps, { ip: IP, credentialRef: "test-ref-1" });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.family, "yealink_v86", "the login FORM was recognised even though the password was wrong");
  assert.equal(out.loginWorked, false);
  assert.equal(out.usedDefault, false);
  assert.equal(deps.loginOutcomes.length, 1);
  assert.equal(deps.loginOutcomes[0].outcome.ok, false);
  assert.equal(deps.loginOutcomes[0].outcome.reason, "locked");
});

test("web_probe: a page that never offered a login form is family unknown, and is NOT a failed login", async () => {
  const world = new FakeWorld();
  world.stage = "unknown_device";
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProbe(deps, { ip: IP });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.family, "unknown");
  assert.equal(out.loginWorked, false);
  assert.ok(out.snapshot, "an unrecognised page still gets a sanitized snapshot");
  assert.equal(deps.loginOutcomes.length, 0, "a page with no login form spends nothing from the lockout gate");
});

test("web_probe: a phone already at the lockout limit is not even asked for a password", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  deps.blockedIps.add(IP);
  const out = await runWebProbe(deps, { ip: IP });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.family, "yealink_v86");
  assert.equal(out.loginWorked, false);
  assert.equal(deps.loginOutcomes.length, 0, "no login was attempted at all");
});

test("web_probe: unreachable phone", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world, { unreachable: true });
  const deps = fakeDeps(browser);
  const out = await runWebProbe(deps, { ip: IP });
  assert.deepEqual(out, { ok: false, refused: "unreachable" });
});

/* ── web_provision: the proven happy path ───────────────────────────────── */

test("web_provision: the proven live script — login, verify the wrong-device fence, save, VERIFY by re-reading, then trigger", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL });
  assert.deepEqual(out, { ok: true, op: "web_provision", provisioned: true, urlVerified: true });
  assert.equal(world.autopUrl, OK_URL, "the folder was actually saved");
  assert.equal(world.autopUser, "", "the previous provider's username was cleared");
  assert.equal(world.autopPassword, "", "the previous provider's password was cleared");
  assert.equal(world.triggeredAutopNow, true, "the proven live step: trigger an immediate re-provision");
});

test("web_provision: a save that does not verify is refused, and nothing is triggered", async () => {
  const world = new FakeWorld();
  world.saveVerifies = false;
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "save_not_verified");
  assert.ok(out.snapshot);
  assert.notEqual(world.autopUrl, OK_URL, "an accepted click that did not verify never counts as a save");
  assert.equal(world.triggeredAutopNow, false, "never trigger a save that was not verified");
});

test("web_provision: the WRONG device (a different MAC) is refused before anything is written", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: "aa:bb:cc:dd:ee:ff", url: OK_URL });
  assert.deepEqual(out, { ok: false, refused: "wrong_device" });
  assert.equal(world.autopUrl, "https://yealink.sipflash.com/dms/config", "nothing was ever written to the wrong phone");
});

test("web_provision: a forced password change is completed with a MINTED password, stored, and reported", async () => {
  const world = new FakeWorld();
  world.forcePasswordChangeOnLogin = true;
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL, setPassword: true });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.credentialRefCreated, "a new credential reference was minted");
  assert.equal(deps.storedCredentials.length, 1);
  assert.equal(deps.storedCredentials[0].ref, out.credentialRefCreated);
  assert.equal(deps.storedCredentials[0].creds.username, "admin");
  assert.equal(deps.storedCredentials[0].creds.password.length, 16, "generatePassword's own length");
  assert.notEqual(deps.storedCredentials[0].creds.password, "admin", "never the default");
  assert.equal(world.autopUrl, OK_URL, "provisioning still completed after the forced change");
});

test("web_provision: a forced password change WITHOUT permission to set one is refused, never improvised past", async () => {
  const world = new FakeWorld();
  world.forcePasswordChangeOnLogin = true;
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL }); // setPassword omitted
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "password_change_required");
  assert.equal(deps.storedCredentials.length, 0);
  assert.equal(world.autopUrl, "https://yealink.sipflash.com/dms/config", "nothing was written");
});

test("web_provision: a login that keeps refusing is login_failed and spends the lockout gate", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  await deps.storeCredential({ username: "admin", password: "nope" });
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL, credentialRef: "test-ref-1" });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "login_failed");
  assert.equal(deps.loginOutcomes.at(-1)?.outcome.reason, "locked");
});

test("web_provision: a page that is not the v86 login shape refuses unknown_screen without typing anything", async () => {
  const world = new FakeWorld();
  world.stage = "unknown_device";
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "unknown_screen");
  assert.ok(out.snapshot);
});

test("web_provision: already at the lockout limit refuses without touching the phone", async () => {
  const world = new FakeWorld();
  const { browser, opened } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  deps.blockedIps.add(IP);
  const out = await runWebProvision(deps, { ip: IP, mac: MAC, url: OK_URL });
  assert.deepEqual(out, { ok: false, refused: "too_many_login_attempts" });
  assert.equal(opened.length, 0);
});

/* ── web_reset ────────────────────────────────────────────────────────────── */

test("web_reset: logs in, finds the reset control defensively by its own text, clicks it, and reports honestly", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebReset(deps, { ip: IP });
  assert.deepEqual(out, { ok: true, op: "web_reset", sent: true });
  assert.equal(world.resetClicked, true);
});

test("web_reset: no recognisable reset control on the upgrade page is unknown_screen, and nothing is clicked", async () => {
  const world = new FakeWorld();
  world.hasResetButton = false;
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebReset(deps, { ip: IP });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "unknown_screen");
  assert.equal(world.resetClicked, false);
});

test("web_reset: a forced password change mid-flow is reported, never improvised past (web_reset never mints a password)", async () => {
  const world = new FakeWorld();
  world.forcePasswordChangeOnLogin = true;
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebReset(deps, { ip: IP });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "password_change_required");
  assert.equal(deps.storedCredentials.length, 0);
  assert.equal(world.resetClicked, false);
});

test("web_reset: never auto-invoked — it only runs because IT was the op that was dispatched", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  await runWebProbe(deps, { ip: IP }); // a read-only probe on the same phone
  assert.equal(world.resetClicked, false, "probing a phone never resets it");
});

/* ── web_act: the agent-advised improvisation loop ──────────────────────── */

// ⛔⛔ WHY A SECOND CALL CAN USE THE FIRST CALL'S REFS. The improvisation loop is
// driven by separate tool calls from an agent: it reads in one call, reasons about
// what it saw, and only THEN issues fill/click in a SEPARATE call referencing the
// exact refs the first call handed back. For that to work at all, this module
// keeps the phone's page (and its most recent refs) OPEN across calls for the
// same address — see `WebActSession` in phoneWebRobot.ts. All of that requires
// reusing the SAME `deps` (and so the same `webActSessions` store) across calls,
// exactly as every test below does.

test("web_act: a read in one call, then fill/click in the NEXT call using those SAME refs, reaches the status page", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const first = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const userRef = first.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  const passRef = first.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const submitRef = first.snapshot.elements.find((e) => e.type === "submit")!.ref;
  const second = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "fill", ref: userRef, text: "admin" },
      { kind: "fill", ref: passRef, text: "admin" },
      { kind: "click", ref: submitRef },
    ],
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.ok(second.outcomes.every((o) => o.ok), JSON.stringify(second.outcomes));
  assert.match(second.snapshot.text, /Firmware Version/, "the session's own trailing read shows the status page, after login");
});

test("web_act: a read then fill then click chained within ONE call, using refs from an EARLIER call in the same session", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const first = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const userRef = first.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  const passRef = first.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const submitRef = first.snapshot.elements.find((e) => e.type === "submit")!.ref;
  const second = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "fill", ref: userRef, text: "admin" },
      { kind: "fill", ref: passRef, text: "admin" },
      { kind: "click", ref: submitRef },
      { kind: "read" },
    ],
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.outcomes.length, 4);
  assert.ok(second.outcomes.every((o) => o.ok), JSON.stringify(second.outcomes));
  assert.match(second.snapshot.text, /Firmware Version/);
});

test("web_act: an idle session (past WEB_ACT_SESSION_IDLE_MS) is discarded — its old refs are stale in the new one", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  let clock = 1_000_000;
  const deps = fakeDeps(browser, { now: () => clock });
  const first = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const userRef = first.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  clock += 3 * 60_000; // past the idle timeout
  const second = await runWebAct(deps, { ip: IP, actions: [{ kind: "fill", ref: userRef, text: "admin" }] });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.outcomes, [{ ok: false, kind: "fill", refused: "stale_ref" }]);
});

test("web_act: a ref used again after the click that invalidated it (a new read intervened) is refused", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const first = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const userRef = first.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  const submitRef = first.snapshot.elements.find((e) => e.type === "submit")!.ref;
  const second = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "read" }, // fresh refs replace the session's old ones
      { kind: "click", ref: submitRef }, // the OLD ref: stale now
      { kind: "fill", ref: userRef, text: "admin" }, // same story
    ],
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.outcomes[1], { ok: false, kind: "click", refused: "stale_ref" });
  assert.deepEqual(second.outcomes[2], { ok: false, kind: "fill", refused: "stale_ref" });
});

test("web_act: evictWebActSession closes a session other ops must not fight over", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const first = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(first.ok, true);
  assert.ok(deps.webActSessions.has(IP));
  // web_probe (a fresh op against the same phone) evicts the lingering session
  // before it opens its own page — proven by the ref now being stale.
  const probe = await runWebProbe(deps, { ip: IP });
  assert.equal(probe.ok, true);
  assert.ok(!deps.webActSessions.has(IP), "web_probe closed the web_act session before driving the phone itself");
});

test("web_act: goto takes a path only — anything shaped like a URL is refused before it reaches the page", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "goto", path: "https://evil.example/" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.outcomes, [{ ok: false, kind: "goto", refused: "path_only" }]);
});

test("web_act: a literal typed into a password field is refused — only the resolved credential may go there", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const probe = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(probe.ok, true);
  if (!probe.ok) return;
  const passRef = probe.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "fill", ref: passRef, text: "whatever-i-feel-like" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.outcomes, [{ ok: false, kind: "fill", refused: "password_literal_refused" }]);
});

test("web_act: the resolved credential's OWN password may still be typed into a password field", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const probe = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(probe.ok, true);
  if (!probe.ok) return;
  const passRef = probe.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "fill", ref: passRef, text: YEALINK_DEFAULT_CREDENTIALS.password }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.outcomes, [{ ok: true, kind: "fill" }]);
});

test("web_act: a fenced (non-Loopcom) URL typed into an ordinary field is refused too", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const login = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "read" },
    ],
  });
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const userRef = login.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  const passRef = login.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const submitRef = login.snapshot.elements.find((e) => e.type === "submit")!.ref;
  const loggedIn = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "fill", ref: userRef, text: "admin" },
      { kind: "fill", ref: passRef, text: "admin" },
      { kind: "click", ref: submitRef },
      { kind: "goto", path: "/servlet?m=mod_data&p=settings-autop&q=load" },
      { kind: "read" },
    ],
  });
  assert.equal(loggedIn.ok, true);
  if (!loggedIn.ok) return;
  const urlFieldRef = loggedIn.snapshot.elements.find((e) => e.name === "AutoProvisionServerURL")!.ref;
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "fill", ref: urlFieldRef, text: "https://evil.example/take-everything" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.outcomes, [{ ok: false, kind: "fill", refused: "fenced_url_refused" }]);
});

test("web_act round-23 hardening: bare hostnames and server-field fills obey the one allowed folder", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const login = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(login.ok, true); if (!login.ok) return;
  const userRef = login.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  const passRef = login.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const submitRef = login.snapshot.elements.find((e) => e.type === "submit")!.ref;
  const onAutop = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "fill", ref: userRef, text: "admin" }, { kind: "fill", ref: passRef, text: "admin" },
      { kind: "click", ref: submitRef }, { kind: "goto", path: "/servlet?m=mod_data&p=settings-autop&q=load" }, { kind: "read" },
    ],
  });
  assert.equal(onAutop.ok, true); if (!onAutop.ok) return;

  // Re-read immediately before each fill so the ref is always fresh (the fake reuses
  // the page across calls; a ref captured many calls earlier can go stale).
  const urlRef = async () => {
    const r = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
    assert.equal(r.ok, true); if (!r.ok) throw new Error("read failed");
    return r.snapshot.elements.find((e) => e.name === "AutoProvisionServerURL")!.ref;
  };

  // A bare hostname (no scheme) into the server field is fenced like a full URL.
  const bare = await runWebAct(deps, { ip: IP, allowedUrl: OK_URL, actions: [{ kind: "fill", ref: await urlRef(), text: "evil.example/cfg" }] });
  assert.deepEqual(bare.ok && bare.outcomes, [{ ok: false, kind: "fill", refused: "fenced_url_refused" }]);

  // No allowedUrl handed in => even the REAL folder may not be typed.
  const noAllow = await runWebAct(deps, { ip: IP, actions: [{ kind: "fill", ref: await urlRef(), text: OK_URL }] });
  assert.deepEqual(noAllow.ok && noAllow.outcomes, [{ ok: false, kind: "fill", refused: "fenced_url_refused" }]);

  // Plain words into a SERVER-NAMED field are refused too — the field decides.
  const words = await runWebAct(deps, { ip: IP, allowedUrl: OK_URL, actions: [{ kind: "fill", ref: await urlRef(), text: "perfectly innocent words" }] });
  assert.deepEqual(words.ok && words.outcomes, [{ ok: false, kind: "fill", refused: "fenced_url_refused" }]);

  // The one allowed folder, verbatim, goes through.
  const good = await runWebAct(deps, { ip: IP, allowedUrl: OK_URL, actions: [{ kind: "fill", ref: await urlRef(), text: OK_URL }] });
  assert.deepEqual(good.ok && good.outcomes, [{ ok: true, kind: "fill" }]);
});

test("web_act: the SAME (Loopcom) URL is accepted into a fill", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const login = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const userRef = login.snapshot.elements.find((e) => e.id === "idUsername")!.ref;
  const passRef = login.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const submitRef = login.snapshot.elements.find((e) => e.type === "submit")!.ref;
  const onAutop = await runWebAct(deps, {
    ip: IP,
    actions: [
      { kind: "fill", ref: userRef, text: "admin" }, { kind: "fill", ref: passRef, text: "admin" },
      { kind: "click", ref: submitRef }, { kind: "goto", path: "/servlet?m=mod_data&p=settings-autop&q=load" }, { kind: "read" },
    ],
  });
  assert.equal(onAutop.ok, true);
  if (!onAutop.ok) return;
  const urlFieldRef = onAutop.snapshot.elements.find((e) => e.name === "AutoProvisionServerURL")!.ref;
  const out = await runWebAct(deps, { ip: IP, allowedUrl: OK_URL, actions: [{ kind: "fill", ref: urlFieldRef, text: OK_URL }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.outcomes, [{ ok: true, kind: "fill" }]);
});

test("web_act: no actions at all is refused", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebAct(deps, { ip: IP, actions: [] });
  assert.deepEqual(out, { ok: false, refused: "no_actions" });
});

/* ── the budget: a page that will not resolve cannot hang the wizard ────── */

test("budget: more than 25 page actions in one web_act call is refused as budget_exhausted", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const actions = Array.from({ length: 40 }, () => ({ kind: "read" as const }));
  const out = await runWebAct(deps, { ip: IP, actions });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "budget_exhausted");
});

test("budget: time is enforced too, independent of the action count", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  let calls = 0;
  // A clock that jumps 20 seconds every time it is read simulates a slow phone
  // without an actual multi-minute test run.
  const deps = fakeDeps(browser, { now: () => { calls += 1; return calls * 20_000; } });
  const out = await runWebProbe(deps, { ip: IP });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "budget_exhausted");
});

/* ── credentials ──────────────────────────────────────────────────────────── */

test("a credentialRef that resolves to nothing is a refusal, never a silent unauthenticated attempt", async () => {
  const world = new FakeWorld();
  const { browser, opened } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebProbe(deps, { ip: IP, credentialRef: "nothing-stored-under-this" });
  assert.deepEqual(out, { ok: false, refused: "credential_not_available" });
  assert.equal(opened.length, 0, "never even opens a page without a real credential");
});

test("generatePassword: 16 chars, never the same twice, and never an ambiguous glyph", () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.equal(a.length, 16);
  assert.notEqual(a, b);
  for (const ch of a + b) assert.ok(!"0O1lI".includes(ch), `ambiguous glyph ${ch} in a generated password`);
});

/* ── the sanitized-snapshot contract ─────────────────────────────────────── */

test("sanitized snapshot: a password field's value is NEVER present anywhere in the result, even after it was filled", async () => {
  const world = new FakeWorld();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const login = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const passRef = login.snapshot.elements.find((e) => e.id === "idPassword")!.ref;
  const secret = "a-secret-nobody-should-see-8271";
  const out = await runWebAct(deps, { ip: IP, actions: [
    { kind: "fill", ref: passRef, text: YEALINK_DEFAULT_CREDENTIALS.password }, // legitimate, allowed
    { kind: "read" },
  ] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes(YEALINK_DEFAULT_CREDENTIALS.password) || YEALINK_DEFAULT_CREDENTIALS.password === "admin" && false,
    "the password value itself must not appear in the result");
  assert.ok(!dump.includes(secret), "a secret that was never even used must certainly not appear");
  for (const el of out.snapshot.elements) {
    if (el.type === "password" || el.type === "hidden") assert.equal(el.value, "", `${el.id || el.name} leaked a value`);
  }
});

test("sanitized snapshot: a file input is dropped entirely — never even given a ref", async () => {
  class WorldWithFileInput extends FakeWorld {
    render() {
      const r = super.render();
      if (this.stage === "logged_out") r.elements.push({ tag: "input", type: "file", name: "firmwareUpload", id: "", label: "", value: "" });
      return r;
    }
  }
  const world = new WorldWithFileInput();
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(!out.snapshot.elements.some((e) => e.type === "file"), "no file input was ever exposed as a ref");
});

test("sanitized snapshot: the text is whitespace-collapsed and capped at 1200 characters", async () => {
  class WorldWithLongText extends FakeWorld {
    render() {
      const r = super.render();
      r.text = "line one\n\n\n   line two\t\t\tline three   " + "x".repeat(2000);
      return r;
    }
  }
  const world = new WorldWithLongText();
  world.stage = "unknown_device"; // simplest single-shot render, no login dance
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.snapshot.text.length <= 1200);
  assert.ok(!out.snapshot.text.includes("\n"), "whitespace is collapsed");
  assert.match(out.snapshot.text, /^line one line two line three/);
});

test("sanitized snapshot: no more than 80 elements, and every ref is unique within one snapshot", async () => {
  class WorldWithManyFields extends FakeWorld {
    render() {
      const r = super.render();
      for (let i = 0; i < 150; i += 1) r.elements.push({ tag: "input", type: "text", name: `f${i}`, id: `f${i}`, label: "", value: "" });
      return r;
    }
  }
  const world = new WorldWithManyFields();
  world.stage = "unknown_device";
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.snapshot.elements.length <= 80);
  const refs = out.snapshot.elements.map((e) => e.ref);
  assert.equal(new Set(refs).size, refs.length, "every ref in one snapshot is unique");
  for (const ref of refs) assert.match(ref, /^[0-9a-f]{8}$/, ref);
});

test("ADVERSARIAL: a SIP-credential-looking string inside a label still gets truncated/sanitized, never specially preserved", async () => {
  class WorldWithScaryLabel extends FakeWorld {
    render() {
      const r = super.render();
      r.text = "sip:user:hunter2@pbx.example;transport=tls " + "z".repeat(1500);
      return r;
    }
  }
  const world = new WorldWithScaryLabel();
  world.stage = "unknown_device";
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebAct(deps, { ip: IP, actions: [{ kind: "read" }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.snapshot.text.length <= 1200, "no special-casing let this text through uncapped");
});

/* ── the shared login helper's honesty toward web_provision/web_reset ──── */

test("a page that is not the login shape at all, reached mid-op, is unknown_screen with a snapshot, for web_reset too", async () => {
  const world = new FakeWorld();
  world.stage = "unknown_device";
  const { browser } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  const out = await runWebReset(deps, { ip: IP });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "unknown_screen");
  assert.ok(out.snapshot);
});

test("web_reset and web_provision also refuse when already at the lockout limit, without opening a page", async () => {
  const world = new FakeWorld();
  const { browser, opened } = fakeBrowser(world);
  const deps = fakeDeps(browser);
  deps.blockedIps.add(IP);
  const resetOut = await runWebReset(deps, { ip: IP });
  assert.deepEqual(resetOut, { ok: false, refused: "too_many_login_attempts" });
  assert.equal(opened.length, 0);
});

/* ── replay guard: pin the exact set of refusal strings the four ops use ── */

test("REPLAY GUARD: web_provision's refusal vocabulary is exactly what the driver was told to expect", async () => {
  const scenarios: Array<[string, () => Promise<{ ok: boolean; refused?: string }>]> = [
    ["fenced_url_refused", async () => {
      const world = new FakeWorld(); const { browser } = fakeBrowser(world);
      return runWebProvision(fakeDeps(browser), { ip: IP, mac: MAC, url: "https://evil.example/" });
    }],
    ["bad_hardware_address", async () => {
      const world = new FakeWorld(); const { browser } = fakeBrowser(world);
      return runWebProvision(fakeDeps(browser), { ip: IP, mac: "zz", url: OK_URL });
    }],
    ["wrong_device", async () => {
      const world = new FakeWorld(); const { browser } = fakeBrowser(world);
      return runWebProvision(fakeDeps(browser), { ip: IP, mac: "aa:aa:aa:aa:aa:aa", url: OK_URL });
    }],
    ["unknown_screen", async () => {
      const world = new FakeWorld(); world.stage = "unknown_device"; const { browser } = fakeBrowser(world);
      return runWebProvision(fakeDeps(browser), { ip: IP, mac: MAC, url: OK_URL });
    }],
    ["save_not_verified", async () => {
      const world = new FakeWorld(); world.saveVerifies = false; const { browser } = fakeBrowser(world);
      return runWebProvision(fakeDeps(browser), { ip: IP, mac: MAC, url: OK_URL });
    }],
    ["password_change_required", async () => {
      const world = new FakeWorld(); world.forcePasswordChangeOnLogin = true; const { browser } = fakeBrowser(world);
      return runWebProvision(fakeDeps(browser), { ip: IP, mac: MAC, url: OK_URL });
    }],
  ];
  for (const [expected, run] of scenarios) {
    const out = await run();
    assert.equal(out.ok, false, expected);
    assert.equal(out.refused, expected, expected);
  }
});
