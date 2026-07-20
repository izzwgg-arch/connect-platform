import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProvisioningPlan } from "./provisioningPlan";

test("builds tenant + N extension steps in order", () => {
  const p = buildProvisioningPlan({
    tenantName: "Feldman Medical",
    tenantEmail: "office@feldman.com",
    extensions: [
      { name: "Moshe", email: "moshe@feldman.com" },
      { name: "Rivky", email: "rivky@feldman.com" },
      { name: "Front Desk", extension: "100" },
    ],
  });
  assert.equal(p.ok, true);
  assert.equal(p.steps.length, 4); // tenant + 3 ext
  assert.equal(p.steps[0].opId, "P1");
  assert.equal(p.steps[0].feasibility, "api");
  assert.ok(p.steps.slice(1).every((s) => s.opId === "P4" && s.feasibility === "helper" && s.dependsOn === 1));
});

test("auto-assigns extension numbers, honoring explicit ones and avoiding collisions", () => {
  const p = buildProvisioningPlan({
    tenantName: "T",
    startExtension: 101,
    extensions: [{ name: "A" }, { name: "B", extension: "102" }, { name: "C" }],
  });
  const nums = p.steps.slice(1).map((s) => s.params.extension);
  assert.deepEqual(nums, ["101", "102", "103"]);
  // 'C' must skip 102 (taken by B) — got 103
});

test("warns when an extension has no email", () => {
  const p = buildProvisioningPlan({ tenantName: "T", extensions: [{ name: "NoEmail" }] });
  assert.ok(p.warnings.some((w) => /no email/.test(w)));
});

test("voicemail-to-email defaults ON when email present, OFF when absent", () => {
  const p = buildProvisioningPlan({ tenantName: "T", extensions: [{ name: "A", email: "a@x.com" }, { name: "B" }] });
  const a = p.steps.find((s) => (s.params as any).name === "A")!;
  const b = p.steps.find((s) => (s.params as any).name === "B")!;
  assert.equal((a.params as any).voicemailToEmail, true);
  assert.equal((a.params as any).voicemailAttach, true);
  assert.equal((b.params as any).voicemailToEmail, false);
  assert.match(a.summary, /voicemail→email/);
});

test("voicemail-to-email can be explicitly disabled; AI transcription opt-in", () => {
  const p = buildProvisioningPlan({
    tenantName: "T",
    extensions: [
      { name: "NoVM", email: "n@x.com", voicemailToEmail: false },
      { name: "Transcribed", email: "t@x.com", voicemailTranscribe: true },
    ],
  });
  const novm = p.steps.find((s) => (s.params as any).name === "NoVM")!;
  const tr = p.steps.find((s) => (s.params as any).name === "Transcribed")!;
  assert.equal((novm.params as any).voicemailToEmail, false);
  assert.equal((tr.params as any).voicemailTranscribe, true);
  assert.match(tr.summary, /AI transcribed/);
});

test("rejects malformed input", () => {
  assert.equal(buildProvisioningPlan({ extensions: [] }).ok, false); // missing tenantName
  assert.equal(buildProvisioningPlan({ tenantName: "T", extensions: [{ name: "X", email: "not-an-email" }] }).ok, false);
});

test("every extension step is feasibility=helper (extensions aren't API-creatable)", () => {
  const p = buildProvisioningPlan({ tenantName: "T", extensions: [{ name: "A" }, { name: "B" }] });
  assert.ok(p.steps.filter((s) => s.opId === "P4").every((s) => s.feasibility === "helper"));
});
