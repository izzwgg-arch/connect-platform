/**
 * PBX Console — the panel form as a UI SCHEMA.
 *
 * `panelForm.ts` answers "what pairs would a browser post?". This answers the
 * other half: "what would a browser SHOW?" — the tabs, the section headings,
 * every field's label, help text, required marker, control type and full option
 * list, in the panel's own order.
 *
 * ⛔ THE POINT: nothing here hardcodes a field list. The console renders exactly
 * what the panel renders, so a VitalPBX upgrade that adds, removes or renames a
 * field shows up in Connect the same day, with no code change. The moment
 * somebody types a field name into this file or into the portal, the two can
 * drift — and the drift is silent, because a missing field just looks like a
 * field that was never there. `conferenceBuilder` already works this way; this
 * is the same rule applied to the whole console.
 *
 * Every rule below was read off the seven real rendered forms (tenants,
 * extensions, trunks, trunk_group, ars, ring_group, queues — 289 fields), not
 * from documentation. The three that cost real debugging time are marked ⛔.
 */
import { parseForm, type ParsedForm, type FormOption } from "./panelForm";

export type PanelControl =
  | "text" | "password" | "textarea" | "select" | "multiselect" | "checkbox" | "file" | "radio";

export type PanelField = {
  name: string;
  label: string;
  type: PanelControl;
  required: boolean;
  /** The panel's own hover help, when it has one. */
  help?: string;
  /** The `<div class="legend">` heading in force above this field, if any. */
  section?: string;
  options?: FormOption[];
  placeholder?: string;
};

/** A `table.repeat-wrapper` — patterns, members, custom settings. */
export type PanelRepeat = {
  columns: string[];
  /** One template cell per column; `[N]` stands in for the row index. */
  cells: Array<{ name: string; type: PanelControl; options?: FormOption[] }>;
};

export type PanelTab = { id: string; label: string; fields: PanelField[]; repeats: PanelRepeat[] };

/** The whole form: what to draw, plus what a browser would currently post. */
export type PanelSchema = { tabs: PanelTab[]; form: ParsedForm };

const RESERVED = new Set(["class", "method", "mode", "csfr_token"]);

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(name + `=["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
};

const decode = (t: string) =>
  t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));

/** Visible text of a fragment: tags out, entities decoded, whitespace collapsed. */
const txt = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** `foo[{{row-count-placeholder}}][bar]` and `foo_{{…}}_bar` both mean row N. */
const rowName = (n: string) => n.replace(/\{\{[^}]*\}\}/g, "N");

/**
 * ⛔ SCANNING CONTROLS IS AN ALTERNATION, NEVER AN OPTIONAL GROUP.
 *
 * The obvious shape — `<(select|input|textarea)\b([^>]*?)>(?:(.*?)<\/select>)?`
 * — is a trap in BOTH directions, and both were hit for real while building
 * this. GREEDY, the optional group runs from an `<input>` all the way to the
 * next `</select>` and swallows every field in between: that hid a whole "Last
 * Destination" section and a queue member column. LAZY (`??`), the group never
 * participates at all, so every `<select>` comes back with ZERO options.
 *
 * An alternation has neither failure mode: a `<select>` consumes exactly its
 * own body, and an `<input>` consumes only its own tag.
 */
const CONTROL_RE =
  /<select\b([^>]*)>([\s\S]*?)<\/select>|<input\b([^>]*?)>|<textarea\b([^>]*?)>/gi;

type Ctl = { index: number; kind: "select" | "input" | "textarea"; tag: string; inner: string };

/** Every control in a fragment, in document order. */
function scanControls(html: string): Ctl[] {
  const out: Ctl[] = [];
  for (const m of html.matchAll(CONTROL_RE)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) out.push({ index: at, kind: "select", tag: m[1], inner: m[2] ?? "" });
    else if (m[3] !== undefined) out.push({ index: at, kind: "input", tag: m[3], inner: "" });
    else out.push({ index: at, kind: "textarea", tag: m[4] ?? "", inner: "" });
  }
  return out;
}

function controlType(kind: string, tag: string): PanelControl | null {
  if (kind === "select") return /\bmultiple\b/i.test(tag) ? "multiselect" : "select";
  if (kind === "textarea") return "textarea";
  const t = (attr(tag, "type") || "text").toLowerCase();
  if (t === "hidden") return null;
  if (t === "checkbox") return "checkbox";
  if (t === "password") return "password";
  if (t === "file") return "file";
  if (t === "radio") return "radio";
  return "text";
}

/**
 * ⛔ A RADIO GROUP IS A REAL, VISIBLE CONTROL — do not skip it.
 *
 * The panel renders `technology` (PJSIP / IAX2 / VIRTUAL / TENANT …) as a
 * Bootstrap button group: one `<input type="radio">` per choice, each wrapped
 * in a `<label>` whose trailing text IS the choice's name. Treating radios as
 * "re-posted from the pairs, never drawn" silently dropped the single most
 * consequential field on both the extension and the trunk form.
 */
function radioOptions(block: string, name: string): FormOption[] {
  const out: FormOption[] = [];
  const re = new RegExp(
    `<input\\b[^>]*name=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([^<]*)`,
    "gi",
  );
  for (const m of block.matchAll(re)) {
    const v = attr(m[0], "value");
    if (v == null) continue;
    const label = txt(m[1] || "");
    out.push({ v: decode(v), t: label || decode(v) });
  }
  return out;
}

function optionsOf(inner: string): FormOption[] {
  const out: FormOption[] = [];
  for (const o of inner.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
    out.push({ v: decode(attr(o[1], "value") ?? ""), t: txt(o[2]) });
  }
  return out;
}

/** Parse a rendered panel form into the tabs/fields a browser would show. */
export function parseSchema(html: string): PanelTab[] {
  // ── tabs, in the order the panel lists them ────────────────────────────
  const tabs: Array<{ id: string; label: string }> = [];
  const ul = html.match(/<ul[^>]*class="[^"]*nav-tabs[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (ul) {
    for (const a of ul[1].matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      tabs.push({ id: a[1], label: txt(a[2]) });
    }
  }

  // ── each tab's slice of the document ───────────────────────────────────
  const paneAt: Array<[string, number]> = [];
  for (const m of html.matchAll(/<div[^>]*role="tabpanel"[^>]*id="([^"]+)"[^>]*>/gi)) {
    paneAt.push([m[1], m.index ?? 0]);
  }
  paneAt.sort((a, b) => a[1] - b[1]);
  const bounds = new Map<string, [number, number]>();
  paneAt.forEach(([id, start], i) => {
    bounds.set(id, [start, i + 1 < paneAt.length ? paneAt[i + 1][1] : html.length]);
  });
  const list = tabs.length ? tabs : [{ id: "__all__", label: "General" }];
  if (!tabs.length) bounds.set("__all__", [0, html.length]);

  return list.map((t) => {
    const b = bounds.get(t.id);
    if (!b) return { id: t.id, label: t.label, fields: [], repeats: [] };
    const seg = html.slice(b[0], b[1]);

    // Section headings: the panel uses `<div class="legend">`, not <legend>.
    const legends: Array<[number, string]> = [];
    for (const m of seg.matchAll(/<div[^>]*class="[^"]*\blegend\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
      legends.push([m.index ?? 0, txt(m[1]).replace(/\*$/, "").trim()]);
    }
    const sectionAt = (pos: number): string | undefined => {
      let s: string | undefined;
      for (const [at, label] of legends) if (at < pos) s = label || undefined;
      return s;
    };

    // ── repeat-row tables ────────────────────────────────────────────────
    const repeats: PanelRepeat[] = [];
    const claimed = new Set<string>();
    for (const tm of seg.matchAll(/<table[^>]*class="[^"]*repeat-wrapper[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)) {
      const body = tm[1];
      const head = body.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
      const columns = head
        ? Array.from(head[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map((c) => txt(c[1])).filter(Boolean)
        : [];
      const tmpl = body.match(
        /<tr[^>]*>((?:(?!<\/tr>)[\s\S])*row-count-placeholder(?:(?!<\/tr>)[\s\S])*)<\/tr>/i,
      );
      const src = tmpl ? tmpl[1] : body;
      const cells: PanelRepeat["cells"] = [];
      for (const c of scanControls(src)) {
        const raw = attr(c.tag, "name");
        if (!raw) continue;
        const type = controlType(c.kind, c.tag);
        if (!type) continue;
        const name = rowName(raw);
        if (claimed.has(name)) continue;
        claimed.add(name);
        cells.push(c.kind === "select" ? { name, type, options: optionsOf(c.inner) } : { name, type });
      }
      repeats.push({ columns, cells });
    }

    // ── ordinary fields: one per `div.form-group` ────────────────────────
    const starts: number[] = [];
    for (const m of seg.matchAll(/<div[^>]*class="[^"]*form-group[^"]*"/gi)) starts.push(m.index ?? 0);
    starts.push(seg.length);
    const fields: PanelField[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < starts.length - 1; i++) {
      const blk = seg.slice(starts[i], starts[i + 1]);
      const labelBody = blk.match(/<label[^>]*class="[^"]*control-label[^"]*"[^>]*>([\s\S]*?)<\/label>/i);
      if (!labelBody) continue;
      const openTag = blk.match(/<label[^>]*class="[^"]*control-label[^"]*"[^>]*>/i)![0];

      /* ⛔ A block runs to the NEXT form-group, so the last one in a tab
         swallows whatever follows it — including a later section's controls.
         The control belongs to this label only if it is the FIRST in the block.
         Ignoring this filed the "No Release" checkbox as a destination
         dropdown, and lost the real checkbox entirely. */
      const first = scanControls(blk)[0];
      if (!first) continue;
      const raw = attr(first.tag, "name");
      if (!raw || RESERVED.has(raw) || raw.includes("{{")) continue;
      const type = controlType(first.kind, first.tag);
      if (!type) continue;
      if (seen.has(raw) || claimed.has(rowName(raw))) continue;
      seen.add(raw);

      const help = txt(attr(openTag, "data-content") || "");
      const f: PanelField = {
        name: raw,
        label: txt(labelBody[1]).replace(/\s*\*$/, "").trim(),
        type,
        required: /red-color/i.test(labelBody[1]),
      };
      if (help) f.help = help;
      const sec = sectionAt(starts[i]);
      if (sec) f.section = sec;
      if (type === "select" || type === "multiselect") f.options = optionsOf(first.inner);
      if (type === "radio") f.options = radioOptions(blk, raw);
      const ph = attr(first.tag, "placeholder");
      if (ph) f.placeholder = ph;
      fields.push(f);
    }

    /* ⛔ Loose controls. Some sections — "Last Destination" is the standing
       example — render bare selects under a legend with NO form-group wrapper.
       They are real, required fields; dropping them loses the destination of
       every ring group and queue. */
    for (const c of scanControls(seg)) {
      const raw = attr(c.tag, "name");
      if (!raw || RESERVED.has(raw) || raw.includes("{{")) continue;
      if (seen.has(raw) || claimed.has(rowName(raw)) || raw.includes("[")) continue;
      const type = controlType(c.kind, c.tag);
      if (!type) continue;
      seen.add(raw);
      const f: PanelField = {
        name: raw,
        label: txt(attr(c.tag, "id") || raw).replace(/[_-]+/g, " ").replace(/(^|\s)\S/g, (s) => s.toUpperCase()),
        type,
        required: /data-rule-required/i.test(c.tag),
      };
      const sec = sectionAt(c.index);
      if (sec) f.section = sec;
      if (type === "select" || type === "multiselect") f.options = optionsOf(c.inner);
      if (type === "radio") f.options = radioOptions(seg, raw);
      fields.push(f);
    }

    return { id: t.id, label: t.label, fields, repeats };
  });
}

/** What to draw AND what a browser would post, from one parse of one document. */
export function describeForm(html: string): PanelSchema {
  return { tabs: parseSchema(html), form: parseForm(html) };
}

/** Every field name the schema offers — used to refuse writes to unknown names. */
export function schemaFieldNames(tabs: PanelTab[]): Set<string> {
  const out = new Set<string>();
  for (const t of tabs) {
    for (const f of t.fields) out.add(f.name);
    for (const r of t.repeats) for (const c of r.cells) out.add(c.name);
  }
  return out;
}
