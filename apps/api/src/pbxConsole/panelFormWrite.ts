/**
 * PBX Console — turning an edited panel form back into the pairs a browser posts.
 *
 * The console draws whatever `panelSchema.ts` read off the panel, so the save
 * side must accept whatever that drew — without ever accepting anything else.
 * Everything here is pure: no session, no network, no database, so the rules
 * that decide what reaches the phone system are testable on their own.
 *
 * ⛔ THE CHECKBOX RULE, again. A browser OMITS an unticked checkbox; sending
 * `foo=no` TICKS it. `applyOverrides` in panelForm.ts owns that for ordinary
 * fields, and `expandRows` below owns it for checkboxes INSIDE repeat rows,
 * which `applyOverrides` never sees.
 */
import { applyOverrides, DEVICE_FIELDS, type ParsedForm } from "./panelForm";
import { schemaFieldNames, type PanelTab } from "./panelSchema";

/**
 * ⛔ AN EXTENSION'S DEVICE FIELDS ARE NOT PART OF ITS GENERAL SAVE, AND POSTING
 * THEM IS REFUSED BY AN UNLICENSED PANEL.
 *
 * The extension edit form carries one device's fields inline. Re-posting them
 * with the general save makes the panel treat the save as a device add: on a
 * licensed PBX that silently flips DTMF (this repo already records it), and on
 * an unlicensed one it is refused outright with "You've reached the maximum
 * number of allowed extensions" — proven on the Community-edition clone, where
 * the identical save passes once these are dropped.
 *
 * Devices are saved one at a time through `saveExtension`, against each
 * device's own form. The general save must leave them alone.
 */
export const generalOnlyPairs = (pairs: Array<[string, string]>): Array<[string, string]> =>
  pairs.filter(([k]) => !DEVICE_FIELDS.has(k));

/** The panel modules the console exposes, and how each is addressed. */
export const PANEL_MODULES = {
  tenants: { cls: "tenants", label: "Tenants", scope: "main" },
  extensions: { cls: "extensions", label: "Extensions", scope: "tenant" },
  trunks: { cls: "trunks", label: "Trunks", scope: "main" },
  "outbound-routes": { cls: "trunk_group", label: "Outbound Routes", scope: "main" },
  "route-selections": { cls: "ars", label: "Route Selection", scope: "main" },
  "ring-groups": { cls: "ring_group", label: "Ring Groups", scope: "tenant" },
  queues: { cls: "queues", label: "Queues", scope: "tenant" },
} as const satisfies Record<string, { cls: string; label: string; scope: "main" | "tenant" }>;

export type PanelModuleKey = keyof typeof PANEL_MODULES;

export const isPanelModule = (k: string): k is PanelModuleKey =>
  Object.prototype.hasOwnProperty.call(PANEL_MODULES, k);

/** What the screen sends back when somebody presses Save. */
export type PanelEditInput = {
  /** Scalars, selects, radios and textareas: name → value. */
  set?: Record<string, string | number | null | undefined>;
  /** Checkboxes: name → on/off. Off REMOVES the pair. */
  checks?: Record<string, boolean>;
  /** Multi-selects (names ending `[]`): name → the full new selection. */
  multi?: Record<string, string[]>;
  /** Repeat tables: group key → the full new row list. */
  rows?: Record<string, Array<Record<string, string | number | boolean | null | undefined>>>;
};

/**
 * Split a repeat cell name into the group it belongs to and the field within a
 * row, keeping which SHAPE the panel used.
 *
 * ⛔ The two shapes are not interchangeable and both are live on the queue
 * form: members post `queue_members[N][penalty]` with brackets but
 * `queue_members_N_extension_id` with underscores. Normalising them to one
 * shape posts a field name the panel does not recognise, which it silently
 * ignores — so the member's extension never changes and nothing reports an
 * error.
 */
export function splitRowCell(
  name: string,
): { group: string; field: string; shape: "bracket" | "underscore" } | null {
  const b = name.match(/^(.+?)\[N\]\[(.+)\]$/);
  if (b) return { group: b[1], field: b[2], shape: "bracket" };
  const u = name.match(/^(.+?)_N_(.+)$/);
  if (u) return { group: u[1], field: u[2], shape: "underscore" };
  return null;
}

/** The concrete pair name for row `i` of a cell. */
const rowPairName = (c: { group: string; field: string; shape: "bracket" | "underscore" }, i: number) =>
  c.shape === "bracket" ? `${c.group}[${i}][${c.field}]` : `${c.group}_${i}_${c.field}`;

/** Does this pair name belong to `group`'s rows, in either shape? */
const isRowPairOf = (name: string, group: string) =>
  new RegExp(`^${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\[\\d+\\]\\[|_\\d+_)`).test(name);

export class PanelEditError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Apply one screen's worth of edits to the pairs a browser would post.
 *
 * ⛔ Anything the schema did not offer is REFUSED, not ignored. The console
 * posts straight into the phone system's own save controller; a client that
 * could name arbitrary fields could set fields the screen never showed and
 * nobody would ever see it happen.
 */
export function buildPanelEditPairs(
  form: ParsedForm,
  tabs: PanelTab[],
  input: PanelEditInput,
  opts: { module?: PanelModuleKey } = {},
): Array<[string, string]> {
  const known = schemaFieldNames(tabs);

  for (const n of Object.keys(input.set || {})) {
    if (!known.has(n)) throw new PanelEditError("unknown_field", `the phone system's form has no field called "${n}"`);
  }
  for (const n of Object.keys(input.checks || {})) {
    if (!known.has(n)) throw new PanelEditError("unknown_field", `the phone system's form has no switch called "${n}"`);
  }
  for (const n of Object.keys(input.multi || {})) {
    if (!known.has(n)) throw new PanelEditError("unknown_field", `the phone system's form has no list called "${n}"`);
  }

  // Ordinary fields first — panelForm.ts owns the checkbox and multi rules.
  let pairs = applyOverrides(form, { set: input.set, checks: input.checks, multi: input.multi });

  // Then the repeat tables.
  for (const [group, rows] of Object.entries(input.rows || {})) {
    const cells = [...known]
      .map((n) => splitRowCell(n))
      .filter((c): c is NonNullable<ReturnType<typeof splitRowCell>> => !!c && c.group === group);
    if (!cells.length) {
      throw new PanelEditError("unknown_field", `the phone system's form has no row table called "${group}"`);
    }
    pairs = pairs.filter(([k]) => !isRowPairOf(k, group));
    rows.forEach((row, i) => {
      for (const c of cells) {
        const v = row[c.field];
        // ⛔ the checkbox rule, inside a row: false means NO PAIR at all.
        if (v === false || v == null || v === undefined) continue;
        if (v === true) {
          pairs.push([rowPairName(c, i), "1"]);
          continue;
        }
        pairs.push([rowPairName(c, i), String(v)]);
      }
    });
  }

  return opts.module === "extensions" ? generalOnlyPairs(pairs) : pairs;
}

/** A one-line summary of an edit, for the audit row. */
export function summariseEdit(input: PanelEditInput): Record<string, unknown> {
  return {
    fields: Object.keys(input.set || {}).length,
    switches: Object.keys(input.checks || {}).length,
    lists: Object.keys(input.multi || {}).length,
    tables: Object.fromEntries(Object.entries(input.rows || {}).map(([g, r]) => [g, r.length])),
    /** ⛔ names only — a value can be a SIP password or a voicemail PIN. */
    changed: [
      ...Object.keys(input.set || {}),
      ...Object.keys(input.checks || {}),
      ...Object.keys(input.multi || {}),
    ].sort(),
  };
}
