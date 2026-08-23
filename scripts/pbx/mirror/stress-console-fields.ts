/**
 * THE FULL UNLICENSED STRESS RUN — every field, every table, every button.
 *
 * Izzy: "stress the fuck out of everything we moved over from the PBX to
 * Connect that is not covered by the license … every little field, every
 * button, everything that we created should be working, and wired with the
 * PBX."
 *
 * Runs against the Community-edition clone (`vpbx-clone`, no licence file),
 * driving the SHIPPED code — `describeForm` → `buildPanelEditPairs` →
 * `session.post` — never a test double. Four phases:
 *
 *   1. FIELD SWEEP — for every editable field on tenants, trunks, outbound
 *      routes, route selections, ring groups and queues: change it, save,
 *      RE-READ AND VERIFY the phone system kept it, put it back, verify the
 *      restore. One field per save, so a refusal names its field.
 *   2. ROW TABLES — mutate a cell, then add a row and remove it again, for
 *      every repeat table.
 *   3. CREATE → VERIFY → DELETE — a new trunk, outbound route, route
 *      selection, ring group and queue through the same generic path the New
 *      button uses, existence proven in MySQL, then the two-step panel delete.
 *   4. WIRED TO ASTERISK — change a queue's member ring time, run the panel's
 *      own Apply, and grep the RENDERED config inside the clone for the new
 *      value; then restore and re-apply. The database is not what callers
 *      hear — the rendered file is.
 *
 * ⛔ Extensions are exercised as FORM ONLY plus one deliberate cap probe: the
 * unlicensed panel refuses every extension save while the PBX is over the free
 * tier's 12-extension cap (proven both ways round, 2026-08-21 — see
 * AGENT_HANDOFF_PBX_CONSOLE_WHOLE_PANEL_FORM_2026-08-21.md §4). That is the
 * one known gap for the licence exit and this run re-asserts it rather than
 * hiding it.
 *
 * ⛔ Refuses to run against a live host. Every mutation is restored.
 * ⛔ A save that TIMES OUT may still have landed — on timeout the harness
 *    re-reads and judges from what the panel actually holds.
 */
import { execSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { PanelSession, applyChanges, dialogErrors } from "../../../apps/api/src/onboarding/panelClient";
import { loadParsedForm, type ParsedForm } from "../../../apps/api/src/pbxConsole/panelForm";
import { describeForm, type PanelField, type PanelTab } from "../../../apps/api/src/pbxConsole/panelSchema";
import { buildPanelEditPairs, splitRowCell, PANEL_MODULES, type PanelModuleKey, type PanelEditInput } from "../../../apps/api/src/pbxConsole/panelFormWrite";

const BASE = process.env.CLONE_PANEL_BASE || "https://127.0.0.1:8443";
const USER = process.env.CONNECT_ROBOT_USER || "";
const PASS = process.env.CONNECT_ROBOT_PASS || "";
const MAIN = process.env.CLONE_MAIN_TENANT || "2dc3974017c1bc65";
const TENANT = process.env.CLONE_TENANT_PATH || "f3df739ac62197cd"; // clone t2 "a_plus_center"
const TENANT_NUM = process.env.CLONE_TENANT_NUM || "2";
const LOG = process.env.STRESS_LOG || "/root/console-proof/stress-fields.log";

if (!USER || !PASS) throw new Error("set CONNECT_ROBOT_USER / CONNECT_ROBOT_PASS");
if (/45\.14\.194\.179|209\.145\.60\.79/.test(BASE)) throw new Error("refusing to run against a live host");

const t0 = Date.now();
const line = (s: string) => {
  const msg = `[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${s}`;
  process.stdout.write(msg + "\n");
  try { appendFileSync(LOG, msg + "\n"); } catch {}
};

/** Clone MySQL, id lookups and ground truth only — never part of the save path. */
const sql = (q: string): string => {
  try { return execSync(`docker exec vpbx-clone mysql -N -e ${JSON.stringify(q)}`, { encoding: "utf8" }).trim(); }
  catch (e: any) { return `SQL_ERROR: ${e?.message || e}`; }
};
const cloneGrep = (pattern: string, glob: string): string => {
  try { return execSync(`docker exec vpbx-clone sh -c ${JSON.stringify(`grep -rn ${JSON.stringify(pattern)} ${glob} 2>/dev/null | head -5`)}`, { encoding: "utf8" }).trim(); }
  catch { return ""; }
};

type Verdict = "PASS" | "PASS_TIMEOUT" | "REFUSED" | "SKIP" | "FAIL";
const tally: Record<string, Record<Verdict, number>> = {};
const fails: string[] = [];
const refusals: string[] = [];
const note = (mod: string, v: Verdict, what: string, extra = "") => {
  tally[mod] = tally[mod] || { PASS: 0, PASS_TIMEOUT: 0, REFUSED: 0, SKIP: 0, FAIL: 0 };
  tally[mod][v]++;
  const msg = `${v.padEnd(12)} ${mod}: ${what}${extra ? ` — ${extra}` : ""}`;
  if (v === "FAIL") fails.push(msg);
  if (v === "REFUSED") refusals.push(msg);
  line(msg);
};

/* ── mutation planning ──────────────────────────────────────────────────── */

/** Fields never mutated, with the honest reason. */
function skipReason(mod: PanelModuleKey, f: PanelField): string | null {
  // identity/keys: renumbering is a copy→repoint→delete operation, not an edit
  if (f.name === "extension" && mod !== "tenants") return "identity — the phone system cannot renumber; copy→repoint→delete";
  if (mod === "tenants" && (f.name === "name" || f.name === "path")) return "identity — the slug is matched by name elsewhere";
  if (f.name === "technology") return "changes the record's whole shape — a create-time choice, and the panel cannot change a device's type";
  if (f.type === "password") return "the panel renders passwords blank (blank = keep), so a change cannot be read back";
  if (f.type === "file") return "file upload is deliberately not wired; the screen says so";
  if (/^(mod_dest|destination|destination_custom|mod_hangup_dest|hangup_destination|hangup_destination_custom)$/.test(f.name)) {
    return "dependent pair — proven as a pair by the create phase, which posts both";
  }
  if (f.name === "csv") return "file import";
  return null;
}

function mutateValue(f: PanelField, cur: string): string | null {
  if (f.type === "select" || f.type === "radio") {
    const opts = (f.options || []).filter((o) => o.v !== "" && o.v !== cur);
    return opts.length ? opts[0].v : null;
  }
  if (f.type === "textarea") return (cur || "") + " zz";
  // text: keep numbers numeric, words wordy
  if (/^\d+$/.test(cur) && cur !== "") return String(Number(cur) + 1);
  if (cur === "") {
    return /time|timeout|max|len|weight|delay|level|frequen|second|limit|priorit|retry|port|ring/i.test(f.name) ? "3" : "zz";
  }
  return cur + " zz";
}

/* ── save + verify machinery ────────────────────────────────────────────── */

async function postJudged(
  s: PanelSession, mod: PanelModuleKey, id: string, edit: PanelEditInput,
  check: (form: ParsedForm) => boolean,
): Promise<{ v: Verdict; why?: string }> {
  const cls = PANEL_MODULES[mod].cls;
  const { form, html } = await loadParsedForm(s, cls, "edit", id).then((r) => ({ form: r.form, html: r.html }));
  const tabs = describeForm(html).tabs;
  let pairs: Array<[string, string]>;
  try { pairs = buildPanelEditPairs(form, tabs, edit, { module: mod }); }
  catch (e: any) { return { v: "FAIL", why: `builder refused: ${e?.message}` }; }
  try {
    const res = await s.post(pairs);
    const dlg = dialogErrors(res);
    if (dlg) return { v: "REFUSED", why: String(dlg).replace(/\s+/g, " ").slice(0, 160) };
    if (res.json?.notification?.type === "warning" || res.json?.notification?.type === "error") {
      return { v: "REFUSED", why: String(res.json.notification.text || "").replace(/<[^>]+>/g, " ").slice(0, 160) };
    }
  } catch (e: any) {
    if (/timeout|abort/i.test(String(e?.message))) {
      // ⛔ a timed-out save may have LANDED — judge from what the panel holds
      await new Promise((r) => setTimeout(r, 5000));
      const after = (await loadParsedForm(s, cls, "edit", id)).form;
      return check(after) ? { v: "PASS_TIMEOUT" } : { v: "FAIL", why: "timed out and the value did not land" };
    }
    return { v: "FAIL", why: String(e?.message).slice(0, 160) };
  }
  const after = (await loadParsedForm(s, cls, "edit", id)).form;
  return check(after) ? { v: "PASS" } : { v: "FAIL", why: "saved clean but the value did not stick" };
}

/* ── phase 1+2: the field sweep ─────────────────────────────────────────── */

async function sweepModule(s: PanelSession, mod: PanelModuleKey, id: string) {
  const cls = PANEL_MODULES[mod].cls;
  const { html } = await loadParsedForm(s, cls, "edit", id);
  const { tabs, form } = describeForm(html);
  const nf = tabs.reduce((a, t) => a + t.fields.length, 0);
  line(`── ${mod} #${id}: ${nf} fields, ${tabs.reduce((a, t) => a + t.repeats.length, 0)} tables ──`);

  for (const tab of tabs) {
    for (const f of tab.fields) {
      const skip = skipReason(mod, f);
      if (skip) { note(mod, "SKIP", `${f.label} (${f.name})`, skip); continue; }

      if (f.type === "checkbox") {
        const cur = !!form.checks[f.name]?.checked;
        const r1 = await postJudged(s, mod, id, { checks: { [f.name]: !cur } }, (a) => !!a.checks[f.name]?.checked === !cur);
        if (r1.v === "PASS" || r1.v === "PASS_TIMEOUT") {
          const r2 = await postJudged(s, mod, id, { checks: { [f.name]: cur } }, (a) => !!a.checks[f.name]?.checked === cur);
          note(mod, r2.v === "PASS" || r2.v === "PASS_TIMEOUT" ? r1.v : "FAIL", `${f.label} (${f.name})`,
            r2.v === "PASS" || r2.v === "PASS_TIMEOUT" ? `toggled ${cur}→${!cur}→${cur}` : `RESTORE FAILED: ${r2.why}`);
        } else note(mod, r1.v, `${f.label} (${f.name})`, r1.why);
        continue;
      }

      if (f.type === "multiselect") {
        const cur = form.multi[f.name] || [];
        const opts = (f.options || []).map((o) => o.v).filter((v) => v !== "");
        if (!opts.length) { note(mod, "SKIP", `${f.label} (${f.name})`, "no options to choose from on this clone"); continue; }
        const next = cur.includes(opts[0]) ? cur.filter((v) => v !== opts[0]) : [...cur, opts[0]];
        const same = (a?: string[], b?: string[]) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
        const r1 = await postJudged(s, mod, id, { multi: { [f.name]: next } }, (a) => same(a.multi[f.name], next));
        if (r1.v === "PASS" || r1.v === "PASS_TIMEOUT") {
          const r2 = await postJudged(s, mod, id, { multi: { [f.name]: cur } }, (a) => same(a.multi[f.name], cur));
          note(mod, r2.v === "PASS" || r2.v === "PASS_TIMEOUT" ? r1.v : "FAIL", `${f.label} (${f.name})`,
            r2.v === "PASS" || r2.v === "PASS_TIMEOUT" ? `set ${next.length} entries, restored ${cur.length}` : `RESTORE FAILED: ${r2.why}`);
        } else note(mod, r1.v, `${f.label} (${f.name})`, r1.why);
        continue;
      }

      // text / select / radio / textarea
      const cur = form.values[f.name] ?? "";
      const next = mutateValue(f, cur);
      if (next == null) { note(mod, "SKIP", `${f.label} (${f.name})`, "only one choice — nothing to change to"); continue; }
      const r1 = await postJudged(s, mod, id, { set: { [f.name]: next } }, (a) => (a.values[f.name] ?? "") === next);
      if (r1.v === "PASS" || r1.v === "PASS_TIMEOUT") {
        const r2 = await postJudged(s, mod, id, { set: { [f.name]: cur } }, (a) => (a.values[f.name] ?? "") === cur);
        note(mod, r2.v === "PASS" || r2.v === "PASS_TIMEOUT" ? r1.v : "FAIL", `${f.label} (${f.name})`,
          r2.v === "PASS" || r2.v === "PASS_TIMEOUT" ? `"${cur.slice(0, 24)}"→"${String(next).slice(0, 24)}"→back` : `RESTORE FAILED: ${r2.why}`);
      } else note(mod, r1.v, `${f.label} (${f.name})`, r1.why);
    }

    // phase 2: the tab's repeat tables
    for (const rep of tab.repeats) {
      const cells = rep.cells.map((c) => ({ cell: c, split: splitRowCell(c.name) })).filter((x) => x.split);
      if (!cells.length) continue;
      const group = cells[0].split!.group;
      const fresh = (await loadParsedForm(s, cls, "edit", id)).form;
      const rows = readRows(rep, fresh);
      const label = `table ${group} [${rep.columns.join("/") || cells.map((c) => c.split!.field).join("/")}]`;

      if (rows.length) {
        // mutate one text cell of row 0, then restore
        const target = cells.find((x) => x.cell.type === "text" && String(rows[0][x.split!.field] ?? "") !== "");
        if (target) {
          const fkey = target.split!.field;
          const orig = rows.map((r) => ({ ...r }));
          const mut = rows.map((r, i) => (i === 0 ? { ...r, [fkey]: String(r[fkey]) + "9" } : { ...r }));
          const pairName = concreteName(target.cell.name, 0);
          const r1 = await postJudged(s, mod, id, { rows: { [group]: mut } }, (a) => (a.values[pairName] ?? "") === String(orig[0][fkey]) + "9");
          if (r1.v === "PASS" || r1.v === "PASS_TIMEOUT") {
            const r2 = await postJudged(s, mod, id, { rows: { [group]: orig } }, (a) => (a.values[pairName] ?? "") === String(orig[0][fkey]));
            note(mod, r2.v.startsWith("PASS") ? r1.v : "FAIL", `${label} cell ${fkey}`, r2.v.startsWith("PASS") ? "mutated row 0 and restored" : `RESTORE FAILED: ${r2.why}`);
          } else note(mod, r1.v, `${label} cell ${fkey}`, r1.why);
        }

        // add a row (copy of row 0) and remove it again — the + and ✕ buttons
        const orig = rows.map((r) => ({ ...r }));
        const added = [...orig.map((r) => ({ ...r })), { ...orig[0] }];
        const probeName = concreteName(cells[0].cell.name, orig.length);
        const r3 = await postJudged(s, mod, id, { rows: { [group]: added } }, (a) =>
          cells[0].cell.type === "checkbox" ? probeName in a.checks || probeName in a.values : probeName in a.values);
        if (r3.v === "PASS" || r3.v === "PASS_TIMEOUT") {
          const r4 = await postJudged(s, mod, id, { rows: { [group]: orig } }, (a) =>
            !(probeName in a.values) && !(probeName in a.checks));
          note(mod, r4.v.startsWith("PASS") ? r3.v : "FAIL", `${label} add+remove row`,
            r4.v.startsWith("PASS") ? `${orig.length}→${added.length}→${orig.length} rows` : `ROW REMOVE FAILED: ${r4.why}`);
        } else note(mod, r3.v, `${label} add row`, r3.why);
      } else {
        note(mod, "SKIP", label, "no existing rows to copy — covered by the create phase");
      }
    }
  }
}

function concreteName(cellName: string, i: number): string {
  const b = cellName.match(/^(.+?)\[N\]\[(.+)\]$/);
  if (b) return `${b[1]}[${i}][${b[2]}]`;
  const u = cellName.match(/^(.+?)_N_(.+)$/);
  if (u) return `${u[1]}_${i}_${u[2]}`;
  return cellName;
}

function readRows(rep: { cells: Array<{ name: string; type: string }> }, form: ParsedForm): Array<Record<string, string | boolean>> {
  const out: Array<Record<string, string | boolean>> = [];
  for (let i = 0; i < 200; i++) {
    const row: Record<string, string | boolean> = {};
    let any = false;
    for (const c of rep.cells) {
      const sp = splitRowCell(c.name);
      if (!sp) continue;
      const key = concreteName(c.name, i);
      if (c.type === "checkbox") { if (key in form.checks) { row[sp.field] = form.checks[key].checked; any = true; } }
      else if (key in form.values) { row[sp.field] = form.values[key]; any = true; }
    }
    if (!any) break;
    out.push(row);
  }
  return out;
}

/* ── phase 3: create → verify in MySQL → delete → verify gone ───────────── */

async function panelDelete(s: PanelSession, cls: string, id: string): Promise<string | null> {
  const r = await s.post([["class", cls], ["method", "delete"], ["mode", "delete"], ["data", id]]);
  const html = String(r.json?.html || "");
  if (!/confirmation-modal/i.test(html)) return `unexpected delete response: ${r.text.slice(0, 140)}`;
  const pairs: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
    const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
    if (n) pairs.push([n, v]);
  }
  const r2 = await s.post(pairs);
  return r2.json?.notification?.type === "success" ? null : `confirm failed: ${r2.text.slice(0, 140)}`;
}

async function createCycle(
  s: PanelSession, mod: PanelModuleKey, edit: PanelEditInput,
  idQuery: string, label: string,
) {
  const cls = PANEL_MODULES[mod].cls;
  try {
    const { html, form } = await loadParsedForm(s, cls, "add", null);
    const tabs = describeForm(html).tabs;
    const pairs = buildPanelEditPairs(form, tabs, edit, { module: mod });
    const res = await s.post(pairs);
    const dlg = dialogErrors(res);
    if (dlg) { note(mod, "REFUSED", `CREATE ${label}`, String(dlg).replace(/\s+/g, " ").slice(0, 180)); return; }
    if (res.json?.notification?.type === "warning" || res.json?.notification?.type === "error") {
      note(mod, "REFUSED", `CREATE ${label}`, String(res.json.notification.text || "").replace(/<[^>]+>/g, " ").slice(0, 180));
      return;
    }
  } catch (e: any) { note(mod, "FAIL", `CREATE ${label}`, String(e?.message).slice(0, 160)); return; }

  const id = sql(idQuery);
  if (!/^\d+$/.test(id)) { note(mod, "FAIL", `CREATE ${label}`, `saved clean but MySQL cannot find it: ${id.slice(0, 120)}`); return; }
  note(mod, "PASS", `CREATE ${label}`, `row #${id} exists in the phone system's own database`);

  const err = await panelDelete(s, cls, id);
  if (err) { note(mod, "FAIL", `DELETE ${label} #${id}`, err); return; }
  const gone = sql(idQuery);
  if (gone === "") note(mod, "PASS", `DELETE ${label} #${id}`, "row gone from the database");
  else note(mod, "FAIL", `DELETE ${label} #${id}`, `still present: ${gone.slice(0, 80)}`);
}

/* ── phase 4: the rendered config — what Asterisk actually reads ────────── */

async function renderProof(s: PanelSession, queueId: string) {
  const cls = "queues";
  const { form } = await loadParsedForm(s, cls, "edit", queueId);
  const cur = form.values["timeout"] ?? "";
  const probe = cur === "31" ? "32" : "31";
  const qext = form.values["extension"] || "?";

  const r1 = await postJudged(s, "queues", queueId, { set: { timeout: probe } }, (a) => a.values["timeout"] === probe);
  if (r1.v !== "PASS" && r1.v !== "PASS_TIMEOUT") { note("render", "FAIL", "queue timeout save", r1.why); return; }
  await applyChanges(s, "stress-render");
  await new Promise((r) => setTimeout(r, 3000));
  const hit = cloneGrep(`timeout=${probe}`, "/etc/asterisk/vitalpbx/queues__*");
  if (hit) note("render", "PASS", `queue ${qext} member ring time ${cur}→${probe}`, `RENDERED into Asterisk config: ${hit.split("\n")[0].slice(0, 110)}`);
  else {
    const anywhere = cloneGrep(`timeout=${probe}`, "/etc/asterisk/vitalpbx/");
    if (anywhere) note("render", "PASS", `queue ${qext} member ring time ${cur}→${probe}`, `rendered: ${anywhere.split("\n")[0].slice(0, 110)}`);
    else note("render", "FAIL", `queue ${qext} member ring time`, "saved + applied but the value is not in any rendered file");
  }
  // restore + re-apply so the clone ends where it started
  const r2 = await postJudged(s, "queues", queueId, { set: { timeout: cur } }, (a) => (a.values["timeout"] ?? "") === cur);
  await applyChanges(s, "stress-render-restore");
  note("render", r2.v.startsWith("PASS") ? "PASS" : "FAIL", "restore + re-apply", r2.v.startsWith("PASS") ? `back to ${cur || "(blank)"}` : r2.why);
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  writeFileSync(LOG, "");
  const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
  await s.login();
  line(`UNLICENSED FULL STRESS — panel ${BASE}, licence dir empty`);

  const ids = {
    tenant: process.env.CLONE_TENANT_ID || "2",
    trunk: process.env.CLONE_TRUNK_ID || "11",
    route: process.env.CLONE_ROUTE_ID || "11",
    ars: process.env.CLONE_ARS_ID || "1",
    rg: process.env.CLONE_RG_ID || "1",
    queue: process.env.CLONE_QUEUE_ID || "1",
    ext: process.env.CLONE_EXT_ID || "1",
  };

  /* PHASE 1+2: field sweep */
  s.setTenant(MAIN);
  await sweepModule(s, "tenants", ids.tenant);
  await sweepModule(s, "trunks", ids.trunk);
  await sweepModule(s, "outbound-routes", ids.route);
  await sweepModule(s, "route-selections", ids.ars);
  s.setTenant(TENANT);
  await sweepModule(s, "ring-groups", ids.rg);
  await sweepModule(s, "queues", ids.queue);

  /* Extensions: the known exception, re-asserted deliberately */
  line(`── extensions #${ids.ext}: form + the cap probe ──`);
  {
    const { html } = await loadParsedForm(s, "extensions", "edit", ids.ext);
    const { tabs } = describeForm(html);
    const nf = tabs.reduce((a, t) => a + t.fields.length, 0);
    note("extensions", nf >= 90 ? "PASS" : "FAIL", `form draws ${nf} fields across ${tabs.length} tabs`,
      nf >= 90 ? "every control typed and optioned" : "the form came back small");
    const r = await postJudged(s, "extensions", ids.ext, { set: { name: "zz probe" } }, () => false);
    note("extensions", r.v === "REFUSED" ? "PASS" : "FAIL", "the cap refusal is CONSISTENT",
      r.v === "REFUSED" ? `over-cap save refused in plain words (the licence-exit gap, known): ${r.why?.slice(0, 100)}` : `expected a refusal, got ${r.v}: ${r.why || ""}`);
  }

  /* PHASE 3: create → verify → delete, the New and Delete buttons */
  line("── create → verify → delete ──");
  s.setTenant(MAIN);
  await createCycle(s, "trunks",
    { set: { description: "ZZ Stress Trunk", "outgoing[host]": "stress.invalid", "outgoing[username]": "zzstress", "outgoing[match]": "stress.invalid" } },
    "select trunk_id from ombutel.ombu_trunks where description='ZZ Stress Trunk'", "trunk");
  {
    const trunkOpt = sql("select trunk_id from ombutel.ombu_trunks order by trunk_id limit 1");
    await createCycle(s, "outbound-routes",
      { set: { description: "ZZ Stress Route" }, multi: { "trklist[]": [trunkOpt] },
        rows: { trkpattern: [{ prepend: "", prefix: "", pattern: "nxxnxxxxxx", cid_pattern: "" }] } },
      "select outbound_route_id from ombutel.ombu_outbound_routes where description='ZZ Stress Route'", "outbound route");
  }
  {
    const routeOpt = sql("select outbound_route_id from ombutel.ombu_outbound_routes order by outbound_route_id limit 1");
    await createCycle(s, "route-selections",
      { set: { description: "ZZ Stress ARS" }, rows: { members: [{ outbound_route_id: routeOpt, time_group_id: "", enabled: true }] } },
      "select ars_id from ombutel.ombu_ars where description='ZZ Stress ARS'", "route selection");
  }
  s.setTenant(TENANT);
  {
    // copy the existing ring group's valid Last Destination pair — the cascade
    const rgForm = (await loadParsedForm(s, "ring_group", "edit", ids.rg)).form;
    const dest = { mod_dest: rgForm.values["mod_dest"] || "", destination: rgForm.values["destination"] || "" };
    const member = (rgForm.multi["list[]"] || [])[0] || "";
    await createCycle(s, "ring-groups",
      { set: { extension: "3901", description: "ZZ Stress RG", ...dest }, multi: member ? { "list[]": [member] } : {} },
      `select ring_group_id from ombutel.ombu_ring_groups where description='ZZ Stress RG' and tenant_id=${TENANT_NUM}`, "ring group");
    const qForm = (await loadParsedForm(s, "queues", "edit", ids.queue)).form;
    const qdest = { mod_dest: qForm.values["mod_dest"] || "", destination: qForm.values["destination"] || "" };
    await createCycle(s, "queues",
      { set: { extension: "3902", description: "ZZ Stress Queue", ...qdest } },
      `select queue_id from ombutel.ombu_queues where description='ZZ Stress Queue' and tenant_id=${TENANT_NUM}`, "queue");
  }

  /* PHASE 4: the rendered config */
  line("── wired to Asterisk: the rendered file, not the database ──");
  await renderProof(s, ids.queue);

  /* summary */
  line("");
  line("════════ SUMMARY ════════");
  let P = 0, PT = 0, R = 0, K = 0, F = 0;
  for (const [mod, t] of Object.entries(tally)) {
    line(`${mod.padEnd(17)} PASS ${String(t.PASS).padStart(3)}  pass-after-timeout ${t.PASS_TIMEOUT}  refused-by-panel ${t.REFUSED}  skipped ${t.SKIP}  FAIL ${t.FAIL}`);
    P += t.PASS; PT += t.PASS_TIMEOUT; R += t.REFUSED; K += t.SKIP; F += t.FAIL;
  }
  line(`TOTAL             PASS ${P}  pass-after-timeout ${PT}  refused-by-panel ${R}  skipped ${K}  FAIL ${F}`);
  if (refusals.length) { line(""); line("panel refusals (its own validation speaking through our path):"); refusals.forEach((r) => line("  " + r)); }
  if (fails.length) { line(""); line("FAILURES:"); fails.forEach((f) => line("  " + f)); process.exit(1); }
  line("");
  line("clean — every mutated field verified and restored; the clone ends where it started");
}

main().catch((e) => { line(`FATAL: ${e?.message || e}`); process.exit(1); });
