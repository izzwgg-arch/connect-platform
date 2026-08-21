// port_status — the assistant answering "when does my number move over?".
//
// The wording IS the feature here: this is read by a customer whose whole
// business runs on the number being moved, so the tests are mostly about what
// is said and what is deliberately NOT said (no promised date, no "you have no
// transfer" when we simply cannot see one).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPortStatusTools, classifyCarrierStatus, prettyNumber, summarisePort } from "./portStatusTools";
import { executeTool, toolsForRole, type ToolContext } from "./toolRegistry";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function row(prov: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    companyName: "Anymini",
    provisionedDid: "8452605692",
    answers: { phone: { choice: "port", details: { numbers: "646-984-6023" } }, provisioning: prov },
    ...over,
  };
}

// ── The carrier's own vocabulary ─────────────────────────────────────────────

test("only carrier statuses we have actually seen are classified; anything else is 'unknown'", () => {
  assert.equal(classifyCarrierStatus("completed"), "done");
  assert.equal(classifyCarrierStatus("Completed"), "done");
  assert.equal(classifyCarrierStatus("cancelled"), "stopped");
  assert.equal(classifyCarrierStatus("Rejected - account number mismatch"), "stopped");
  assert.equal(classifyCarrierStatus("foc_received"), "progressing");
  // ⛔ An invented mapping here is how a customer gets told a rejected transfer
  // is fine. Unrecognised means unrecognised.
  assert.equal(classifyCarrierStatus("wibble"), "unknown");
  assert.equal(classifyCarrierStatus(null), "unknown");
});

test("numbers are spoken, not recited as digits", () => {
  assert.equal(prettyNumber("6469846023"), "(646) 984-6023");
  assert.equal(prettyNumber("+16469846023"), "(646) 984-6023");
  assert.equal(prettyNumber("nope"), null);
});

// ── What the customer is told at each stage ──────────────────────────────────

test("filed with no date yet: says the date belongs to the other provider, and never invents one", () => {
  const v = summarisePort(row({ portFiled: true, portId: "217760", lastPortStatus: "submitted" }), {
    includeCarrierRef: false,
    now: NOW,
  });
  assert.equal(v.stage, "filed");
  assert.equal(v.scheduledDate, null);
  assert.equal(v.live, false);
  assert.equal(v.needsPerson, false);
  assert.doesNotMatch(v.summary, /\d{4}-\d{2}-\d{2}/, "no date may appear when none is known");
  assert.match(v.summary, /theirs to set/);
});

test("scheduled: gives the date, flags it as the other provider's, and names the temporary number", () => {
  const v = summarisePort(
    row({ portFiled: true, portId: "217760", portStatus: "foc_received", portStatusText: "FOC Received", portFocDate: "2026-09-14" }),
    { includeCarrierRef: false, now: NOW },
  );
  assert.equal(v.stage, "scheduled");
  assert.equal(v.scheduledDate, "2026-09-14");
  assert.equal(v.needsPerson, false);
  assert.match(v.summary, /2026-09-14/);
  assert.match(v.summary, /can still move/);
  assert.match(v.summary, /\(845\) 260-5692/, "they need to know what is answering meanwhile");
  assert.equal(v.temporaryNumberStillInUse, true);
});

test("a transfer due TODAY is not called late — the release date is a US calendar date and this clock is UTC", () => {
  const v = summarisePort(row({ portFiled: true, portFocDate: "2026-09-10" }), { includeCarrierRef: false, now: NOW });
  assert.equal(v.stage, "scheduled");
  assert.equal(v.needsPerson, false);
  // A full day of slack, so a timezone edge can never tell a customer their
  // transfer has slipped while it is still due.
  const yesterday = summarisePort(row({ portFiled: true, portFocDate: "2026-09-09" }), { includeCarrierRef: false, now: NOW });
  assert.equal(yesterday.stage, "scheduled");
  const older = summarisePort(row({ portFiled: true, portFocDate: "2026-09-08" }), { includeCarrierRef: false, now: NOW });
  assert.equal(older.stage, "overdue");
  assert.equal(older.needsPerson, true, "a slipped transfer should reach a person, not sit quietly");
});

test("handed over: says nothing is needed from the customer", () => {
  const v = summarisePort(
    row({ portFiled: true, portFocDate: "2026-09-08", portLanding: { routedAt: "2026-09-09T00:00:00.000Z", smsAt: "2026-09-09T00:00:01.000Z" } }),
    { includeCarrierRef: false, now: NOW },
  );
  assert.equal(v.stage, "moving");
  assert.equal(v.needsPerson, false);
  assert.equal(v.live, false);
  assert.match(v.summary, /Nothing is needed from you/);
});

test("handed over but the switch keeps failing: still 'moving', but a person is wanted", () => {
  const v = summarisePort(
    row({ portFiled: true, portLanding: { routedAt: "2026-09-09T00:00:00.000Z", failures: 4, lastError: "helper timeout" } }),
    { includeCarrierRef: false, now: NOW },
  );
  assert.equal(v.stage, "moving");
  assert.equal(v.needsPerson, true);
  // ⛔ Never leak our internal failure text to the customer.
  assert.doesNotMatch(v.summary, /helper timeout/);
});

test("live: says so, mentions the retired temporary number, and stops offering it", () => {
  const v = summarisePort(
    row({
      portFiled: true,
      portStatus: "completed",
      portLanding: { routedAt: "2026-08-13T00:06:39.701Z", tempRetiredAt: "2026-08-17T18:24:41.816Z", completedAt: "2026-08-17T18:24:41.859Z" },
    }),
    { includeCarrierRef: false, now: NOW },
  );
  assert.equal(v.stage, "live");
  assert.equal(v.live, true);
  assert.equal(v.temporaryNumberStillInUse, false);
  assert.match(v.summary, /live on Connect/);
  assert.doesNotMatch(v.summary, /In the meantime/);
});

test("rejected: named as needing a person, with the usual cause, and never as 'in progress'", () => {
  const v = summarisePort(
    row({ portFiled: true, portStatus: "Rejected - account number mismatch", portStatusText: "Rejected - account number mismatch", portFocDate: "2026-09-14" }),
    { includeCarrierRef: false, now: NOW },
  );
  assert.equal(v.stage, "stopped");
  assert.equal(v.needsPerson, true);
  assert.equal(v.live, false);
  assert.match(v.summary, /account number, PIN or service address/);
});

test("the carrier's order number is for staff, not the customer", () => {
  const prov = { portFiled: true, portId: "217760" };
  assert.equal(summarisePort(row(prov), { includeCarrierRef: false, now: NOW }).carrierOrderRef, undefined);
  assert.equal(summarisePort(row(prov), { includeCarrierRef: true, now: NOW }).carrierOrderRef, "217760");
});

test("real production shapes summarise without throwing (Matamim + inii mini, read live 2026-08-21)", () => {
  const matamim = summarisePort(
    {
      provisionedDid: "7244198226",
      answers: {
        phone: { details: { numbers: "9293598299" } },
        provisioning: {
          portId: "217946",
          portFiled: true,
          lastPortStatus: "completed",
          portLanding: { smsAt: "…", routedAt: "2026-08-13T00:06:39.701Z", completedAt: "2026-08-17T18:24:41.859Z", tempRetiredAt: "2026-08-17T18:24:41.816Z" },
        },
      },
    },
    { includeCarrierRef: true, now: NOW },
  );
  assert.equal(matamim.stage, "live");
  assert.equal(matamim.number, "(929) 359-8299");
  assert.equal(matamim.carrierOrderRef, "217946");
});

// ── The tool itself ──────────────────────────────────────────────────────────

function fakePrisma(rows: any[], seen: any[] = []) {
  return {
    onboardingSubmission: {
      findMany: async (args: any) => {
        seen.push(args);
        return rows;
      },
    },
  };
}

const CTX: ToolContext = { tenantId: "tenant1", role: "customer", clientUserId: "user1" };

test("the tenant is bound from the verified context — a model-supplied one is dropped, not used", async () => {
  const seen: any[] = [];
  const tools = buildPortStatusTools({ prisma: fakePrisma([row({ portFiled: true, portFocDate: "2026-09-14" })], seen) });
  const r = await executeTool(tools, "port_status", { tenantId: "someone-else", extension: "101" }, CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0].where, { createdTenantId: "tenant1" });
  assert.ok(r.droppedArgs.includes("tenantId"), "an invented tenant must be reported, not silently ignored");
});

test("nothing on record says exactly that — NOT 'you have no transfer in progress'", async () => {
  const tools = buildPortStatusTools({ prisma: fakePrisma([]) });
  const r: any = (await executeTool(tools, "port_status", {}, CTX)).content;
  assert.equal(r.found, false);
  // Connect only sees transfers filed through sign-up; one arranged by hand for
  // an existing customer is structurally invisible. Telling that customer they
  // have no transfer would be a confident falsehood.
  assert.match(r.message, /no number transfer on record/i);
  assert.match(r.message, /arranged directly/i);
  assert.doesNotMatch(r.message, /you (do not|don't) have/i);
});

test("a sign-up that bought a new number is not reported as a transfer", async () => {
  const newNumber = { provisionedDid: "8452605692", answers: { phone: { choice: "new" }, provisioning: { e911: {} } } };
  const tools = buildPortStatusTools({ prisma: fakePrisma([newNumber]) });
  const r: any = (await executeTool(tools, "port_status", {}, CTX)).content;
  assert.equal(r.found, false);
});

test("it is a customer-tier read, and a plain user's answer carries no carrier reference", async () => {
  const tools = buildPortStatusTools({ prisma: fakePrisma([row({ portFiled: true, portId: "217760" })]) });
  assert.equal(toolsForRole(tools, "customer").length, 1, "the person whose number is moving must be able to ask");

  const asCustomer: any = (await executeTool(tools, "port_status", {}, CTX)).content;
  assert.equal(asCustomer.ports[0].carrierOrderRef, undefined);
  const asAdmin: any = (await executeTool(tools, "port_status", {}, { ...CTX, role: "internal" })).content;
  assert.equal(asAdmin.ports[0].carrierOrderRef, "217760");
});

// ── Wiring guards ────────────────────────────────────────────────────────────
// ⛔ The defect shape in this repo is a CALLER: a tool that exists and is never
// handed to the model, or a prompt that still tells the model it cannot help.
// A unit test of the summariser passes straight through both.

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

test("the tool is actually handed to the chat model", () => {
  const src = read("../server.ts");
  assert.match(src, /buildPortStatusTools\s*\(\s*\{\s*prisma\s*\}\s*\)/, "must be built into chatTools");
  assert.match(src, /import \{ buildPortStatusTools \} from "\.\/tools\/portStatusTools"/);
});

test("the system prompt tells the model to look a transfer up instead of passing it to the team", () => {
  const src = read("../conversation/engine.ts");
  assert.match(src, /port_status/, "the prompt must name the tool");
  // The catch-all ('EVERYTHING ELSE … passed to the human team') is what used to
  // turn every port question into a text message to the owner.
  assert.match(src, /never pass these to the team unanswered/i);
  assert.match(src, /NEVER promise a date/);
});

test("the tool never reaches for the carrier itself", () => {
  // ⛔ Answering from Connect's own mirror is the whole design: no carrier
  // credentials in the agent, and a chat question that cannot hang on VoIP.ms.
  const src = read("./portStatusTools.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["voip.ms", "getLNPStatus", "getLNPList", "loadMasterCreds", "fetch("]) {
    assert.ok(!src.includes(forbidden), `port_status must not reach the carrier (found ${forbidden})`);
  }
});
