/**
 * The panel form → UI schema reader.
 *
 * The fixture below is SYNTHETIC on purpose: the real rendered forms carry
 * every customer's company name in their option lists (the outbound-route trunk
 * picker alone lists 69 of them) plus a live CSRF token, and none of that
 * belongs in git. What it does reproduce is every markup shape the seven real
 * forms actually use, including the four that cost real debugging time and are
 * marked ⛔ below. The real forms are checked against this parser at runtime, on
 * the PBX, where they can be read without being stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseSchema, describeForm, schemaFieldNames } from "./panelSchema";

const FIXTURE = `
<form method="POST" action="/index.php" id="demo_form">
  <input type="hidden" name="class" value="queues">
  <input type="hidden" name="method" value="put">
  <input type="hidden" name="csfr_token" value="deadbeef">
  <div class="pbx_module_tabs">
    <ul class="nav nav-tabs tabs_list module-tabs">
      <li class="active"><a href="#demogeneral" data-toggle="tab">General</a></li>
      <li><a href="#demoothers" data-toggle="tab">Others</a></li>
    </ul>
    <div class="tab-content">
      <div role="tabpanel" class="tab-pane active" id="demogeneral">
        <div class="form-group form-group-custom form-group-extension">
          <label class="control-label help-popover" data-content="Number to dial. &lt;br&gt;">Code <b class="red-color">*</b></label>
          <div class="custom-elem-area">
            <input autocomplete="off" type="text" value="" name="extension" id="extension" class="form-control">
          </div>
        </div>
        <div class="form-group form-group-custom form-group-strategy">
          <label class="control-label help-popover" data-content="How callers are handed out.">Strategy</label>
          <div class="custom-elem-area">
            <select name="strategy" id="strategy" class="form-control">
              <option value="ringall" selected>Ring All</option>
              <option value="leastrecent">Least Recent</option>
              <option value="rrmemory">Round Robin Memory</option>
            </select>
          </div>
        </div>
        <div class="form-group form-group-custom form-group-list">
          <label class="control-label help-popover" data-content="Members.">Extensions</label>
          <div class="custom-elem-area">
            <select name="list[]" id="list" multiple>
              <option value="1" selected>101 - Front</option>
              <option value="2">102 - Back</option>
            </select>
          </div>
        </div>
        <table class="repeat-wrapper table table-striped">
          <thead><tr><th></th><th>Prepend</th><th>Pattern</th><th>Enabled</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td><input type="text" name="trkpattern[{{row-count-placeholder}}][prepend]" value=""></td>
              <td><input type="text" name="trkpattern[{{row-count-placeholder}}][pattern]" value=""></td>
              <td><select name="trkpattern[{{row-count-placeholder}}][mode]"><option value="a">A</option></select></td>
              <td><input type="checkbox" name="trkpattern[{{row-count-placeholder}}][enabled]" value="1"></td>
            </tr>
            <tr>
              <td><input type="text" name="trkpattern[0][prepend]" value="845"></td>
              <td><input type="text" name="trkpattern[0][pattern]" value="nxxxxxx"></td>
              <td><select name="trkpattern[0][mode]"><option value="a" selected>A</option></select></td>
              <td><input type="checkbox" name="trkpattern[0][enabled]" value="1" checked></td>
            </tr>
          </tbody>
        </table>
        <div class="form-group form-group-custom form-group-no_release">
          <label class="control-label help-popover" data-content="Adds the no release flag.">No Release</label>
          <div class="custom-elem-area">
            <input type="checkbox" value="yes" name="no_release" checked="checked" id="no_release" class="chk_new" data-on="Yes" data-off="No">
          </div>
        </div>
        <br>
        <div class="legend toltip" title="Destination if nobody answers">Last Destination <b class="red-color">*</b></div>
        <div class="container-fluid">
          <div class="column-pbx">
            <select name="mod_dest" id="mod_dest" class="form-control dependent" data-rule-required="true">
              <option value="">Select Module</option>
              <option value="1">Extensions</option>
              <option value="14">Queues</option>
            </select>
          </div>
          <div class="column-pbx">
            <select name="destination" id="destination" class="form-control" data-rule-required="true">
              <option value="">Select Destination</option>
            </select>
            <input autocomplete="off" type="text" value="" name="destination_custom" id="destination_custom" class="hidden">
          </div>
        </div>
      </div>
      <div role="tabpanel" class="tab-pane" id="demoothers">
        <div class="form-group form-group-custom form-group-weight">
          <label class="control-label help-popover" data-content="Queue weight.">Queue Weight</label>
          <div class="custom-elem-area">
            <input autocomplete="off" type="text" value="0" name="weight" id="weight" class="form-control" placeholder="0">
          </div>
        </div>
      </div>
    </div>
  </div>
</form>`;

const tabs = parseSchema(FIXTURE);
const general = tabs[0];
const byName = (n: string) => general.fields.find((f) => f.name === n);

test("tabs come back in the panel's own order", () => {
  assert.deepEqual(tabs.map((t) => t.label), ["General", "Others"]);
  assert.equal(tabs[1].fields.length, 1);
  assert.equal(tabs[1].fields[0].name, "weight");
});

test("a field carries its label, help text and required marker", () => {
  const f = byName("extension")!;
  assert.equal(f.label, "Code");
  assert.equal(f.type, "text");
  assert.equal(f.required, true);
  assert.match(f.help!, /Number to dial/);
  assert.equal(byName("strategy")!.required, false);
});

test("a select carries EVERY option, in order", () => {
  const f = byName("strategy")!;
  assert.equal(f.type, "select");
  assert.deepEqual(f.options!.map((o) => o.v), ["ringall", "leastrecent", "rrmemory"]);
  assert.deepEqual(f.options!.map((o) => o.t), ["Ring All", "Least Recent", "Round Robin Memory"]);
});

test("a multiple select is a multiselect, not a select", () => {
  assert.equal(byName("list[]")!.type, "multiselect");
  assert.equal(byName("list[]")!.options!.length, 2);
});

test("a checkbox is a checkbox", () => {
  assert.equal(byName("no_release")!.type, "checkbox");
});

test("hidden fields and the panel's own plumbing never reach the screen", () => {
  for (const n of ["class", "method", "csfr_token"]) {
    assert.equal(byName(n), undefined, `${n} must not be drawn`);
  }
  // `destination_custom` IS a real field — the panel hides it with a CSS class
  // until "custom" is chosen as the destination, and it carries the value.
  assert.equal(byName("destination_custom")!.type, "text");
});

/* ⛔ The four traps. Each of these failed against the real forms first. */

test("⛔ a trailing checkbox block does not swallow the next section's select", () => {
  // The `no_release` block runs to the end of the tab, so a naive
  // select-before-input parse labels `mod_dest` as "No Release".
  assert.equal(byName("no_release")!.type, "checkbox");
  assert.equal(byName("no_release")!.label, "No Release");
});

test("⛔ loose controls under a legend are captured, with their section", () => {
  const md = byName("mod_dest");
  assert.ok(md, "mod_dest is a real, required field and must not be dropped");
  assert.equal(md!.section, "Last Destination");
  assert.equal(md!.required, true);
  assert.equal(md!.options!.length, 3);
  assert.equal(byName("destination")!.section, "Last Destination");
});

test("⛔ an <input> before a <select> must not hide it (the greedy-optional trap)", () => {
  // `extension` (input) precedes `strategy` (select). With a greedy
  // `(?:(.*?)</select>)?` the input's match runs to strategy's </select> and
  // strategy disappears. It is the same shape that hid mod_dest.
  assert.ok(byName("strategy"), "the select after an input must survive");
  assert.ok(byName("mod_dest"), "and so must the one after a checkbox");
});

test("⛔ a repeat table gives its columns and one template row, indexed [N]", () => {
  assert.equal(general.repeats.length, 1);
  const r = general.repeats[0];
  assert.deepEqual(r.columns, ["Prepend", "Pattern", "Enabled"]);
  assert.deepEqual(r.cells.map((c) => c.name), [
    "trkpattern[N][prepend]", "trkpattern[N][pattern]", "trkpattern[N][mode]", "trkpattern[N][enabled]",
  ]);
  assert.deepEqual(r.cells.map((c) => c.type), ["text", "text", "select", "checkbox"]);
  assert.equal(r.cells[2].options!.length, 1);
  // the concrete row 0 must not be drawn again as a field
  assert.equal(byName("trkpattern[0][prepend]"), undefined);
});

test("⛔ a radio button-group is a real field, with every choice", () => {
  // `technology` on the extension and trunk forms is a Bootstrap button group:
  // one radio per choice, the choice's name being the text after the input.
  // Skipping radios dropped the single most consequential field on both forms.
  const t = parseSchema(`
    <div class="form-group form-group-technology">
      <label class="control-label" data-content="Type of technology.">Technology</label>
      <div class="btn-group" id="technology" data-toggle="buttons">
        <label class="btn-radio active"><input type="radio" value="pjsip" name="technology" checked="checked">PJSIP</label>
        <label class="btn-radio"><input type="radio" value="iax" name="technology">IAX2</label>
        <label class="btn-radio"><input type="radio" value="virtual" name="technology">VIRTUAL</label>
      </div>
    </div>`);
  const f = t[0].fields.find((x) => x.name === "technology")!;
  assert.equal(f.type, "radio");
  assert.equal(f.label, "Technology");
  assert.deepEqual(f.options!.map((o) => o.v), ["pjsip", "iax", "virtual"]);
  assert.deepEqual(f.options!.map((o) => o.t), ["PJSIP", "IAX2", "VIRTUAL"]);
});

test("a form with no tabs still yields one General tab", () => {
  const t = parseSchema('<div class="form-group"><label class="control-label">Name</label><input name="description" type="text"></div>');
  assert.equal(t.length, 1);
  assert.equal(t[0].label, "General");
  assert.equal(t[0].fields[0].name, "description");
});

test("describeForm returns what to DRAW and what to POST from one parse", () => {
  const s = describeForm(FIXTURE);
  assert.equal(s.tabs.length, 2);
  // values/checks come from panelForm.ts, which the console already trusts
  assert.equal(s.form.values.strategy, "ringall");
  assert.equal(s.form.checks.no_release.checked, true);
  assert.equal(s.form.checks.no_release.on, "yes");
  assert.deepEqual(s.form.multi["list[]"], ["1"]);
  // the checkbox rule: an unticked box contributes NO pair
  assert.ok(s.form.pairs.some(([k, v]) => k === "no_release" && v === "yes"));
});

test("schemaFieldNames covers fields and repeat cells", () => {
  const names = schemaFieldNames(tabs);
  assert.ok(names.has("extension"));
  assert.ok(names.has("mod_dest"));
  assert.ok(names.has("trkpattern[N][pattern]"));
  assert.ok(names.has("weight"));
  assert.ok(!names.has("csfr_token"));
});
