import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Normalise line endings so the `;\n` matches below hold on a Windows (CRLF) checkout too.
const readSrc = (name: string) => readFileSync(join(__dirname, name), "utf8").replace(/\r\n/g, "\n");
const src = readSrc("supportReport.ts");
const serverSrc = readSrc("server.ts");
const dispatchSrc = readSrc("agentEscalationDispatch.ts");
const bypassSrc = readSrc("jwtPublicRouteBypass.ts");

test("the route is actually registered — a module nobody calls files nothing", () => {
  // The defect class here is a CALLER, not a function: `registerSupportReportRoutes`
  // can be perfect and unreachable. Same shape as the invite email that lost its
  // APK link on one of two paths.
  assert.match(serverSrc, /import \{ registerSupportReportRoutes \} from "\.\/supportReport"/);
  assert.match(serverSrc, /registerSupportReportRoutes\(app, \{ smsQueue \}\)/);
});

test("filing a report ends at the SAME escalation row the owner's phone already reads", () => {
  // A second delivery path would be a second thing to keep working and the
  // first one to rot. Everything here must end at an AgentEscalation row.
  assert.match(src, /agentEscalation\.create\(/);
  assert.match(src, /status: "QUEUED"/);
  assert.match(dispatchSrc, /status: \{ in: \["QUEUED", "FAILED"\] \}/);
  // and it must NOT grow its own sender
  assert.doesNotMatch(src, /resolvePlatformSmsSender/, "delivery to the owner belongs to the dispatcher");
  assert.doesNotMatch(src, /emailJob\.create/, "the email belongs to the dispatcher");
});

test("the row and its text are written in one transaction", () => {
  // The reference is derived from the row's own id, so a placeholder exists for
  // an instant. The dispatcher sweeps every 30s; outside a transaction it can
  // read that placeholder and text the owner an empty report.
  assert.match(src, /db\.\$transaction\(async \(tx\) => \{/);
  const tx = src.slice(src.indexOf("db.$transaction"), src.indexOf("} catch (err: any)"));
  assert.match(tx, /agentEscalation\.create\(/);
  assert.match(tx, /agentEscalation\.update\(/);
  assert.match(tx, /supportReportReference\(created\.id\)/);
});

test("the escalation is written BEFORE anything is said to the customer", () => {
  // Failure direction: losing the report is unrecoverable; a missing
  // confirmation text is not. Confirming first and then failing to record it
  // would tell someone their dead phone system had been reported when it
  // had not.
  const filed = src.indexOf("db.$transaction");
  const texted = src.indexOf("sendConnectChatSmsMessage(");
  assert.ok(filed > 0 && texted > 0);
  assert.ok(filed < texted, "the report must be filed before the customer is told anything");
});

test("the text thread lives on the support desk's tenant, never the customer's", () => {
  // A thread on the customer's tenant would send from THEIR number — the
  // customer texting themselves — and would sit in an inbox their colleagues
  // can read.
  const block = src.slice(src.indexOf("async function resolveSupportDesk"), src.indexOf("function personName"));
  assert.match(block, /tenantSmsNumber\.findFirst/);
  assert.match(block, /phoneE164/);
  assert.match(block, /role: "SUPER_ADMIN"/);
  assert.match(src, /findOrCreateConnectChatSmsThread\(\{\s*tenantId: desk\.tenantId/);
  assert.doesNotMatch(src, /findOrCreateConnectChatSmsThread\(\{\s*tenantId: user\.tenantId/);
});

test("no support desk, a failed thread or a failed text can never lose the report", () => {
  const tail = src.slice(src.indexOf("let confirmationTexted"));
  assert.match(tail, /try \{/);
  assert.match(tail, /catch \(err: any\)/);
  // the desk resolver fails soft
  assert.match(src, /return null;\n\s*\/\/ A SUPER_ADMIN if that tenant has one/);
  // the follow-up write and the audit row are both allowed to fail
  assert.match(tail, /\.catch\(\(\) => undefined\)/);
});

test("both rate limits answer with a way to reach a person, not a bare refusal", () => {
  assert.match(src, /PER_USER_LIMIT/);
  assert.match(src, /PER_TENANT_LIMIT/);
  assert.match(src, /status\(429\)/);
  const refusal = src.slice(src.indexOf("too_many_reports"), src.indexOf("too_many_reports") + 400);
  assert.match(refusal, /845\) 723-1213/, "someone hitting this limit already has a problem — give them the number");
});

test("validation failures speak plain English, never a code", () => {
  // The portal renders the server's `message` field verbatim; a raw zod throw
  // shows the customer a slug at the exact moment something else is broken.
  assert.match(src, /safeParse/);
  assert.doesNotMatch(src, /\)\s*\.parse\(req\.body/);
  assert.match(src, /Please tell us a little more about what's happening\./);
  assert.match(src, /doesn't look like a US phone number/);
  const failure = src.slice(src.indexOf("report_not_filed"), src.indexOf("report_not_filed") + 300);
  assert.match(failure, /845\) 723-1213/, "if we cannot file it, tell them how to reach us");
});

test("the report routes are NOT in the unauthenticated bypass list", () => {
  // These carry a customer's own words and reach the owner's phone. A door in
  // the bypass list would let anyone on the internet text him.
  assert.doesNotMatch(bypassSrc, /\/support\/report/);
  assert.doesNotMatch(bypassSrc, /\/support\/context/);
  assert.match(src, /status\(401\)\.send\(\{ error: "unauthorized" \}\)/);
});

test("tenant and identity come from the token, never from the request body", () => {
  const body = src.slice(src.indexOf(".safeParse"), src.indexOf("const input = parsed.data"));
  assert.doesNotMatch(body, /tenantId/);
  assert.doesNotMatch(body, /userName/);
  assert.match(src, /tenantId: user\.tenantId/);
  assert.match(src, /clientUserId: user\.sub/);
});
