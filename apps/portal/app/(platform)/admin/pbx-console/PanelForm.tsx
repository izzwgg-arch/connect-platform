"use client";
/**
 * PBX Console — the phone system's own form, drawn in Connect's theme.
 *
 * ⛔ THIS COMPONENT NAMES NO FIELD. It renders whatever the server read off the
 * panel: the panel's tabs, its section headings, its labels, its help text, its
 * required markers, its control types and its complete option lists, in the
 * panel's own order. That is the whole point — a VitalPBX upgrade that adds or
 * renames a field appears here the same day, and nothing can silently go
 * missing, because there is no list to fall out of.
 *
 * Layout mirrors the panel: two columns of label-left / control-right rows,
 * with the panel's own tabs across the top. Colours, radii and type sizes are
 * Connect's tokens, so it reads as part of the app.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectSelect, ConnectMultiSelect } from "../../../../components/ConnectSelect";

export type FormOption = { v: string; t: string };
export type PanelControl =
  | "text" | "password" | "textarea" | "select" | "multiselect" | "checkbox" | "file" | "radio"
  | "hidden";
export type PanelField = {
  name: string; label: string; type: PanelControl; required: boolean;
  help?: string; section?: string; options?: FormOption[]; placeholder?: string;
};
export type PanelRepeat = {
  columns: string[];
  cells: Array<{ name: string; type: PanelControl; options?: FormOption[]; dv?: string }>;
};
export type PanelTab = { id: string; label: string; fields: PanelField[]; repeats: PanelRepeat[] };

export type PanelFormData = {
  module: string;
  label: string;
  panelClass: string;
  scope: "main" | "tenant";
  id: string | null;
  tabs: PanelTab[];
  values: Record<string, string>;
  checks: Record<string, { on: string; checked: boolean }>;
  multi: Record<string, string[]>;
};

export type PanelEdit = {
  set: Record<string, string>;
  checks: Record<string, boolean>;
  multi: Record<string, string[]>;
  rows: Record<string, Array<Record<string, string | boolean>>>;
};

/** `foo[N][bar]` / `foo_N_bar` → which table a cell belongs to. */
function splitCell(name: string): { group: string; field: string } | null {
  const b = name.match(/^(.+?)\[N\]\[(.+)\]$/);
  if (b) return { group: b[1], field: b[2] };
  const u = name.match(/^(.+?)_N_(.+)$/);
  if (u) return { group: u[1], field: u[2] };
  return null;
}
const groupOf = (r: PanelRepeat): string => {
  for (const c of r.cells) { const s = splitCell(c.name); if (s) return s.group; }
  return r.cells[0]?.name || "rows";
};

/** `queue_members[0][member_id]` → { group, field, index }. */
function splitConcrete(name: string): { group: string; field: string; index: number } | null {
  const b = name.match(/^(.+?)\[(\d+)\]\[(.+)\]$/);
  if (b) return { group: b[1], field: b[3], index: Number(b[2]) };
  const u = name.match(/^(.+?)_(\d+)_(.+)$/);
  if (u) return { group: u[1], field: u[3], index: Number(u[2]) };
  return null;
}

/**
 * Read the rows the panel already has, straight out of its posted values.
 *
 * ⛔ A ROW IS MORE THAN ITS VISIBLE CELLS. Existing rows carry HIDDEN pairs the
 * template never shows — `queue_members[N][member_id]` is the standing example
 * — and they are how the panel tells "update this member" from "add a new
 * one". A row object therefore carries EVERY concrete pair of its group at its
 * index, not just the drawn cells; the extras ride along invisibly and travel
 * with the row through reorder and removal. Dropping them made the panel's
 * save controller throw (seen live on the clone).
 */
function readRows(r: PanelRepeat, data: PanelFormData): Array<Record<string, string | boolean>> {
  const group = groupOf(r);
  const byIndex = new Map<number, Record<string, string | boolean>>();
  for (const [k, v] of Object.entries(data.values)) {
    const c = splitConcrete(k);
    if (!c || c.group !== group) continue;
    if (!byIndex.has(c.index)) byIndex.set(c.index, {});
    byIndex.get(c.index)![c.field] = v;
  }
  for (const [k, v] of Object.entries(data.checks)) {
    const c = splitConcrete(k);
    if (!c || c.group !== group) continue;
    if (!byIndex.has(c.index)) byIndex.set(c.index, {});
    byIndex.get(c.index)![c.field] = v.checked;
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

export function PanelForm({
  data, busy, error, onCancel, onSave,
}: {
  data: PanelFormData;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: (edit: PanelEdit) => void;
}) {
  const [tab, setTab] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [multi, setMulti] = useState<Record<string, string[]>>({});
  const [rows, setRows] = useState<Record<string, Array<Record<string, string | boolean>>>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const initial = useRef<{ v: Record<string, string>; c: Record<string, boolean>; m: Record<string, string[]> }>({ v: {}, c: {}, m: {} });

  // Load the panel's current state into the controls, once per record.
  useEffect(() => {
    const v: Record<string, string> = {};
    const c: Record<string, boolean> = {};
    const m: Record<string, string[]> = {};
    for (const t of data.tabs) {
      for (const f of t.fields) {
        if (f.type === "checkbox") c[f.name] = !!data.checks[f.name]?.checked;
        else if (f.type === "multiselect") m[f.name] = data.multi[f.name] || [];
        else v[f.name] = data.values[f.name] ?? "";
      }
    }
    const r: Record<string, Array<Record<string, string | boolean>>> = {};
    for (const t of data.tabs) for (const rep of t.repeats) r[groupOf(rep)] = readRows(rep, data);
    initial.current = { v: { ...v }, c: { ...c }, m: { ...m } };
    setValues(v); setChecks(c); setMulti(m); setRows(r); setTouched(new Set()); setTab(0);
  }, [data]);

  const mark = (n: string) => setTouched((s) => (s.has(n) ? s : new Set(s).add(n)));
  const setV = (n: string, x: string) => { setValues((s) => ({ ...s, [n]: x })); mark(n); };
  const setC = (n: string, x: boolean) => { setChecks((s) => ({ ...s, [n]: x })); mark(n); };
  const setM = (n: string, x: string[]) => { setMulti((s) => ({ ...s, [n]: x })); mark(n); };

  const rowsDirty = useMemo(() => {
    const base: Record<string, string> = {};
    for (const t of data.tabs) for (const rep of t.repeats) base[groupOf(rep)] = JSON.stringify(readRows(rep, data));
    return Object.keys(rows).filter((g) => JSON.stringify(rows[g]) !== base[g]);
  }, [rows, data]);

  const changed = useMemo(() => {
    const out: string[] = [];
    for (const n of touched) {
      if (n in checks) { if (checks[n] !== initial.current.c[n]) out.push(n); continue; }
      if (n in multi) { if (multi[n].join(",") !== (initial.current.m[n] || []).join(",")) out.push(n); continue; }
      if (values[n] !== initial.current.v[n]) out.push(n);
    }
    return out;
  }, [touched, values, checks, multi]);

  const dirty = changed.length + rowsDirty.length;

  const save = () => {
    const edit: PanelEdit = { set: {}, checks: {}, multi: {}, rows: {} };
    for (const n of changed) {
      if (n in checks) edit.checks[n] = checks[n];
      else if (n in multi) edit.multi[n] = multi[n];
      else edit.set[n] = values[n];
    }
    for (const g of rowsDirty) edit.rows[g] = rows[g];
    onSave(edit);
  };

  const t = data.tabs[tab] || data.tabs[0];
  if (!t) return null;

  const control = (f: PanelField) => {
    const id = `pf-${f.name.replace(/[^a-z0-9]+/gi, "-")}`;
    if (f.type === "checkbox") {
      const on = !!checks[f.name];
      return (
        <label className="pf-switch">
          <input type="checkbox" id={id} checked={on} disabled={busy}
            onChange={(e) => setC(f.name, e.target.checked)} />
          <span className="pf-track"><span className="pf-knob" /></span>
          <span className="pf-onoff">{on ? "Yes" : "No"}</span>
        </label>
      );
    }
    if (f.type === "radio") {
      return (
        <div className="pf-radios" role="radiogroup" aria-label={f.label}>
          {(f.options || []).map((o) => (
            <label key={o.v} className={"pf-radio" + (values[f.name] === o.v ? " on" : "")}>
              <input type="radio" name={f.name} value={o.v} disabled={busy}
                checked={values[f.name] === o.v} onChange={() => setV(f.name, o.v)} />
              {o.t}
            </label>
          ))}
        </div>
      );
    }
    if (f.type === "multiselect") {
      const sel = multi[f.name] || [];
      return (
        <ConnectMultiSelect id={id} style={{ width: "100%" }}
          values={sel} disabled={busy}
          onChange={(vals) => setM(f.name, vals)}
          options={(f.options || []).map((o) => ({ value: o.v, label: o.t || " " }))} />
      );
    }
    if (f.type === "select") {
      return (
        <ConnectSelect id={id} style={{ width: "100%" }} value={values[f.name] ?? ""} disabled={busy}
          onChange={(v) => setV(f.name, v)}
          options={(f.options || []).map((o) => ({ value: o.v, label: o.t || " " }))} />
      );
    }
    if (f.type === "textarea") {
      return <textarea className="pf-ctl" id={id} rows={3} value={values[f.name] ?? ""} disabled={busy}
        onChange={(e) => setV(f.name, e.target.value)} />;
    }
    if (f.type === "file") {
      /* The panel takes a file here (CSV import, extension photo). Uploading
         one is not wired, so say so rather than drawing a control that does
         nothing when pressed. */
      return <span className="pf-help">Uploading a file is done in the phone system&rsquo;s own panel.</span>;
    }
    return (
      <input className="pf-ctl" id={id} type={f.type === "password" ? "password" : "text"}
        value={values[f.name] ?? ""} placeholder={f.placeholder || ""} disabled={busy}
        onChange={(e) => setV(f.name, e.target.value)} />
    );
  };

  // Fields in the panel's order, split at each section heading.
  const groups: Array<{ section?: string; fields: PanelField[] }> = [];
  for (const f of t.fields) {
    const last = groups[groups.length - 1];
    if (!last || last.section !== f.section) groups.push({ section: f.section, fields: [f] });
    else last.fields.push(f);
  }

  return (
    <div className="pf-editor">
      <div className="pf-ehead">
        <h2>{data.id ? "Edit" : "New"} {data.label.replace(/s$/, "")}</h2>
        <span className="pf-sub">
          {data.id ? `#${data.id}` : "not created yet"} · {data.tabs.reduce((a, x) => a + x.fields.length, 0)} fields
        </span>
        <span className="pf-spacer" />
        <button type="button" className="pc-btn pc-btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="pc-btn pc-btn-sm pc-btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="pf-tabs" role="tablist">
        {data.tabs.map((x, i) => (
          <button key={x.id} type="button" role="tab" aria-selected={i === tab}
            className={"pf-tab" + (i === tab ? " on" : "")} onClick={() => setTab(i)}>
            {x.label}<span className="pf-n">{x.fields.length + x.repeats.length}</span>
          </button>
        ))}
      </div>

      {error ? <div className="pf-err">{error}</div> : null}

      <div className="pf-body">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.section ? <div className="pf-legend">{g.section}</div> : null}
            <div className="pf-grid">
              {g.fields.map((f) => (
                <div className="pf-row" key={f.name}>
                  <label className={"pf-lab" + (f.help ? " pf-hashelp" : "")} title={f.help || undefined}>
                    {f.label} {f.required ? <b className="pf-req">*</b> : null}
                  </label>
                  <div className="pf-c">
                    {control(f)}
                    <code className="pf-name">{f.name}</code>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {t.repeats.map((repRaw, ri) => {
          /* hidden template cells (member_id) are never drawn — they ride
             invisibly inside the row objects and travel with each row */
          const rep = { ...repRaw, cells: repRaw.cells.filter((c) => c.type !== "hidden") };
          const g = groupOf(repRaw);
          const list = rows[g] || [];
          const set = (i: number, field: string, v: string | boolean) =>
            setRows((s) => {
              const next = (s[g] || []).map((r, j) => (j === i ? { ...r, [field]: v } : r));
              return { ...s, [g]: next };
            });
          return (
            <div className="pf-tw" key={g + ri}>
              <table className="pf-tbl">
                <thead>
                  <tr>
                    {rep.columns.map((c, i) => <th key={i}>{c}</th>)}
                    {rep.columns.length < rep.cells.length
                      ? rep.cells.slice(rep.columns.length).map((c, i) => <th key={"x" + i}>{splitCell(c.name)?.field || c.name}</th>)
                      : null}
                    <th className="pf-thx" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((row, i) => (
                    <tr key={i}>
                      {rep.cells.map((c) => {
                        const s = splitCell(c.name);
                        if (!s) return <td key={c.name} />;
                        const v = row[s.field];
                        return (
                          <td key={c.name}>
                            {c.type === "checkbox" ? (
                              <label className="pf-switch">
                                <input type="checkbox" checked={v === true} disabled={busy}
                                  onChange={(e) => set(i, s.field, e.target.checked)} />
                                <span className="pf-track"><span className="pf-knob" /></span>
                              </label>
                            ) : c.type === "select" ? (
                              <ConnectSelect size="sm" style={{ width: "100%" }} value={String(v ?? "")} disabled={busy}
                                onChange={(val) => set(i, s.field, val)}
                                options={(c.options || []).map((o) => ({ value: o.v, label: o.t || " " }))} />
                            ) : (
                              <input className="pf-ctl" type="text" value={String(v ?? "")} disabled={busy}
                                onChange={(e) => set(i, s.field, e.target.value)} />
                            )}
                          </td>
                        );
                      })}
                      <td className="pf-thx">
                        <button type="button" className="pf-x" title="Remove this row" disabled={busy}
                          onClick={() => setRows((s) => ({ ...s, [g]: (s[g] || []).filter((_, j) => j !== i) }))}>✕</button>
                      </td>
                    </tr>
                  ))}
                  {!list.length ? (
                    <tr><td className="pf-empty" colSpan={rep.cells.length + 1}>No rows.</td></tr>
                  ) : null}
                </tbody>
              </table>
              <button type="button" className="pf-add" disabled={busy}
                onClick={() => setRows((s) => ({ ...s, [g]: [...(s[g] || []), {}] }))}>+ Add row</button>
            </div>
          );
        })}
      </div>

      <div className="pf-savebar">
        <button type="button" className="pc-btn pc-btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="pc-btn pc-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <span className="pf-dirty">
          {dirty
            ? `${dirty} change${dirty === 1 ? "" : "s"} — not saved yet.`
            : "No changes."}
        </span>
      </div>
    </div>
  );
}
