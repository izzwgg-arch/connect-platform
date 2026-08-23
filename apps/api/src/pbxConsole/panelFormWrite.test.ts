/**
 * Turning an edited panel form back into the pairs a browser posts.
 *
 * These are the rules that decide what actually reaches the phone system, so
 * they are tested on their own, with no session and no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describeForm, parseSchema as parseSchemaOf } from "./panelSchema";
import {
  buildPanelEditPairs, splitRowCell, summariseEdit, isPanelModule, PANEL_MODULES, PanelEditError,
} from "./panelFormWrite";

/* A form with: a text field, a select, a multi-select, a checkbox that is ON,
   a checkbox that is OFF, and a repeat table using BOTH row-name shapes — the
   exact asymmetry the real queue form has. */
const FIXTURE = `
<div role="tabpanel" id="t">
  <div class="form-group"><label class="control-label">Description</label>
    <input type="text" name="description" value="Orders"></div>
  <div class="form-group"><label class="control-label">Strategy</label>
    <select name="strategy"><option value="ringall" selected>Ring All</option><option value="linear">In Order</option></select></div>
  <div class="form-group"><label class="control-label">Members</label>
    <select name="list[]" multiple><option value="1" selected>101</option><option value="2">102</option><option value="3">103</option></select></div>
  <div class="form-group"><label class="control-label">Record</label>
    <input type="checkbox" name="record" value="yes" checked></div>
  <div class="form-group"><label class="control-label">Autofill</label>
    <input type="checkbox" name="autofill" value="yes"></div>
  <table class="repeat-wrapper">
    <thead><tr><th>Extension</th><th>Penalty</th><th>Diversions</th></tr></thead>
    <tbody>
      <tr>
        <td><select name="queue_members_{{row-count-placeholder}}_extension_id"><option value="7">101</option><option value="8">102</option></select></td>
        <td><input type="text" name="queue_members[{{row-count-placeholder}}][penalty]"></td>
        <td><input type="checkbox" name="queue_members[{{row-count-placeholder}}][diversions]" value="1"></td>
      </tr>
      <tr>
        <td><select name="queue_members_0_extension_id"><option value="7" selected>101</option></select></td>
        <td><input type="text" name="queue_members[0][penalty]" value="1"></td>
        <td><input type="checkbox" name="queue_members[0][diversions]" value="1" checked></td>
      </tr>
    </tbody>
  </table>
</div>`;

const { tabs, form } = describeForm(FIXTURE);
const get = (pairs: Array<[string, string]>, k: string) => pairs.filter(([n]) => n === k).map(([, v]) => v);

test("the module map covers exactly the seven console modules", () => {
  assert.deepEqual(Object.keys(PANEL_MODULES).sort(), [
    "extensions", "outbound-routes", "queues", "ring-groups", "route-selections", "tenants", "trunks",
  ]);
  assert.ok(isPanelModule("queues"));
  assert.ok(!isPanelModule("../etc/passwd"));
  assert.ok(!isPanelModule("conferences"));
});

test("a scalar edit replaces just that pair", () => {
  const p = buildPanelEditPairs(form, tabs, { set: { description: "Phone Orders" } });
  assert.deepEqual(get(p, "description"), ["Phone Orders"]);
  assert.deepEqual(get(p, "strategy"), ["ringall"], "untouched fields keep their value");
});

test("⛔ switching a checkbox OFF removes its pair; ON adds it with the panel's own value", () => {
  const off = buildPanelEditPairs(form, tabs, { checks: { record: false } });
  assert.deepEqual(get(off, "record"), [], "an unticked box posts NOTHING — `record=no` would tick it");
  const on = buildPanelEditPairs(form, tabs, { checks: { autofill: true } });
  assert.deepEqual(get(on, "autofill"), ["yes"], "and ON uses the value the panel rendered, not 1");
});

test("a multi-select is replaced wholesale, one pair per choice", () => {
  const p = buildPanelEditPairs(form, tabs, { multi: { "list[]": ["2", "3"] } });
  assert.deepEqual(get(p, "list[]"), ["2", "3"]);
});

test("⛔ row cells keep the panel's own shape — brackets AND underscores", () => {
  assert.deepEqual(splitRowCell("queue_members[N][penalty]"), { group: "queue_members", field: "penalty", shape: "bracket" });
  assert.deepEqual(splitRowCell("queue_members_N_extension_id"), { group: "queue_members", field: "extension_id", shape: "underscore" });
  assert.equal(splitRowCell("description"), null);
});

test("⛔ saving rows re-indexes from 0 and posts each cell in its own shape", () => {
  const p = buildPanelEditPairs(form, tabs, {
    rows: {
      queue_members: [
        { extension_id: "8", penalty: "1", diversions: true },
        { extension_id: "7", penalty: "2", diversions: false },
      ],
    },
  });
  // underscore shape survived
  assert.deepEqual(get(p, "queue_members_0_extension_id"), ["8"]);
  assert.deepEqual(get(p, "queue_members_1_extension_id"), ["7"]);
  // bracket shape survived
  assert.deepEqual(get(p, "queue_members[0][penalty]"), ["1"]);
  assert.deepEqual(get(p, "queue_members[1][penalty]"), ["2"]);
  // ⛔ the checkbox rule inside a row
  assert.deepEqual(get(p, "queue_members[0][diversions]"), ["1"]);
  assert.deepEqual(get(p, "queue_members[1][diversions]"), [], "an unticked row checkbox posts nothing");
});

test("⛔ saving rows DROPS the rows that were there before", () => {
  // Row 0 exists in the fixture. Saving a single row must not leave a second.
  const p = buildPanelEditPairs(form, tabs, { rows: { queue_members: [{ extension_id: "8", penalty: "9" }] } });
  assert.deepEqual(get(p, "queue_members[0][penalty]"), ["9"]);
  assert.deepEqual(get(p, "queue_members[1][penalty]"), []);
  const concrete = p.filter(([k]) => k.startsWith("queue_members") && !k.includes("{{"));
  // one row, every template cell posted like a browser: extension_id, penalty,
  // and diversions from the template default (unchecked -> absent)
  assert.equal(concrete.filter(([k]) => /\[0\]|_0_/.test(k)).length + 0, concrete.length, "exactly the one concrete row we sent");
  // ⛔ and the PLACEHOLDER row rides along — the browser posts the template
  // row itself, and a queue created without it dies on
  // `Undefined array key "queue_members"` (seen live on the clone)
  assert.ok(p.some(([k]) => k.includes("{{row-count-placeholder}}")), "the placeholder row is part of the post");
});

test("emptying a table removes every concrete row — the placeholder alone remains", () => {
  const p = buildPanelEditPairs(form, tabs, { rows: { queue_members: [] } });
  assert.equal(p.filter(([k]) => k.startsWith("queue_members") && !k.includes("{{")).length, 0, "no concrete rows");
  assert.ok(p.some(([k]) => k.includes("{{row-count-placeholder}}")), "the template row still posts, as a browser would");
});

test("⛔ a field the screen never showed is REFUSED, not quietly written", () => {
  for (const bad of [
    { set: { secret_backdoor: "x" } },
    { checks: { admin_override: true } },
    { multi: { "other[]": ["1"] } },
    { rows: { not_a_table: [{ a: "b" }] } },
  ]) {
    assert.throws(() => buildPanelEditPairs(form, tabs, bad as any), (e: any) => {
      assert.ok(e instanceof PanelEditError);
      assert.equal(e.code, "unknown_field");
      return true;
    }, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("the panel's own plumbing can never be overwritten from the screen", () => {
  // class/method/mode/csfr_token are not in the schema, so they are unknown.
  assert.throws(() => buildPanelEditPairs(form, tabs, { set: { class: "tenants" } }), /no field called/);
  assert.throws(() => buildPanelEditPairs(form, tabs, { set: { csfr_token: "x" } }), /no field called/);
});

test("⛔ a row's HIDDEN pairs travel with the row — member_id is how the panel tells update from add", () => {
  // Queue member rows carry `queue_members[N][member_id]` which the template
  // never shows. Rebuilding rows without it made the panel's save controller
  // throw an exception dialog (seen live on the clone, 2026-08-21).
  const f = describeForm(`
    <div role="tabpanel" id="t">
      <table class="repeat-wrapper">
        <thead><tr><th>Extension</th><th>Penalty</th></tr></thead>
        <tbody>
          <tr>
            <td><select name="queue_members_{{row-count-placeholder}}_extension_id"><option value="7">101</option></select></td>
            <td><input type="text" name="queue_members[{{row-count-placeholder}}][penalty]"></td>
          </tr>
          <tr>
            <td><input type="hidden" name="queue_members[0][member_id]" value="41">
                <select name="queue_members_0_extension_id"><option value="7" selected>101</option></select></td>
            <td><input type="text" name="queue_members[0][penalty]" value="1"></td>
          </tr>
        </tbody>
      </table>
    </div>`);
  // the caller's row carries the extra (the portal's readRows collects it)
  const p = buildPanelEditPairs(f.form, f.tabs, {
    rows: { queue_members: [{ member_id: "41", extension_id: "7", penalty: "2" }, { extension_id: "7", penalty: "3" }] },
  });
  const get = (k: string) => p.filter(([n]) => n === k).map(([, v]) => v);
  assert.deepEqual(get("queue_members[0][member_id]"), ["41"], "the id rides with the existing row, in the panel's own bracket shape");
  assert.deepEqual(get("queue_members[1][member_id]"), [], "a NEW row carries no id — that is what makes it an add");
  assert.deepEqual(get("queue_members_1_extension_id"), ["7"], "and underscore cells keep their shape");
  // a field on neither the template nor the current pairs is still refused
  assert.throws(
    () => buildPanelEditPairs(f.form, f.tabs, { rows: { queue_members: [{ backdoor: "x" }] } }),
    /no field called "backdoor"/,
  );
});

test("⛔ concrete row cells are NOT drawn again as standalone fields", () => {
  // `queue_members_0_extension_id` has no brackets, so it used to leak into
  // the loose-control scan and every member row rendered twice.
  const t = parseSchemaOf(`
    <div role="tabpanel" id="t">
      <table class="repeat-wrapper">
        <thead><tr><th>Extension</th></tr></thead>
        <tbody>
          <tr><td><select name="queue_members_{{row-count-placeholder}}_extension_id"><option value="7">101</option></select></td></tr>
          <tr><td><select name="queue_members_0_extension_id"><option value="7" selected>101</option></select></td></tr>
        </tbody>
      </table>
      <div class="form-group"><label class="control-label">Weight</label><input type="text" name="weight" value="0"></div>
    </div>`);
  const names = t[0].fields.map((f) => f.name);
  assert.ok(!names.includes("queue_members_0_extension_id"), "a concrete row cell is table data, not a field");
  assert.ok(names.includes("weight"), "real fields still come through");
});

test("⛔ an extension's general save never carries device fields", () => {
  // Proven on the Community-edition clone 2026-08-21: re-post the rendered
  // device fields and an unlicensed panel answers "You've reached the maximum
  // number of allowed extensions" — it reads the save as a device ADD. Devices
  // are saved against their own form, by saveExtension.
  const f = describeForm(`
    <div role="tabpanel" id="t">
      <div class="form-group"><label class="control-label">Name</label>
        <input type="text" name="name" value="Front"></div>
      <div class="form-group"><label class="control-label">Username</label>
        <input type="text" name="user" value="T2_101"></div>
      <div class="form-group"><label class="control-label">DTMF</label>
        <select name="dtmfmode"><option value="rfc4733" selected>rfc4733</option></select></div>
    </div>`);
  const withDevices = buildPanelEditPairs(f.form, f.tabs, { set: { name: "Back" } });
  assert.ok(withDevices.some(([k]) => k === "user"), "other modules keep every pair");

  const general = buildPanelEditPairs(f.form, f.tabs, { set: { name: "Back" } }, { module: "extensions" });
  assert.deepEqual(general.filter(([k]) => k === "user"), [], "user is a device field");
  assert.deepEqual(general.filter(([k]) => k === "dtmfmode"), [], "and so is dtmf — re-posting it flips a desk phone");
  assert.ok(general.some(([k, v]) => k === "name" && v === "Back"), "the general field still goes");
});

test("the audit summary counts what changed and names it, but never carries a value", () => {
  const s = summariseEdit({ set: { description: "x", sip_password: "hunter2" }, checks: { record: false }, rows: { queue_members: [{}, {}] } });
  assert.equal(s.fields, 2);
  assert.equal(s.switches, 1);
  assert.deepEqual(s.tables, { queue_members: 2 });
  assert.deepEqual(s.changed, ["description", "record", "sip_password"]);
  assert.ok(!JSON.stringify(s).includes("hunter2"), "a value can be a SIP password — names only");
});
