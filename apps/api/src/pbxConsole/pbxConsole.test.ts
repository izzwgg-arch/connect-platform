import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForm, applyOverrides } from "./panelForm";
import { deviceOverrides, DEVICE_FIELDS, type DeviceSpec } from "./pbxConsoleWrites";
import { type ParsedForm } from "./panelForm";

/**
 * ⛔ Strip comments before ANY negative or shape match on source. Three times in
 * this repo a guard has failed against CORRECT code because it matched the old
 * pattern quoted in the doc comment that explains the fix.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");

/* A minimal rendered form: a text field, a select, a multi-select, two checkboxes
   (one on, one off), and a select whose value lives in data-selected. */
const FORM_HTML = `
<form>
  <input type="hidden" name="class" value="extensions">
  <input type="text" name="name" value="Joel">
  <select name="class_of_service_id"><option value="105" selected>All</option><option value="1">Other</option></select>
  <select name="outbound_profiles[]" multiple><option value="214" selected>A</option><option value="5" selected>B</option><option value="9">C</option></select>
  <input type="checkbox" name="call_waiting" value="1" checked>
  <input type="checkbox" name="nospy" value="1">
  <select name="brand_id" data-selected="6"><option value="">-- Select One --</option><option value="6">Yealink</option><option value="9">Polycom</option></select>
</form>`;

test("parseForm: checkbox on posts, checkbox off is absent, multi keeps every selected, data-selected wins", () => {
  const f = parseForm(FORM_HTML);
  assert.equal(f.values.name, "Joel");
  assert.equal(f.values.class_of_service_id, "105");
  assert.equal(f.values.brand_id, "6", "data-selected value must be honoured, not the first option");
  assert.deepEqual(f.multi["outbound_profiles[]"], ["214", "5"]);
  assert.equal(f.checks.call_waiting.checked, true);
  assert.equal(f.checks.nospy.checked, false);
  const posted = new Map(f.pairs);
  assert.ok(f.pairs.some(([k, v]) => k === "call_waiting" && v === "1"), "a ticked checkbox posts its value");
  assert.ok(!f.pairs.some(([k]) => k === "nospy"), "⛔ an unticked checkbox must NOT be posted");
  assert.equal(f.pairs.filter(([k]) => k === "outbound_profiles[]").length, 2, "one pair per selected multi option");
  assert.equal(posted.get("brand_id"), "6");
});

test("applyOverrides: turning a checkbox OFF removes its pair; ON adds it; a value=no would tick, so we never send one", () => {
  const f = parseForm(FORM_HTML);
  const offPairs = applyOverrides(f, { checks: { call_waiting: false } });
  assert.ok(!offPairs.some(([k]) => k === "call_waiting"), "⛔ off = the pair is REMOVED, never call_waiting=no");
  const onPairs = applyOverrides(f, { checks: { nospy: true } });
  assert.ok(onPairs.some(([k, v]) => k === "nospy" && v === "1"), "on adds the pair with the form's own on-value");
});

test("applyOverrides: a multi-select is fully replaced, never appended", () => {
  const f = parseForm(FORM_HTML);
  const pairs = applyOverrides(f, { multi: { "outbound_profiles[]": ["9"] } });
  const vals = pairs.filter(([k]) => k === "outbound_profiles[]").map(([, v]) => v);
  assert.deepEqual(vals, ["9"], "the old 214/5 selection must be gone, not merged");
});

function devForm(kind: "pjsip" | "webrtc" | "virtual"): ParsedForm {
  const html = `<form>
    <input type="hidden" name="device_id" value="new">
    <input type="text" name="user" value="">
    <input type="text" name="secret" value="genpw">
    <select name="profile_id"><option value="1" selected>Default PJSIP Profile</option><option value="12">Default WebRTC Profile</option></select>
    <input type="text" name="max_contacts" value="">
    <select name="dtmfmode"><option value="rfc2833" selected>rfc2833</option><option value="info">info</option></select>
    <input type="checkbox" name="ring_device" value="yes" checked>
    <input type="checkbox" name="vitxi_client" value="1">
    <input type="text" name="number" value="">
  </form>`;
  return parseForm(html);
}

test("deviceOverrides: a WebRTC device gets rfc2833 and vitxi_client; a desk phone gets rfc4733 and no vitxi", () => {
  const f = devForm("pjsip");
  const web = deviceOverrides({ id: null, kind: "webrtc" } as DeviceSpec, f, { pjsip: "1", webrtc: "12", iax: "1" });
  assert.equal(web.set!.dtmfmode, "rfc2833", "the app device uses rfc2833");
  assert.equal(web.set!.vitxi_client, "1");
  assert.equal(web.set!.profile_id, "12");
  const desk = deviceOverrides({ id: null, kind: "pjsip" } as DeviceSpec, f, { pjsip: "1", webrtc: "12", iax: "1" });
  assert.equal(desk.set!.dtmfmode, "rfc4733", "⛔ a desk phone posts rfc4733 — the form has no rfc4733 option, so re-posting the raw value would flip it to rfc2833");
  assert.ok(desk.drop!.includes("vitxi_client"));
});

test("deviceOverrides: a virtual device carries ONLY a phone number — no profile/codecs/max_contacts", () => {
  const f = devForm("virtual");
  const ov = deviceOverrides({ id: null, kind: "virtual", number: "(845) 555-1212" } as DeviceSpec, f, { pjsip: "1", webrtc: "12", iax: "1" });
  assert.equal(ov.set!.technology, "virtual");
  assert.equal(ov.set!.number, "8455551212", "the number is digits-only");
  assert.ok(ov.drop!.includes("profile_id") && ov.drop!.includes("max_contacts") && ov.drop!.includes("vitxi_client"));
  assert.equal(ov.set!.dtmfmode, "rfc2833");
});

/* Source guards — these are CALLER-side promises that a unit test of the helper
   would pass straight through. */
test("source: every console write route is SUPER_ADMIN-gated (requireOwner) and applies + re-bakes", () => {
  const routes = norm(readFileSync(join(__dirname, 'pbxConsoleRoutes.ts'), 'utf8'));
  // every handler opens with requireOwner
  // every route either gates inline OR delegates to handleDeleteExtension (which gates)
  const delegating = (routes.match(/=> handleDeleteExtension\(req, reply/g) || []).length;
  const handlers = (routes.match(/app\.(get|post|patch|delete)\(/g) || []).length;
  const owners = (routes.match(/const admin = await requireOwner\(req, reply\); if \(!admin\) return;/g) || []).length;
  assert.ok(owners + delegating >= handlers, `every route must gate with requireOwner (${owners} inline + ${delegating} delegated for ${handlers} routes)`);
  assert.match(routes, /const handleDeleteExtension = async \(req: any, reply: any, force: boolean\) => \{\s*const admin = await requireOwner/, "the shared delete handler must gate");
  // writes go through withPanel, which applies + re-bakes
  assert.match(routes, /applyAndRebake\(s, applyTenantPath/, "withPanel must apply + re-bake after a write");
  assert.doesNotMatch(routes, /minRole:\s*["']customer["']/, "the console is never exposed to customers");
});

test("source: server.ts registers the console and gates the prefix; writes carry the doorway re-bake", () => {
  const server = norm(readFileSync(join(__dirname, "..", "server.ts"), "utf8"));
  assert.match(server, /registerPbxConsoleRoutes\(\{/, "console routes must be registered");
  assert.match(server, /\{\s*prefix:\s*"\/admin\/pbx-console",\s*permission:\s*"can_manage_global_settings"\s*\}/, "the /admin/pbx-console prefix must be in PORTAL_API_PERMISSION_RULES");
  const writes = norm(readFileSync(join(__dirname, "pbxConsoleWrites.ts"), "utf8"));
  assert.match(writes, /rebakeConnectRoutesAfterRegen/, "applyAndRebake must re-bake the Connect doorway (2026-08-13 dead-air incident)");
  // a general-only extension save is refused — it would re-post the raw device fields and flip DTMF
  assert.match(writes, /an extension save must carry its devices/);
});

test("DEVICE_FIELDS separates the device sub-form from the general form", () => {
  assert.ok(DEVICE_FIELDS.has("technology") && DEVICE_FIELDS.has("dtmfmode") && DEVICE_FIELDS.has("device_id"));
  assert.ok(!DEVICE_FIELDS.has("name") && !DEVICE_FIELDS.has("class_of_service_id"), "general fields are not device fields");
});

/*
 * ⛔ A REFUSAL MUST NOT READ AS A CRASH. The geo rebuild needs root, so the
 * helper refuses — and that came back as a 500, which tells the person at the
 * screen the app is broken and sends them hunting a bug instead of doing the
 * one setup step. This reads the route file's SOURCE because the defect is in
 * how the handler ANSWERS, which a unit test of any helper passes straight
 * through. Comments are stripped first: the doc block above the fix quotes the
 * old shape, and a naive scan matches that and passes on broken code.
 */
test("a known refusal answers 409 with a sentence, never 500", () => {
  const src = stripComments(norm(readFileSync(join(__dirname, 'pbxConsoleRoutes.ts'), 'utf8')));
  assert.match(src, /geo_build_not_permitted/, "the geo refusal must be recognised by name");
  assert.match(src, /status\(409\)[\s\S]{0,120}pbx_console_refused/, "a refusal answers 409");
  // and it must carry a plain-English sentence, not the raw helper slug
  assert.match(src, /rebuilding the firewall runs as root/, "the message must be in plain English");
  // the refusal is checked BEFORE the generic 500, or it can never be reached
  const refusalAt = src.indexOf("pbx_console_refused");
  const genericAt = src.indexOf("pbx_console_write_failed", refusalAt);
  assert.ok(refusalAt > 0 && genericAt > refusalAt, "the refusal branch must come first");
});

/*
 * ⛔ TENANT CREATE IS THE ONE JOB THE UNLICENSED PANEL REFUSES, and the whole
 * point of routing it through the mirror is that it keeps working after the
 * licence ends. A future "simplification" that posts the panel's add-tenant
 * form here would pass every functional test today (the licence is still live)
 * and fail silently on the day it lapses — which is exactly the day nobody can
 * afford to discover it. These read the route file's SOURCE for that reason.
 */
test("source: creating a tenant goes through the MIRROR, never the panel form", () => {
  const src = stripComments(norm(readFileSync(join(__dirname, "pbxConsoleRoutes.ts"), "utf8")));
  const create = src.slice(src.indexOf('app.post("/admin/pbx-console/tenants"'));
  assert.ok(create.length > 200, "the create route must exist");
  const body = create.slice(0, create.indexOf('app.patch("/admin/pbx-console/tenants/:id"'));
  assert.match(body, /resolveMirrorTenantCreator\(/, "create must use the mirror creator");
  // ⛔ never the panel add form: those are the pairs the panel's add-tenant post carries
  assert.doesNotMatch(body, /\["mode",\s*"add"\]/, "create must not post the panel add-tenant form");
  assert.doesNotMatch(body, /withPanel\(/, "create must not open a panel session at all");
});

test("source: the create route reuses onboarding's slug rule rather than inventing one", () => {
  const src = stripComments(norm(readFileSync(join(__dirname, "pbxConsoleRoutes.ts"), "utf8")));
  // the PBX name is matched elsewhere by slug OR display name, so a second
  // slug variant would create tenants those lookups cannot find
  assert.match(src, /import \{ slugify \} from "\.\.\/onboarding\/pbxTenantBuild"/, "must import the one slug rule");
  assert.doesNotMatch(src, /function\s+normaliseTenantSlug|const\s+normaliseTenantSlug/, "must not define a second slug rule");
});

test("source: a duplicate customer is refused by name, before anything is written", () => {
  const src = stripComments(norm(readFileSync(join(__dirname, "pbxConsoleRoutes.ts"), "utf8")));
  const create = src.slice(src.indexOf('app.post("/admin/pbx-console/tenants"'));
  const body = create.slice(0, create.indexOf('app.patch("/admin/pbx-console/tenants/:id"'));
  const clashAt = body.indexOf("tenant_exists");
  const createAt = body.indexOf("await creator(");
  assert.ok(clashAt > 0, "a duplicate must be refused by name");
  assert.ok(createAt > clashAt, "the duplicate check must run BEFORE the tenant is created");
});

test("source: the create does NOT re-render, because it cannot and need not", () => {
  const src = stripComments(norm(readFileSync(join(__dirname, "pbxConsoleRoutes.ts"), "utf8")));
  const create = src.slice(src.indexOf('app.post("/admin/pbx-console/tenants"'));
  const body = create.slice(0, create.indexOf('app.patch("/admin/pbx-console/tenants/:id"'));
  /*
   * ⛔ Two independent reasons, and BOTH have to keep holding for this to stay
   * right, which is why the guard is here rather than a comment alone:
   *  - redundant: this route writes nothing after the create, so the baseline
   *    the mirror renders IS the final state (onboarding differs — it keeps
   *    adding rows, which is why IT re-renders at the end);
   *  - impossible: the render hands each file to www-data with an ACL mask of
   *    r--, and the helper runs as asterisk, so a second pass gets EACCES on
   *    the file it just wrote. Proven on prod (tenant 119).
   */
  assert.doesNotMatch(body, /resolveMirrorTenantRenderer/, "the create must not re-render");
});
