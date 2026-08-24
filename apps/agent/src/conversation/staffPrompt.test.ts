/**
 * The staff prompt — the fix for "he told me that, for privacy, he can't do it".
 *
 * ⛔⛔ THE BUG THIS PINS: the tools and the tier were already right. Izzy asked
 * the Workbench dock to do something and it refused on privacy grounds, because
 * ONE system prompt served everybody and it said "you cannot do it yet" and
 * "never discuss other tenants or internal systems". A capability the prompt
 * denies is not a capability, and nothing in the tool layer can see that.
 *
 * So these are SOURCE guards. There is no behavioural test that can catch a
 * model being talked out of using a tool it holds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const engine = readFileSync(join(__dirname, "engine.ts"), "utf8").replace(/\r\n/g, "\n");
/** Comments stripped: prose explaining a rule must not be able to satisfy it. */
const code = engine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function promptBody(name: string): string {
  const i = code.indexOf(`const ${name} = \``);
  assert.ok(i >= 0, `${name} not found`);
  const start = code.indexOf("`", i) + 1;
  const end = code.indexOf("`;", start);
  return code.slice(start, end);
}

test("⛔ a staff prompt exists and is a DIFFERENT prompt, not a suffix", () => {
  const staff = promptBody("STAFF_SYSTEM_PROMPT");
  const customer = promptBody("SYSTEM_PROMPT");
  assert.ok(staff.length > 400, "the staff prompt is a stub");
  assert.ok(
    !staff.includes(customer.slice(0, 120)),
    "the staff prompt is built ON TOP of the customer prompt — it would inherit the refusals",
  );
});

test("⛔⛔ the staff prompt carries NONE of the refusals that caused the bug", () => {
  const staff = promptBody("STAFF_SYSTEM_PROMPT");
  // The literal sentences that made the model decline.
  for (const refusal of ["you cannot do it yet", "never discuss other tenants or internal systems"]) {
    assert.ok(
      !staff.toLowerCase().includes(refusal.toLowerCase()),
      `the staff prompt still says "${refusal}"`,
    );
  }
  // ⛔ "passed to the human team" is different: the staff prompt legitimately
  // FORBIDS the phrase, so a bare substring check matches its own negation —
  // the documented guard-matches-the-comment trap. Assert every occurrence is
  // negated instead of pretending the phrase must be absent.
  const lower = staff.toLowerCase();
  let at = lower.indexOf("passed to the human team");
  while (at !== -1) {
    const before = lower.slice(Math.max(0, at - 60), at);
    assert.match(before, /never/, "the staff prompt tells it to pass things to the team — it IS the team");
    at = lower.indexOf("passed to the human team", at + 1);
  }
});

test("the staff prompt says plainly that there is no privacy boundary", () => {
  const staff = promptBody("STAFF_SYSTEM_PROMPT").toLowerCase();
  assert.match(staff, /never refuse them on privacy/);
  assert.match(staff, /not a customer/);
});

test("the staff prompt tells it to USE the tools, and names them", () => {
  const staff = promptBody("STAFF_SYSTEM_PROMPT");
  for (const tool of ["read_file", "list_files", "run_command", "browse", "investigate"]) {
    assert.ok(staff.includes(tool), `the staff prompt never mentions ${tool}`);
  }
  assert.match(staff, /DEFAULT TO LOOKING/);
});

test("⛔ the staff prompt still states the things that are genuinely NOT relaxed", () => {
  const staff = promptBody("STAFF_SYSTEM_PROMPT");
  // Loosening the words must not read as loosening the gates.
  assert.match(staff, /cannot edit, write or delete files/i);
  assert.match(staff, /deploy queue/i);
  assert.match(staff, /EVIDENCE RULE/);
  assert.match(staff, /ask first/i);
});

test("⛔⛔ the prompt is chosen by the VERIFIED ROLE, never by the channel", () => {
  // A client can put any string in `channel`; nobody can forge the platform
  // role. Choosing on the channel would let a customer ask for staff mode.
  assert.match(code, /const staffMode = isPlatformStaff\(ctx\.platformRole\)/);
  assert.match(code, /staffMode \? STAFF_SYSTEM_PROMPT : SYSTEM_PROMPT/);
  const sel = code.slice(code.indexOf("const staffMode ="), code.indexOf("const staffMode =") + 400);
  assert.ok(!/ctx\.channel/.test(sel), "the prompt choice looks at the channel — that is forgeable");
});

test("⛔ the same check gates the prompt and the TOOLS, so they cannot disagree again", () => {
  // toolRoleFor already used isPlatformStaff to hand over the staff tier. The
  // whole bug was the prompt using a different (implicit) answer.
  assert.match(code, /if \(isPlatformStaff\(platformRole\)\) return "staff"/);
  assert.match(code, /isPlatformStaff\(ctx\.platformRole\)/);
});

test("the Yiddish bridge composes onto whichever prompt is in force", () => {
  // Previously the bridge was hardcoded onto the customer prompt, so a staff
  // caller on the bridge would have silently got the customer instructions.
  assert.match(code, /bridging \? bridgeSuffix\(basePrompt\) : basePrompt/);
  assert.match(code, /function bridgeSuffix\(base: string\)/);
});

test("⛔ staff are not called 'the customer' when a page is open", () => {
  const view = code.slice(code.indexOf("const viewingBlock ="), code.indexOf("const viewingBlock =") + 1400);
  assert.match(view, /isPlatformStaff\(ctx\.platformRole\)/, "the viewing block is not branched for staff");
  // And it must not tell staff the page is unreachable — browse opens it.
  assert.match(view, /browse tool/);
});

test("⛔⛔ the Workbench dock must NOT invent a channel — the enum would throw", () => {
  // AgentChannel is CHAT | EMAIL | WHATSAPP | SMS | PHONE and the store
  // upper-cases whatever arrives straight into it. A "workbench" channel makes
  // the conversation create throw and the dock stops answering at all.
  const wb = readFileSync(
    join(__dirname, "..", "..", "..", "portal", "app", "(platform)", "admin", "support", "SupportWorkbench.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const wbCode = wb.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const m = wbCode.match(/channel:\s*"([a-z]+)"/);
  assert.ok(m, "the dock stopped sending a channel");
  assert.equal(m![1], "chat", "the dock invented a channel value the AgentChannel enum does not have");
});

test("⛔ the enum really is what the guard above assumes (read from the schema)", () => {
  const schema = readFileSync(
    join(__dirname, "..", "..", "..", "..", "packages", "db", "prisma", "schema.prisma"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const block = schema.slice(schema.indexOf("enum AgentChannel"));
  const values = block.slice(0, block.indexOf("}")).match(/^\s{2}([A-Z_]+)\s*$/gm)!.map((v) => v.trim());
  assert.deepEqual(values.sort(), ["CHAT", "EMAIL", "PHONE", "SMS", "WHATSAPP"]);
});
