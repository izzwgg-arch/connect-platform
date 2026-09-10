/**
 * The desk-phone subsystem must be able to say what it did.
 *
 * ⛔⛔ WHY THIS GUARD EXISTS. `registerPhoneSetup` has accepted an optional `log`
 * since the PnP resident shipped, and `main.ts` never passed one — so
 * `createPnpResident({ log: deps.log })` got `undefined`, every op ran silently, and
 * `connect.log` held ZERO phoneSetup lines for the subsystem's entire life. On
 * 2026-09-10 a customer's Yealink sat halted on screen and the only way to learn why
 * was to read the production database, because the machine that did the work had
 * written nothing down.
 *
 * ⛔ The defect was a CALLER, not a function. Every unit test of the capability
 * passed throughout — they inject their own deps. So these read SOURCE.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeRequest, describeResult, createPhoneCapability } from "./capability";
import type { OperationRequest, OperationResult } from "./capability";

/**
 * ⛔ CRLF-normalised. This tree is checked out with core.autocrlf=true on Windows,
 * so a multi-line pattern matches nothing and the test passes for the wrong reason.
 */
function readSource(relative: string): string {
  // DESKTOP_GUARD_ROOT replays these against another tree — an export of HEAD — so
  // the guards can be PROVEN to fail on the pre-change code rather than assumed to.
  const root = process.env.DESKTOP_GUARD_ROOT || join(__dirname, "..");
  return readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

/** Comment-stripped: these files DOCUMENT the shapes they forbid. */
function executableLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

test("main.ts gives registerPhoneSetup somewhere to log", () => {
  const code = executableLines(readSource("main.ts"));

  const call = /registerPhoneSetup\(\s*\{([\s\S]*?)\}\s*\)/.exec(code);
  assert.ok(call, "main.ts must still call registerPhoneSetup");
  assert.match(
    call[1],
    /\blog\s*:/,
    "registerPhoneSetup must be passed a log — without it the whole subsystem is silent",
  );
  assert.match(call[1], /diag\(\s*["']phoneSetup["']/, "it should log under the phoneSetup tag");
});

test("mainWiring passes its log down to BOTH the resident and the capability", () => {
  const code = executableLines(readSource("phoneSetup/mainWiring.ts"));

  assert.match(
    code,
    /createPnpResident\(\{[^}]*log:\s*deps\.log/,
    "the standing listener must log — it is the thing that hears a phone announce",
  );
  assert.match(
    code,
    /createPhoneCapability\(\{[\s\S]*?log:\s*deps\.log[\s\S]*?\}\)/,
    "the capability must log — it is the thing that performs every operation",
  );
});

test("every operation is logged from one wrapper, not per return path", () => {
  const code = executableLines(readSource("phoneSetup/capability.ts"));

  // The dispatcher is wrapped: `run` delegates to `runInner`. That is what makes it
  // impossible for a new op — or a new refusal on an existing one — to be silent.
  assert.match(code, /async function runInner\(/, "the dispatcher should be runInner, wrapped by run");
  assert.match(code, /await runInner\(req\)/, "run must delegate to runInner so one log site covers every path");
});

/**
 * ⛔⛔ THE SECRET IN THIS FLOW IS THE PROVISIONING FOLDER. Its path carries a 16-hex
 * tenant hash, and anything holding that URL can download that customer's SIP
 * passwords. A log file is something a customer opens, mails us, and pastes into a
 * ticket — so the URL may never reach one.
 */
test("a provisioning URL is reduced to its host, never logged whole", () => {
  const line = describeRequest({
    op: "set_provisioning",
    ip: "192.168.6.170",
    mac: "80:5E:C0:B3:B2:D0",
    url: "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
  } as OperationRequest);

  assert.match(line, /urlHost=m\.connectcomunications\.com/);
  assert.doesNotMatch(line, /f3df739ac62197cd/, "the tenant folder hash must never be written to a log");
  assert.doesNotMatch(line, /phoneprov/, "not even the path segment");
  // The parts that make a line useful are still there.
  assert.match(line, /ip=192\.168\.6\.170/);
  assert.match(line, /mac=805ec0b3b2d0/);
});

test("an unreadable URL says so rather than being echoed", () => {
  const line = describeRequest({ op: "arm_pnp", url: "not a url", macs: ["aa"] } as unknown as OperationRequest);
  assert.match(line, /urlHost=unreadable/);
  assert.doesNotMatch(line, /not a url/);
});

test("a refusal is logged with its reason", () => {
  assert.equal(describeResult({ ok: false, refused: "cannot_listen" }), "refused:cannot_listen");
});

test("set_provisioning logs the facts that explain a stall", () => {
  const line = describeResult({
    ok: true, op: "set_provisioning", listening: true,
    rebooted: false, rebootRefused: "unreachable",
    delivered: false, acknowledged: false, deliveredAt: null,
  });
  // Exactly the four facts that separate "waiting for a power-cycle" from "broken".
  assert.match(line, /listening=true/);
  assert.match(line, /rebooted=false/);
  assert.match(line, /rebootRefused=unreachable/);
  assert.match(line, /delivered=false/);
});

test("a logger that throws never changes an operation's outcome", async () => {
  const capability = createPhoneCapability({
    http: (async () => { throw new Error("not used"); }) as never,
    resolveCredential: async () => null,
    log: () => { throw new Error("the log file is full"); },
  });

  const res: OperationResult = await capability.run({ op: "reboot", ip: "10.0.0.5" } as OperationRequest);
  // Whatever it decided, it decided it — the throwing logger did not surface.
  assert.equal(typeof res.ok, "boolean");
});

test("a capability with no log at all still runs", async () => {
  const capability = createPhoneCapability({
    http: (async () => { throw new Error("not used"); }) as never,
    resolveCredential: async () => null,
  });
  const res: OperationResult = await capability.run({ op: "disarm_pnp" } as OperationRequest);
  assert.equal(res.ok, true);
});
