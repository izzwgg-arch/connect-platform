/**
 * PROOF, OUTSIDE THE LICENCE — the console's real save path, all seven modules.
 *
 * Runs against the UNLICENSED clone (docker `vpbx-clone`, `/var/lib/pbx-licenses`
 * empty = Community edition), never the live PBX. It drives the exact code the
 * api runs — `describeForm` → `buildPanelEditPairs` → `session.post` — so a pass
 * here is a statement about the shipped path, not about a test double.
 *
 * For each module it: reads the panel's own form, counts what the console would
 * draw, changes one real field through the console's own write builder, saves,
 * re-reads, and asserts the phone system kept the change. Then it puts the
 * original value back, so the clone ends where it started.
 *
 *   CONNECT_ROBOT_USER=… CONNECT_ROBOT_PASS=… npx tsx unlicensed-console-proof.ts
 *
 * ⛔ Base URL defaults to the ssh tunnel to the clone. It will refuse to run
 * against anything that looks like the live PBX.
 */
import { PanelSession, assertSaved, dialogErrors } from "../../../apps/api/src/onboarding/panelClient";
import { loadParsedForm, parseForm, DEVICE_FIELDS } from "../../../apps/api/src/pbxConsole/panelForm";
import { describeForm } from "../../../apps/api/src/pbxConsole/panelSchema";
import { buildPanelEditPairs, PANEL_MODULES, type PanelModuleKey } from "../../../apps/api/src/pbxConsole/panelFormWrite";

const BASE = process.env.CLONE_PANEL_BASE || "https://127.0.0.1:18443";
const USER = process.env.CONNECT_ROBOT_USER || "";
const PASS = process.env.CONNECT_ROBOT_PASS || "";
const MAIN = process.env.CLONE_MAIN_TENANT || "2dc3974017c1bc65";
const TENANT = process.env.CLONE_TENANT_PATH || "";

if (!USER || !PASS) throw new Error("set CONNECT_ROBOT_USER / CONNECT_ROBOT_PASS");
if (/45\.14\.194\.179|209\.145\.60\.79/.test(BASE)) {
  throw new Error("refusing to run against a live host — this proof is for the clone only");
}

type Case = {
  mod: PanelModuleKey;
  /** An existing record to edit, or null to only read the create form. */
  id: string | null;
  tenantScoped: boolean;
  /** The field to change, and the value to change it to. */
  field?: string;
  value?: string;
};

const CASES: Case[] = [
  { mod: "tenants", id: process.env.CLONE_TENANT_ID || null, tenantScoped: false, field: "description", value: "" },
  { mod: "extensions", id: process.env.CLONE_EXT_ID || null, tenantScoped: true, field: "name", value: "" },
  { mod: "trunks", id: process.env.CLONE_TRUNK_ID || null, tenantScoped: false, field: "description", value: "" },
  { mod: "outbound-routes", id: process.env.CLONE_ROUTE_ID || null, tenantScoped: false, field: "description", value: "" },
  { mod: "route-selections", id: process.env.CLONE_ARS_ID || null, tenantScoped: false, field: "description", value: "" },
  { mod: "ring-groups", id: process.env.CLONE_RG_ID || null, tenantScoped: true, field: "description", value: "" },
  { mod: "queues", id: process.env.CLONE_QUEUE_ID || null, tenantScoped: true, field: "description", value: "" },
];

const line = (s: string) => process.stdout.write(s + "\n");

/**
 * ⛔ AN EXTENSION SAVE MUST CARRY A DEVICE, and the phone system says so in two
 * different voices depending on what you send:
 *   • re-post the rendered device fields with the general save and an
 *     unlicensed panel answers "You've reached the maximum number of allowed
 *     extensions" — it reads the save as a device ADD;
 *   • drop them and its own validator crashes: `Undefined array key "user" at
 *     modules/extensions/Validations.php`.
 * Both were seen here, on the Community-edition clone.
 *
 * The way through is the contract `saveExtension` already follows in the api:
 * general fields, plus each device's fields taken from THAT DEVICE'S OWN form
 * (`method=getDevice`), which carries `user`, `device_id` and the real dtmf.
 * This is not a second implementation — the shipped route hands extensions to
 * `saveExtension`; this reproduces the same contract so the proof can run
 * without dragging the api's database layer onto the clone.
 */
async function withExtensionDevices(
  s: PanelSession,
  extId: string,
  generalPairs: Array<[string, string]>,
  form: { options: Record<string, Array<{ v: string; t: string }>> },
): Promise<Array<[string, string]>> {
  const devices = (form.options["device_id"] || []).filter((o) => /^\d+$/.test(o.v));
  if (!devices.length) throw new Error("this extension has no device to carry");
  const r = await s.post([
    ["class", "extensions"], ["method", "getDevice"], ["mode", "edit"],
    ["data[device_id]", devices[0].v], ["data[extension_id]", String(extId)],
  ]);
  const devForm = parseForm(String(r.json?.html ?? r.text ?? ""));
  const devicePairs = devForm.pairs.filter(([k]) => DEVICE_FIELDS.has(k));
  const out: Array<[string, string]> = [...generalPairs, ...devicePairs];
  for (const [k, v] of [["class", "extensions"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = out.findIndex(([n]) => n === k);
    if (i >= 0) out[i] = [k, v]; else out.push([k, v]);
  }
  return out;
}

async function main() {
  const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
  await s.login();
  line(`panel: ${BASE}  (unlicensed clone)\n`);

  let drawn = 0, tables = 0, saved = 0, failed = 0;

  for (const c of CASES) {
    const m = PANEL_MODULES[c.mod];
    const path = c.tenantScoped ? TENANT : MAIN;
    if (c.tenantScoped && !TENANT) { line(`SKIP ${c.mod}: set CLONE_TENANT_PATH`); continue; }
    s.setTenant(path);

    // ── 1. READ: what would the console draw? ────────────────────────────
    let html: string;
    try {
      ({ html } = await loadParsedForm(s, m.cls, c.id ? "edit" : "add", c.id));
    } catch (e: any) {
      line(`FAIL ${c.mod.padEnd(17)} could not load the form: ${e?.message || e}`);
      failed++; continue;
    }
    const schema = describeForm(html);
    const nFields = schema.tabs.reduce((a, t) => a + t.fields.length, 0);
    const nTables = schema.tabs.reduce((a, t) => a + t.repeats.length, 0);
    const nOpts = schema.tabs.reduce((a, t) => a + t.fields.reduce((b, f) => b + (f.options?.length || 0), 0), 0);
    drawn += nFields; tables += nTables;
    line(`READ ${c.mod.padEnd(17)} ${String(nFields).padStart(3)} fields  ${nTables} tables  ${String(nOpts).padStart(4)} options  tabs: ${schema.tabs.map((t) => t.label).join(" | ")}`);

    if (!c.id || !c.field) { line(`     (create form only — no record id given, nothing written)`); continue; }

    // ── 2. WRITE: change one real field through the console's own builder ─
    const before = schema.form.values[c.field];
    if (before === undefined) { line(`     no "${c.field}" on this form — skipping the write`); continue; }
    const probe = `${before} zz`.slice(0, 60);
    try {
      const pairs = c.mod === "extensions"
        ? await withExtensionDevices(s, c.id, buildPanelEditPairs(schema.form, schema.tabs, { set: { [c.field]: probe } }, { module: c.mod }), schema.form)
        : buildPanelEditPairs(schema.form, schema.tabs, { set: { [c.field]: probe } }, { module: c.mod });
      const res = await s.post(pairs);
      const dlg = dialogErrors(res);
      if (dlg) {
        line(`     panel said: ${String(dlg).replace(/\s+/g, " ").slice(0, 300)}`);
        /* The generic "error dialog" line hides WHICH field the panel is
           unhappy about; the raw body carries the per-field messages. */
        const raw = String(res.text || "").replace(/\s+/g, " ");
        const bits = Array.from(raw.matchAll(/"(?:text|message|title)"\s*:\s*"([^"]{3,200})"/g)).map((m) => m[1]);
        if (bits.length) line(`     detail: ${bits.slice(0, 8).join(" | ").slice(0, 500)}`);
        else {
          const body = raw.replace(/<[^>]+>/g, " ").replace(/\[rnt]/g, " ").replace(/\s+/g, " ");
          const at = body.search(/exception|error|fatal|undefined|SQLSTATE|Call to/i);
          line(`     raw: ${(at >= 0 ? body.slice(Math.max(0, at - 80), at + 520) : body.slice(0, 500))}`);
        }
      }
      assertSaved(`${c.mod} save`, res);
    } catch (e: any) {
      line(`FAIL ${c.mod.padEnd(17)} SAVE REFUSED: ${String(e?.message || e).replace(/\s+/g, " ").slice(0, 800)}`);
      failed++; continue;
    }

    // ── 3. RE-READ: did the phone system actually keep it? ───────────────
    const again = describeForm((await loadParsedForm(s, m.cls, "edit", c.id)).html);
    const after = again.form.values[c.field];
    if (after !== probe) {
      line(`FAIL ${c.mod.padEnd(17)} saved but did not stick: "${before}" -> wanted "${probe}", got "${after}"`);
      failed++; continue;
    }

    // ── 4. PUT IT BACK ───────────────────────────────────────────────────
    const restoreBase = buildPanelEditPairs(again.form, again.tabs, { set: { [c.field]: before } }, { module: c.mod });
    const restore = c.mod === "extensions" ? await withExtensionDevices(s, c.id, restoreBase, again.form) : restoreBase;
    const back = await s.post(restore);
    const err = dialogErrors(back);
    const final = describeForm((await loadParsedForm(s, m.cls, "edit", c.id)).html).form.values[c.field];
    line(`PASS ${c.mod.padEnd(17)} wrote "${probe}" and read it back; restored to "${final}"${err ? ` (restore warned: ${err})` : ""}`);
    if (final !== before) { line(`WARN ${c.mod}: restore did not match — was "${before}", now "${final}"`); }
    saved++;
  }

  line(`\n${drawn} fields drawn, ${tables} row tables, ${saved} modules written and read back, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
