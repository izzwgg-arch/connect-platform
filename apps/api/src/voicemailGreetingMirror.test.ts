import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  busyGreetingIsOurs,
  mirrorUnavailableGreetingToBusy,
  resetGreetingWithBusyMirror,
  type GreetingMirrorDeps,
} from "./voicemailGreetingMirror";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** In-memory mailbox: greetingType -> bytes. */
function fakeMailbox(initial: Record<string, Buffer>) {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  const deps: GreetingMirrorDeps = {
    get: async (_cfg, body) => {
      const f = files.get(body.greetingType);
      return {
        ok: true, tenantId: body.tenantId, extension: body.extension, greetingType: body.greetingType,
        active: Boolean(f), sha256: f ? sha(f) : null, bytesB64: f && body.includeBytes ? f.toString("base64") : undefined,
      };
    },
    upload: async (_cfg, body) => {
      calls.push(`upload:${body.greetingType}`);
      const bytes = Buffer.from(body.bytesB64, "base64");
      assert.equal(sha(bytes), body.sha256);
      files.set(body.greetingType, bytes);
      return { ok: true, tenantId: body.tenantId, extension: body.extension, greetingType: body.greetingType, active: true };
    },
    reset: async (_cfg, body) => {
      calls.push(`reset:${body.greetingType}`);
      files.delete(body.greetingType);
      return { ok: true, tenantId: body.tenantId, extension: body.extension, greetingType: body.greetingType, active: false };
    },
  };
  return { files, calls, deps };
}

const cfg = {} as any;
const A = Buffer.from("RIFF-old-greeting");
const B = Buffer.from("RIFF-new-greeting");
const DISTINCT = Buffer.from("RIFF-busy-set-from-the-phone-menu");

test("busyGreetingIsOurs — absent busy is ours, a copy of the old greeting is ours, anything else is not", () => {
  assert.equal(busyGreetingIsOurs({ active: false }, null), true);
  assert.equal(busyGreetingIsOurs(null, "abc"), true);
  assert.equal(busyGreetingIsOurs({ active: true, sha256: "ABC" }, "abc"), true);
  assert.equal(busyGreetingIsOurs({ active: true, sha256: "abc" }, "def"), false);
  assert.equal(busyGreetingIsOurs({ active: true, sha256: "abc" }, null), false);
});

test("mirror — creates busy.wav when the mailbox has none (the 3GTH9M case)", async () => {
  const m = fakeMailbox({ unavailable: B });
  const r = await mirrorUnavailableGreetingToBusy(m.deps, cfg, { tenantId: "18", extension: "101", previousUnavailableSha: null, bytes: B });
  assert.deepEqual(r, { busyMirrored: true, busyMirrorReason: "created" });
  assert.equal(sha(m.files.get("busy")!), sha(B));
});

test("mirror — replaces a busy.wav that was a copy of the previous greeting", async () => {
  const m = fakeMailbox({ unavailable: B, busy: A });
  const r = await mirrorUnavailableGreetingToBusy(m.deps, cfg, { tenantId: "18", extension: "101", previousUnavailableSha: sha(A), bytes: B });
  assert.equal(r.busyMirrorReason, "replaced_previous_copy");
  assert.equal(sha(m.files.get("busy")!), sha(B));
});

test("mirror — NEVER overwrites a distinct busy greeting set on purpose", async () => {
  const m = fakeMailbox({ unavailable: B, busy: DISTINCT });
  const r = await mirrorUnavailableGreetingToBusy(m.deps, cfg, { tenantId: "18", extension: "106", previousUnavailableSha: sha(A), bytes: B });
  assert.deepEqual(r, { busyMirrored: false, busyMirrorReason: "distinct_busy_greeting_kept" });
  assert.equal(sha(m.files.get("busy")!), sha(DISTINCT));
  assert.deepEqual(m.calls, []);
});

test("mirror — reads the recorded greeting from the PBX when no bytes are given (call-to-record)", async () => {
  const m = fakeMailbox({ unavailable: B });
  const r = await mirrorUnavailableGreetingToBusy(m.deps, cfg, { tenantId: "18", extension: "101", previousUnavailableSha: null });
  assert.equal(r.busyMirrorReason, "created");
  assert.equal(sha(m.files.get("busy")!), sha(B));
});

test("mirror — a helper failure is reported, never thrown", async () => {
  const m = fakeMailbox({ unavailable: B });
  m.deps.upload = async () => { throw new Error("helper down"); };
  const r = await mirrorUnavailableGreetingToBusy(m.deps, cfg, { tenantId: "18", extension: "101", previousUnavailableSha: null, bytes: B });
  assert.equal(r.busyMirrorReason, "error");
  assert.equal(r.busyMirrorError, "helper down");
});

test("reset — removes busy.wav only when it is a copy of the unavailable greeting", async () => {
  const mirrored = fakeMailbox({ unavailable: B, busy: B });
  assert.deepEqual(await resetGreetingWithBusyMirror(mirrored.deps, cfg, { tenantId: "18", extension: "101", greetingType: "unavailable" }), { busyMirrorReset: true });
  assert.equal(mirrored.files.size, 0);

  const distinct = fakeMailbox({ unavailable: B, busy: DISTINCT });
  assert.deepEqual(await resetGreetingWithBusyMirror(distinct.deps, cfg, { tenantId: "18", extension: "106", greetingType: "unavailable" }), { busyMirrorReset: false });
  assert.equal(sha(distinct.files.get("busy")!), sha(DISTINCT));
  assert.deepEqual(distinct.calls, ["reset:unavailable"]);
});

test("reset — a non-unavailable reset never touches busy.wav and still throws on failure", async () => {
  const m = fakeMailbox({ unavailable: B, busy: B });
  await resetGreetingWithBusyMirror(m.deps, cfg, { tenantId: "18", extension: "101", greetingType: "name" });
  assert.deepEqual(m.calls, ["reset:name"]);
  m.deps.reset = async () => { throw new Error("pbx refused"); };
  await assert.rejects(resetGreetingWithBusyMirror(m.deps, cfg, { tenantId: "18", extension: "101", greetingType: "unavailable" }), /pbx refused/);
});

// Source guard: the defect was WHICH paths wrote the greeting, so a unit test of
// the module alone passes straight through it being unwired again.
const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");

test("source guard — every save and reset path goes through the busy mirror", () => {
  const server = read("server.ts");
  const upload = server.slice(server.indexOf("async function handleVoicemailGreetingUpload"), server.indexOf('app.post("/voice/extensions/me/voicemail-greeting"'));
  assert.match(upload, /mirrorUnavailableGreetingToBusy\(/, "upload must mirror to busy.wav");
  const resets = server.match(/resetGreetingWithBusyMirror\(pbxGreetingMirrorDeps/g) || [];
  assert.equal(resets.length, 2, "both reset routes must use resetGreetingWithBusyMirror");
  assert.doesNotMatch(server, /await resetPbxVoicemailGreeting\(/, "no reset may bypass the mirror");
  assert.match(read("vmRecordCallJobs.ts"), /mirrorUnavailableGreetingToBusy\(/, "call-to-record must mirror to busy.wav");
});
