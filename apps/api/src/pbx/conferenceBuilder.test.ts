import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseForm, applyOverrides } from "../pbxConsole/panelForm";
import { buildConferenceOverrides } from "./conferenceBuilder";

/**
 * The conference builder never posts from a guessed field list — it re-posts
 * the panel's own rendered form with overrides. These tests drive the real
 * parse+override chain against a synthetic form that mixes the two control
 * shapes VitalPBX uses for yes/no options (checkbox vs select), because that
 * mix is exactly where the checkbox rule bites: `autofill=no` once STORED yes.
 *
 * Source guards read the module text with comments stripped (the doc comments
 * quote the wrong patterns they warn about) and CRLF normalised (Windows
 * checkouts are CRLF; a literal \n match silently stops matching).
 */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A synthetic "Add Conference" form: record_conference + startmuted render as
// CHECKBOXES (record starts checked), announce_join_leave + quiet render as
// SELECTS, and the scalars are plain inputs — the same split the queues form
// proved live (autofill/autopause checkboxes beside joinempty/leavewhenempty
// selects on one form).
const ADD_FORM_HTML = `
<form>
  <input type="text" name="extension" value="">
  <input type="text" name="description" value="">
  <input type="password" name="userpin" value="">
  <input type="password" name="adminpin" value="">
  <input type="number" name="max_members" value="">
  <input type="checkbox" name="record_conference" value="yes" checked>
  <input type="checkbox" name="startmuted" value="yes">
  <select name="announce_join_leave">
    <option value="yes">Yes</option>
    <option value="no" selected>No</option>
  </select>
  <select name="quiet">
    <option value="yes">Yes</option>
    <option value="no" selected>No</option>
  </select>
  <select name="music_on_hold_when_empty">
    <option value="yes" selected>Yes</option>
    <option value="no">No</option>
  </select>
  <input type="hidden" name="csfr_token" value="deadbeefdeadbeefdeadbeef">
</form>`;

const pairsToMap = (pairs: Array<[string, string]>) => new Map(pairs);

test("a yes/no option is routed by the control the form renders — checkbox vs select", () => {
  const form = parseForm(ADD_FORM_HTML);
  const { overrides } = buildConferenceOverrides(
    form,
    {
      name: "Sales stand-up",
      extension: "700",
      recordConference: true, // checkbox
      startMuted: true, // checkbox
      announceJoinLeave: true, // select — must carry a literal "yes"
      quiet: false, // select — must carry a literal "no"
    },
    { includeExtension: true },
  );
  const m = pairsToMap(applyOverrides(form, overrides));
  assert.equal(m.get("extension"), "700");
  assert.equal(m.get("description"), "Sales stand-up");
  assert.equal(m.get("record_conference"), "yes");
  assert.equal(m.get("startmuted"), "yes");
  assert.equal(m.get("announce_join_leave"), "yes");
  assert.equal(m.get("quiet"), "no");
});

test("⛔ the checkbox rule: switching a checkbox OFF removes the pair — never sends =no", () => {
  const form = parseForm(ADD_FORM_HTML);
  // record_conference renders CHECKED in the form; turning it off must delete
  // the pair. Sending record_conference=no would TICK it (the autofill trap).
  const { overrides } = buildConferenceOverrides(
    form,
    { name: "Quiet room", extension: "701", recordConference: false },
    { includeExtension: true },
  );
  const pairs = applyOverrides(form, overrides);
  assert.ok(!pairs.some(([k]) => k === "record_conference"), "the pair must be REMOVED, not sent falsy");
  assert.ok(!pairs.some(([k, v]) => k === "record_conference" && v === "no"));
});

test("an untouched option keeps whatever the form already carries", () => {
  const form = parseForm(ADD_FORM_HTML);
  const { overrides } = buildConferenceOverrides(form, { name: "Defaults", extension: "702" }, { includeExtension: true });
  const m = pairsToMap(applyOverrides(form, overrides));
  assert.equal(m.get("record_conference"), "yes", "the checked checkbox survives untouched");
  assert.equal(m.get("music_on_hold_when_empty"), "yes", "the selected option survives untouched");
  assert.ok(!pairsToMap(form.pairs).has("startmuted"), "the unchecked checkbox stays absent");
});

test("an option the form does not offer lands in skippedFields, never in a blind post", () => {
  const form = parseForm(ADD_FORM_HTML); // has no wait_marked / end_marked controls
  const { overrides, skippedFields } = buildConferenceOverrides(
    form,
    { name: "Host-gated", extension: "703", waitForAdmin: true, endWhenAdminLeaves: true },
    { includeExtension: true },
  );
  assert.deepEqual(skippedFields.sort(), ["end_marked", "wait_marked"]);
  const pairs = applyOverrides(form, overrides);
  assert.ok(!pairs.some(([k]) => k === "wait_marked" || k === "end_marked"));
});

test("clearing a PIN posts an EMPTY string; leaving it alone posts nothing new", () => {
  const form = parseForm(ADD_FORM_HTML);
  const cleared = buildConferenceOverrides(form, { userPin: null }, { includeExtension: false });
  assert.equal(cleared.overrides.set?.["userpin"], "");
  const untouched = buildConferenceOverrides(form, { name: "x" }, { includeExtension: false });
  assert.ok(!("userpin" in (untouched.overrides.set ?? {})), "an untouched PIN must not be overridden");
});

test("a blank maxMembers is an empty string, never a forced 0", () => {
  const form = parseForm(ADD_FORM_HTML);
  const { overrides } = buildConferenceOverrides(form, { maxMembers: null }, { includeExtension: false });
  assert.equal(overrides.set?.["max_members"], "");
});

/* ── source guards ────────────────────────────────────────────────────────── */

const builderSrc = stripComments(read(join(__dirname, "conferenceBuilder.ts")));
const routesSrc = stripComments(read(join(__dirname, "conferenceRoutes.ts")));
const serverSrc = read(join(__dirname, "..", "server.ts"));

test("⛔ the builder never fires Apply Changes", () => {
  assert.doesNotMatch(builderSrc, /generateConfigurations|applyChanges\(/i);
});

test("⛔ deletion goes through the two-step panelDelete — a single step deletes NOTHING", () => {
  assert.match(builderSrc, /panelDelete\(session, "conferences"/);
});

test("⛔ the routes apply only for a SUPER_ADMIN who asked, and only via applyAndRebake", () => {
  assert.match(routesSrc, /if \(!applyNow \|\| !isSuperAdmin\(user\)\) return \{ live: false \};/);
  assert.match(routesSrc, /applyAndRebake\(session, tenantPath/);
  // Never a bare applyChanges — Apply is whole-PBX and must re-bake doorways.
  assert.doesNotMatch(routesSrc, /applyChanges\(/);
});

test("⛔ every write is verified against ombu_conferences afterwards", () => {
  // Three verification re-reads: create, update, delete.
  const hits = routesSrc.match(/const after = await listConferencesFromOmbutel/g) ?? [];
  assert.equal(hits.length, 3, "create, update and delete must each re-read the table");
});

test("⛔ writes refuse when the tenant path is unresolved — never the robot's own tenant", () => {
  assert.match(routesSrc, /tenant_path_unresolved/);
  assert.match(routesSrc, /session\.setTenant\(dir\.tenantPath!\)/);
});

test("server.ts wires the routes on the conference feature's own keys", () => {
  // Fails against the pre-change tree (registerConferenceRoutes didn't exist),
  // which is what proves this guard is not decorative.
  assert.ok(serverSrc.includes("registerConferenceRoutes({"), "registerConferenceRoutes must be wired in server.ts");
  assert.ok(serverSrc.includes(`"can_view_conferences"`), "the viewer gate must use can_view_conferences");
  assert.ok(serverSrc.includes(`"can_manage_conferences"`), "the manager gate must use can_manage_conferences");
});
