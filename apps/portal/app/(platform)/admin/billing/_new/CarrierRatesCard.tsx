"use client";

/* Catalog → "What the carriers charge us": the one place every rate the cost
   card multiplies by lives. A typed rate is a new versioned row from today;
   closed periods keep the rate they were costed at. Also the door for pulling
   VoIP.ms history into the feed (office-only, read-only against the carrier). */

import { useCallback, useState } from "react";
import { apiPost, apiPut } from "../../../../../services/apiClient";
import { Pill, dateTime, errText, shortDate, useApi } from "./ui";

type RateRow = {
  key: string;
  carrier: string;
  label: string;
  unit: string;
  rate: number;
  defaultRate: number;
  effectiveFrom: string | null;
  source: "DEFAULT" | "TYPED" | "FEED";
  note: string | null;
  group: "calls" | "texting" | "caller_id" | "numbers";
};
type RatesResponse = { rates: RateRow[]; history: Array<{ key: string; rate: number; effectiveFrom: string; source: string; note: string | null }> };
type SyncStatus = { cursor: { lastDate: string | null; lastRunAt: string | null; lastError: string | null } | null; earliest: string | null; latest: string | null; records: number };

const GROUPS: Array<{ key: RateRow["group"]; label: string; hint: string }> = [
  { key: "calls", label: "Calls", hint: "per minute, 6-second steps" },
  { key: "texting", label: "Texting", hint: "per message" },
  { key: "caller_id", label: "Caller ID", hint: "per lookup" },
  { key: "numbers", label: "Monthly per number", hint: "per number per month" },
];

function fmtRate(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function CarrierRatesCard() {
  const rates = useApi<RatesResponse>("/admin/billing/cost/rates");
  const sync = useApi<SyncStatus>("/admin/billing/cost/sync");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const save = useCallback(
    async (key: string) => {
      const raw = edits[key];
      const rate = Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(rate)) return;
      setBusy(key);
      setErr("");
      setMsg("");
      try {
        await apiPut("/admin/billing/cost/rates", { key, rate });
        setMsg(`Saved — ${key} is $${fmtRate(rate)} from today.`);
        setEdits((e) => {
          const n = { ...e };
          delete n[key];
          return n;
        });
        void rates.reload();
      } catch (e: any) {
        setErr(errText(e, "Could not save that rate."));
      } finally {
        setBusy("");
      }
    },
    [edits, rates],
  );

  const pull = useCallback(async () => {
    if (!from || !to) return;
    setBusy("sync");
    setErr("");
    setMsg("");
    try {
      const r: any = await apiPost("/admin/billing/cost/sync", { from, to });
      const inserted = (r?.days || []).reduce((s: number, d: any) => s + (d.inserted || 0), 0);
      setMsg(r?.error ? `Stopped at ${r.error} — ${r.days?.length || 0} day(s) pulled first.` : `Pulled ${r?.days?.length || 0} day(s): ${inserted.toLocaleString()} new carrier records.`);
      void sync.reload();
    } catch (e: any) {
      setErr(errText(e, "The pull failed."));
    } finally {
      setBusy("");
    }
  }, [from, to, sync]);

  if (rates.error && /forbidden|403/i.test(rates.error)) return null;
  const list = rates.data?.rates || [];
  const s = sync.data;

  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h3>What the carriers charge us</h3>
          <Pill tone="warn">Office only</Pill>
        </div>
        <span className="hint">used by "What this customer cost us" on every invoice · a change applies from today; closed periods keep their rate</span>
      </div>
      {err && <div className="cbill-banner bad" style={{ margin: 12 }}>{err}</div>}
      {msg && <div className="cbill-banner ok" style={{ margin: 12 }}>{msg}</div>}
      <div className="cbill-table-wrap">
        <table className="cbill-table">
          <thead>
            <tr>
              <th>What</th>
              <th>Carrier</th>
              <th className="r">Rate ($)</th>
              <th>Unit</th>
              <th>In force since</th>
              <th>Where it comes from</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => (
              <GroupBlock key={g.key} g={g} rows={list.filter((r) => r.group === g.key)} edits={edits} setEdits={setEdits} busy={busy} save={save} />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ borderTop: "1px solid var(--cb-line)", padding: "12px 15px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 560 }}>VoIP.ms carrier feed</div>
          <div className="hint">
            {s
              ? s.records
                ? `${s.records.toLocaleString()} records on file · ${s.earliest ? shortDate(s.earliest) : "—"} to ${s.latest ? shortDate(s.latest) : "—"} · last pull ${s.cursor?.lastRunAt ? dateTime(s.cursor.lastRunAt) : "never"}${s.cursor?.lastError ? ` · last error: ${s.cursor.lastError}` : ""}`
                : "nothing pulled yet — it pulls the last 14 days by itself after the next restart, and every 6 hours after that"
              : sync.error || "…"}
          </div>
        </div>
        <label className="hint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Pull history from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ fontSize: 13, padding: "5px 8px", border: "1px solid var(--cb-line)", borderRadius: 6, background: "var(--cb-surface)", color: "var(--cb-ink)" }} />
          to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ fontSize: 13, padding: "5px 8px", border: "1px solid var(--cb-line)", borderRadius: 6, background: "var(--cb-surface)", color: "var(--cb-ink)" }} />
        </label>
        <button type="button" className="cbill-btn" disabled={!!busy || !from || !to} onClick={() => void pull()}>
          {busy === "sync" ? "Pulling… (a month takes a minute or two)" : "Pull from VoIP.ms"}
        </button>
      </div>
    </section>
  );
}

function GroupBlock({
  g,
  rows,
  edits,
  setEdits,
  busy,
  save,
}: {
  g: { key: string; label: string; hint: string };
  rows: RateRow[];
  edits: Record<string, string>;
  setEdits: (f: (e: Record<string, string>) => Record<string, string>) => void;
  busy: string;
  save: (key: string) => Promise<void>;
}) {
  return (
    <>
      <tr>
        <td colSpan={7} style={{ background: "var(--cb-surface-2)", fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 680, color: "var(--cb-muted)", padding: "7px 15px" }}>
          {g.label} <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>· {g.hint}</span>
        </td>
      </tr>
      {rows.map((r) => {
        const editing = edits[r.key] !== undefined;
        return (
          <tr key={r.key}>
            <td>{r.label}{r.note && <div style={{ fontSize: 10.5, color: "var(--cb-muted)" }}>{r.note}</div>}</td>
            <td>{r.carrier}</td>
            <td className="r">
              <input
                className="n"
                type="text"
                inputMode="decimal"
                aria-label={`${r.label} rate`}
                value={editing ? edits[r.key] : fmtRate(r.rate)}
                onChange={(e) => setEdits((prev) => ({ ...prev, [r.key]: e.target.value }))}
                style={{ width: 96, textAlign: "right", fontSize: 13, padding: "5px 8px", border: "1px solid var(--cb-line)", borderRadius: 6, background: "var(--cb-surface)", color: "var(--cb-ink)" }}
              />
            </td>
            <td style={{ color: "var(--cb-muted)" }}>{r.unit}</td>
            <td className="n" style={{ color: "var(--cb-muted)" }}>{r.effectiveFrom ? shortDate(r.effectiveFrom) : "default"}</td>
            <td>
              {r.source === "TYPED" ? <Pill tone="info">Typed</Pill> : r.source === "FEED" ? <Pill tone="ok">Carrier feed</Pill> : <Pill tone="off">Default</Pill>}
              {r.rate !== r.defaultRate && <span className="hint" style={{ marginLeft: 6 }}>was ${fmtRate(r.defaultRate)}</span>}
            </td>
            <td className="r">
              {editing && (
                <button type="button" className="cbill-btn primary" disabled={busy === r.key} onClick={() => void save(r.key)}>
                  {busy === r.key ? "Saving…" : "Save"}
                </button>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}
