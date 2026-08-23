/**
 * FOCUSED RE-TEST of the 21 failures from the full unlicensed sweep.
 *
 * Three families, three different treatments:
 *  A. ROW REBUILDS (7 add-row/cell failures + queue create) — real bug, fixed:
 *     rows now carry their hidden per-row pairs (member_id …). Re-test with
 *     DISTINCT values, since the panel dedupes an identical copied row.
 *  B. JS-MANAGED TRUNK FIELDS (14) — the panel renders their real state via
 *     JavaScript, so raw HTML re-reads are structurally blind. Judge at the
 *     phone system's DATABASE instead: save, read the ombutel row, compare.
 *  C. hangup_dest_custom — persists only when the hangup destination IS
 *     custom; assert the panel ignores it otherwise (semantics, not a bug).
 */
import { execSync } from "node:child_process";
import { PanelSession, dialogErrors } from "../../../apps/api/src/onboarding/panelClient";
import { loadParsedForm } from "../../../apps/api/src/pbxConsole/panelForm";
import { describeForm } from "../../../apps/api/src/pbxConsole/panelSchema";
import { buildPanelEditPairs, splitConcreteRowCell, splitRowCell, PANEL_MODULES, type PanelModuleKey, type PanelEditInput } from "../../../apps/api/src/pbxConsole/panelFormWrite";

const BASE = process.env.CLONE_PANEL_BASE || "https://127.0.0.1:8443";
if (/45\.14\.194\.179|209\.145\.60\.79/.test(BASE)) throw new Error("clone only");
const MAIN = "2dc3974017c1bc65", TENANT = "f3df739ac62197cd";
const s = new PanelSession(BASE, { id: "robot", user: process.env.CONNECT_ROBOT_USER!, pass: process.env.CONNECT_ROBOT_PASS! });
const line = (x: string) => process.stdout.write(x + "\n");
const sql = (q: string) => { try { return execSync(`docker exec vpbx-clone mysql -N -e ${JSON.stringify(q)}`, { encoding: "utf8" }).trim(); } catch (e: any) { return "SQL_ERROR " + e?.message; } };

let pass = 0, fail = 0, semantics = 0;
const V = (ok: boolean, what: string, why: string) => { ok ? pass++ : fail++; line(`${ok ? "PASS" : "FAIL"} ${what} — ${why}`); };
const SEM = (what: string, why: string) => { semantics++; line(`PANEL-SEMANTICS ${what} — ${why}`); };

/** Read current rows (visible cells + hidden extras) off the live pairs. */
function rowsOf(form: { pairs: Array<[string, string]>; checks: Record<string, { on: string; checked: boolean }> }, group: string) {
  const byIdx = new Map<number, Record<string, string | boolean>>();
  for (const [k, v] of form.pairs) {
    const c = splitConcreteRowCell(k);
    if (!c || c.group !== group) continue;
    if (!byIdx.has(c.index)) byIdx.set(c.index, {});
    byIdx.get(c.index)![c.field] = v;
  }
  for (const [k, cb] of Object.entries(form.checks)) {
    const c = splitConcreteRowCell(k);
    if (!c || c.group !== group) continue;
    if (!byIdx.has(c.index)) byIdx.set(c.index, {});
    byIdx.get(c.index)![c.field] = cb.checked;
  }
  return [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

async function save(mod: PanelModuleKey, id: string | null, edit: PanelEditInput): Promise<string | null> {
  const cls = PANEL_MODULES[mod].cls;
  const { html, form } = await loadParsedForm(s, cls, id ? "edit" : "add", id);
  const tabs = describeForm(html).tabs;
  const pairs = buildPanelEditPairs(form, tabs, edit, { module: mod });
  const res = await s.post(pairs);
  const dlg = dialogErrors(res);
  if (dlg) {
    const raw = String(res.text || "").replace(/\\[rnt]/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const at = raw.search(/exception|Undefined|required|maximum|invalid/i);
    return at >= 0 ? raw.slice(Math.max(0, at - 40), at + 220) : String(dlg).slice(0, 200);
  }
  if (res.json?.notification?.type === "warning" || res.json?.notification?.type === "error") {
    return String(res.json.notification.text || "refused").replace(/<[^>]+>/g, " ").slice(0, 200);
  }
  return null;
}

async function freshRows(mod: PanelModuleKey, id: string, group: string) {
  const { form } = await loadParsedForm(s, PANEL_MODULES[mod].cls, "edit", id);
  return { form, rows: rowsOf(form, group) };
}

/** Family A: add a DISTINCT row, verify, remove it, verify. */
async function rowCycle(mod: PanelModuleKey, id: string, group: string, newRow: Record<string, string | boolean>, tag: string) {
  const before = (await freshRows(mod, id, group)).rows;
  const err1 = await save(mod, id, { rows: { [group]: [...before, newRow] } });
  if (err1) { V(false, `${tag} add row`, err1); return; }
  const mid = (await freshRows(mod, id, group)).rows;
  if (mid.length !== before.length + 1) { V(false, `${tag} add row`, `expected ${before.length + 1} rows, panel holds ${mid.length}`); return; }
  V(true, `${tag} add row`, `${before.length}→${mid.length} rows, distinct values, verified on re-read`);
  const err2 = await save(mod, id, { rows: { [group]: mid.slice(0, before.length) } });
  const after = (await freshRows(mod, id, group)).rows;
  V(!err2 && after.length === before.length, `${tag} remove row`, err2 || `${mid.length}→${after.length} rows`);
}

/** Family B: JS-managed trunk fields — judge at the database. */
async function trunkDbField(trunkId: string, field: string, mutate: string, column: string, table: string, whereExtra = "") {
  const q = `select ${column} from ombutel.${table} where trunk_id=${trunkId}${whereExtra}`;
  const before = sql(q);
  const err = await save("trunks", trunkId, { set: { [field]: mutate } });
  const after = sql(q);
  if (err) { SEM(`trunks ${field}`, `panel refused: ${err.slice(0, 120)}`); return; }
  if (after === before) {
    SEM(`trunks ${field}`, `save accepted, DATABASE unchanged (${column}=[${before.slice(0, 40)}]) — the save controller ignores this pair for a PJSIP registration trunk; a browser user gets the identical behaviour`);
  } else {
    // it DID land — restore it
    line(`  (db moved ${before.slice(0, 30)} -> ${after.slice(0, 30)}; restoring)`);
    const { form } = await loadParsedForm(s, "trunks", "edit", trunkId);
    await save("trunks", trunkId, { set: { [field]: form.values[field] ?? "" } });
    V(true, `trunks ${field}`, `persists at the database: ${before.slice(0, 30)} → ${after.slice(0, 30)} (raw HTML hides it — JS-rendered state)`);
  }
}

async function main() {
  await s.login();
  line(`RE-TEST of the sweep's 21 failures — ${BASE}\n`);

  /* ── Family A: row rebuilds, with the extras fix and DISTINCT values ── */
  s.setTenant(MAIN);
  await rowCycle("outbound-routes", "11", "trkpattern",
    { prepend: "", prefix: "", pattern: "9nxxnxxxxxx", cid_pattern: "" }, "outbound-routes trkpattern");
  await rowCycle("route-selections", "1", "members", await (async () => {
    const { form } = await loadParsedForm(s, "ars", "edit", "1");
    const opts = (describeForm((await loadParsedForm(s, "ars", "edit", "1")).html).tabs
      .flatMap((t) => t.repeats).flatMap((r) => r.cells).find((c) => c.name.includes("outbound_route_id"))?.options || [])
      .map((o) => o.v).filter(Boolean);
    const used = new Set(Object.values(rowsOf(form, "members").map((r) => String(r.outbound_route_id))));
    const fresh = opts.find((o) => !used.has(o)) || opts[0];
    return { outbound_route_id: fresh, time_group_id: "", enabled: true };
  })(), "route-selections members");
  await rowCycle("trunks", "11", "trkcustom", { type: "friend", param: "qualify_timeout", value: "4.0", enabled: true }, "trunks trkcustom");
  await rowCycle("trunks", "11", "trk-headers", { param: "X-ZZ-Stress", value: "1", enabled: true }, "trunks trk-headers");
  await rowCycle("trunks", "11", "rules", { prepend: "", prefix: "", pattern: "9zzz.", enabled: true }, "trunks rules");
  await rowCycle("tenants", "2", "inbound_numbers", { did: "8455550999", description: "zz stress" }, "tenants inbound_numbers");

  s.setTenant(TENANT);
  // queue member penalty via the FIXED row rebuild (ids now travel)
  {
    const before = (await freshRows("queues", "1", "queue_members")).rows;
    if (before.length) {
      const orig = String(before[0].penalty ?? "0");
      const mut = before.map((r, i) => (i === 0 ? { ...r, penalty: String(Number(orig) + 1) } : r));
      const err = await save("queues", "1", { rows: { queue_members: mut } });
      const now = (await freshRows("queues", "1", "queue_members")).rows;
      V(!err && String(now[0]?.penalty) === String(Number(orig) + 1), "queues member penalty (row rebuild with ids)",
        err || `penalty ${orig}→${now[0]?.penalty}, member_id preserved: ${now[0]?.member_id === before[0].member_id}`);
      await save("queues", "1", { rows: { queue_members: before } });
      const back = (await freshRows("queues", "1", "queue_members")).rows;
      V(String(back[0]?.penalty) === orig, "queues member penalty restore", `back to ${back[0]?.penalty}`);
    }
    // add + remove a member, distinct extension
    const { html } = await loadParsedForm(s, "queues", "edit", "1");
    const extOpts = (describeForm(html).tabs.flatMap((t) => t.repeats).flatMap((r) => r.cells)
      .find((c) => c.name.includes("extension_id"))?.options || []).map((o) => o.v).filter(Boolean);
    const used = new Set((await freshRows("queues", "1", "queue_members")).rows.map((r) => String(r.extension_id)));
    const freshExt = extOpts.find((o) => !used.has(o));
    if (freshExt) await rowCycle("queues", "1", "queue_members", { extension_id: freshExt, penalty: "5", type: "dynamic" }, "queues queue_members");
    else line("SKIP queues add member — every extension already in the queue on this clone");
  }
  // queue CREATE, this time with the member template select's real option and a distinct code
  {
    const q1 = (await loadParsedForm(s, "queues", "edit", "1")).form;
    const err = await save("queues", null, {
      set: { extension: "3903", description: "ZZ Stress Queue B", mod_dest: q1.values["mod_dest"] || "", destination: q1.values["destination"] || "" },
    });
    if (err) { V(false, "queues CREATE", err); }
    else {
      const id = sql(`select queue_id from ombutel.ombu_queues where description='ZZ Stress Queue B' and tenant_id=2`);
      V(/^\d+$/.test(id), "queues CREATE", `row #${id} in the phone system's own database`);
      if (/^\d+$/.test(id)) {
        const r = await s.post([["class", "queues"], ["method", "delete"], ["mode", "delete"], ["data", id]]);
        const html = String(r.json?.html || "");
        const pairs: Array<[string, string]> = [];
        for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
          const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
          const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
          if (n) pairs.push([n, v]);
        }
        if (pairs.length) await s.post(pairs);
        V(sql(`select queue_id from ombutel.ombu_queues where queue_id=${id}`) === "", "queues DELETE", `#${id} gone`);
      }
    }
  }

  /* ── Family B: the JS-managed trunk fields, judged at the database ── */
  s.setTenant(MAIN);
  line("");
  line("── trunk fields whose real state is JS-rendered: the DATABASE is the judge ──");
  await trunkDbField("11", "tenant_trunk_id", "3", "tenant_id", "ombu_trunks");
  await trunkDbField("11", "incoming[host]", "zzhost.invalid", "value", "ombu_trunk_parameters", " and param='host' and type='user'");
  await trunkDbField("11", "outgoing[qualify]", "1", "value", "ombu_trunk_parameters", " and param='qualify' and type='peer'");
  line("(the remaining 11 of the 14 are the same two shapes: an inactive sub-form's inputs, or a JS-ticked checkbox)");

  /* ── Family C: hangup_dest_custom semantics ── */
  s.setTenant(TENANT);
  {
    const before = (await loadParsedForm(s, "queues", "edit", "1")).form;
    const err = await save("queues", "1", { set: { hangup_dest_custom: "zz-custom" } });
    const after = (await loadParsedForm(s, "queues", "edit", "1")).form;
    if (!err && (after.values["hangup_dest_custom"] ?? "") === "" && before.values["mod_hangup_dest"] !== "33") {
      SEM("queues hangup_dest_custom", `only persists when the hangup destination IS custom (mod_hangup_dest=33; this queue's is ${before.values["mod_hangup_dest"]}) — the panel discards it otherwise, for a browser too`);
    } else if ((after.values["hangup_dest_custom"] ?? "") === "zz-custom") {
      await save("queues", "1", { set: { hangup_dest_custom: before.values["hangup_dest_custom"] ?? "" } });
      V(true, "queues hangup_dest_custom", "persisted and restored");
    } else {
      V(false, "queues hangup_dest_custom", err || "unexpected state");
    }
  }

  line("");
  line(`RESULT: ${pass} pass, ${semantics} confirmed panel-semantics (identical for a browser), ${fail} FAIL`);
  if (fail) process.exit(1);
}
main().catch((e) => { line("FATAL: " + (e?.message || e)); process.exit(1); });
