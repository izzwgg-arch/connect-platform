/**
 * PBX Console — the panel FORM contract, in one place.
 *
 * The VitalPBX panel is ionCube-encrypted, so the only honest description of a
 * record is the FORM the panel renders for it: every field it will accept, the
 * option lists it offers, the current values, and which checkboxes are on. The
 * console reads a record by loading that form and parsing it, and saves a
 * record by re-posting the very same pairs with the person's changes applied —
 * exactly what a browser does when somebody presses Save in the panel.
 *
 * ⛔ THE CHECKBOX RULE (proven the hard way, several times in this repo): a
 * browser OMITS an unchecked checkbox. Sending `foo=no` or `enabled=0` TICKS
 * it. So a checkbox that is off is expressed by REMOVING its pair, never by
 * sending a falsy value. `applyOverrides` is the one place that rule lives.
 *
 * ⛔ Multi-selects contribute one pair per selected option; setting one means
 * dropping every existing pair of that name and pushing the new set.
 */
import { decodeEntities, type PanelSession } from "../onboarding/panelClient";

export type FormOption = { v: string; t: string };

export type ParsedForm = {
  /** Scalar fields (text/number/hidden/select-one/radio-checked): name → value. */
  values: Record<string, string>;
  /** Multi-select fields (name ends with []): name → selected values. */
  multi: Record<string, string[]>;
  /** Checkboxes: name → { on: value posted when ticked, checked }. */
  checks: Record<string, { on: string; checked: boolean }>;
  /** Option lists for every select. */
  options: Record<string, FormOption[]>;
  /** The raw name/value pairs a browser would post right now. */
  pairs: Array<[string, string]>;
  /** Field names in the order the form declares them (for diagnostics). */
  order: string[];
};

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(name + `=["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
};

/** Parse a rendered panel form into values / options / checkboxes. */
export function parseForm(html: string): ParsedForm {
  const values: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const checks: Record<string, { on: string; checked: boolean }> = {};
  const options: Record<string, FormOption[]> = {};
  const order: string[] = [];
  const seen = new Set<string>();
  const note = (n: string) => { if (!seen.has(n)) { seen.add(n); order.push(n); } };

  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const n = attr(tag, "name");
    if (!n || n.includes("{{")) continue;
    const type = (attr(tag, "type") || "text").toLowerCase();
    const val = decodeEntities(attr(tag, "value") || "");
    note(n);
    if (type === "checkbox") {
      checks[n] = { on: val || "1", checked: /\bchecked\b/i.test(tag) };
    } else if (type === "radio") {
      if (/\bchecked\b/i.test(tag)) values[n] = val; // an all-unchecked radio group posts nothing, like a browser
    } else if (type === "file") {
      /* never re-posted */
    } else {
      values[n] = val;
    }
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const n = attr(m[1], "name");
    if (!n || n.includes("{{")) continue;
    note(n);
    const isMulti = /\bmultiple\b/i.test(m[1]);
    const opts: FormOption[] = [];
    const selected: string[] = [];
    for (const o of m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const v = decodeEntities(attr(o[1], "value") ?? "");
      const t = decodeEntities(o[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      opts.push({ v, t });
      if (/\bselected\b/i.test(o[1])) selected.push(v);
    }
    options[n] = opts;
    /* Some panel selects carry their current value in data-selected and let JS
       pick the option after load (provisioning brand/model). A re-post that
       ignored it would send the first option ("-- Select One --") and wipe the
       phone's model. Honour it. */
    const dataSelected = attr(m[1], "data-selected");
    if (isMulti) multi[n] = selected;
    else values[n] = selected.length ? selected[0] : dataSelected != null && dataSelected !== "" ? decodeEntities(dataSelected) : (opts[0]?.v ?? "");
  }
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const n = attr(m[1], "name");
    if (!n || n.includes("{{")) continue;
    note(n);
    values[n] = decodeEntities(m[2]);
  }
  /* The pairs a browser would post, from the SAME parse (one truth): scalars in
     document order, one pair per selected multi option, checkboxes only when on. */
  const pairs: Array<[string, string]> = [];
  for (const n of order) {
    if (n in checks) { if (checks[n].checked) pairs.push([n, checks[n].on]); continue; }
    if (n in multi) { for (const v of multi[n]) pairs.push([n, v]); continue; }
    if (n in values) pairs.push([n, values[n]]);
  }
  return { values, multi, checks, options, pairs, order };
}

export type FormOverrides = {
  /** Scalars: name → value. */
  set?: Record<string, string | number | null | undefined>;
  /** Multi-selects: name (with []) → full new selection. */
  multi?: Record<string, string[]>;
  /** Checkboxes: name → on/off. Off = the pair is REMOVED. */
  checks?: Record<string, boolean>;
  /** Names to drop entirely (whatever their type). */
  drop?: string[];
};

/**
 * Apply a set of changes to the pairs a browser would post, honouring the
 * checkbox and multi-select rules. Returns a NEW array.
 */
export function applyOverrides(form: ParsedForm, ov: FormOverrides): Array<[string, string]> {
  let pairs: Array<[string, string]> = form.pairs.map(([k, v]) => [k, v]);
  const dropAll = (n: string) => { pairs = pairs.filter(([k]) => k !== n); };
  for (const n of ov.drop || []) dropAll(n);
  for (const [n, raw] of Object.entries(ov.set || {})) {
    if (raw == null) continue;
    const v = String(raw);
    const i = pairs.findIndex(([k]) => k === n);
    if (i >= 0) pairs[i] = [n, v];
    else pairs.push([n, v]);
  }
  for (const [n, vals] of Object.entries(ov.multi || {})) {
    dropAll(n);
    for (const v of vals) pairs.push([n, String(v)]);
  }
  for (const [n, on] of Object.entries(ov.checks || {})) {
    dropAll(n);
    if (on) pairs.push([n, form.checks[n]?.on || "1"]);
  }
  return pairs;
}

/** Load + parse a module form in the CURRENT tenant context. */
export async function loadParsedForm(s: PanelSession, cls: string, mode: string, data?: string | number | null): Promise<{ html: string; form: ParsedForm }> {
  const html = await s.loadForm(cls, mode, data);
  const form = parseForm(html);
  return { html, form };
}

/**
 * The panel answers a getContent request for a module the account may not open
 * with a "You don't have access" notification and NO html. Recognise it so the
 * console can say so in plain words instead of rendering an empty form.
 */
export function accessDeniedReason(raw: string): string | null {
  const m = raw.match(/don't have access to\s*(?:<b>)?"?<b>?([a-z_]+)/i) || raw.match(/don't have access to[^a-z_]*([a-z_]+)/i);
  if (m) return `The automation account has no access to the panel's "${m[1]}" module.`;
  return null;
}
