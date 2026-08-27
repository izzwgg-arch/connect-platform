"use client";

/**
 * Teach the Agent — Izzy, 2026-08-26: "every word or sentence the agent
 * doesn't understand should go in there. Next to that... a search box to
 * search the database for items, and I can just select the item and then
 * boom, enter." Built to the approved mockup (artifact 323aca92): the queue
 * of skipped phrases, an inline catalog search per row (↑/↓ pick, Enter
 * teaches, Esc jumps on), dismiss for non-items, and the taught-so-far
 * mistakes database underneath.
 *
 * Writes into the SAME SupermarketPhraseLesson table the rep-fix harvest
 * writes — one database, two teachers. A taught phrase is a strong HINT the
 * brain prefers, filled with a "?" the first few times, never a blind fill.
 */

import "./supermarket.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useUiLanguage } from "../../../hooks/useUiLanguage";
import { apiDelete, apiGet, apiPost, apiPut } from "../../../services/apiClient";
import { SmItemPhoto, hitSubtitle, money } from "./OrdersDesk";

export const SM_TEACH_PHRASES = [
  "Teach the Agent",
  "Words the agent didn't understand. Pick what each one means — once — and it learns forever.",
  "to teach", "taught", "auto-filled",
  "Needs teaching", "Taught", "Dismissed",
  "sorted by how often it's heard",
  "heard", "last:", "voicemail", "text", "call",
  "Search the catalog — item # or name…",
  "pick", "teach it", "next phrase",
  "Not an item — dismiss", "undo", "taught just now",
  "From now on this phrase auto-fills with this item (shown with a \"?\" the first few times).",
  "TAUGHT SO FAR — THE MISTAKES DATABASE",
  "What they say", "What it means", "Used", "Source",
  "taught by you", "learned from a rep's fix", "auto-filled", "times",
  "Nothing to teach right now — the agent understood everything recent.",
  "Nothing taught yet.", "No dismissed phrases.",
  "Bring back", "not in stock", "Loading…",
  "Couldn't save that — try again.",
  "HOUSE RULES — the agent follows these on every order",
  "Plain English. Takes effect on the very next order. Example: a dozen eggs means a pack of 12 large eggs — pick the cheapest in stock.",
  "Add a rule…", "Add rule", "Change", "Save", "Cancel", "Roll back", "Turn off", "Turn back on",
  "was:", "No rules yet — write the first one above.",
  "Switched-off rules", "replaced by a newer correction",
  "Couldn't save the rule — try again.",
] as string[];

type RuleRow = {
  id: string;
  text: string;
  active: boolean;
  history: Array<{ text: string; at: string }>;
};

/**
 * House rules (Izzy 2026-08-27): one plain-English sentence per rule, fed to
 * the brain on every run. Editing keeps the old wording; Roll back restores
 * it; Turn off retires a rule without losing it.
 */
function HouseRules({ t }: { t: (s: string) => string }) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [newRule, setNewRule] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ rules: RuleRow[] }>("/supermarket/agent-rules");
      setRules(res.rules ?? []);
    } catch {
      /* the card stays; rows just don't fill */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setErr(null);
      try {
        await fn();
        await load();
      } catch {
        setErr(t("Couldn't save the rule — try again."));
      } finally {
        setBusy(false);
      }
    },
    [busy, load, t],
  );

  const add = () => {
    const text = newRule.trim();
    if (!text) return;
    void run(async () => {
      await apiPost("/supermarket/agent-rules", { text });
      setNewRule("");
    });
  };

  const active = rules.filter((r) => r.active);
  const off = rules.filter((r) => !r.active);
  const btn: React.CSSProperties = { fontSize: ".72rem", padding: ".2rem .55rem" };

  return (
    <div className="sm-ta-tablewrap" style={{ marginBottom: "1rem" }}>
      <div style={{ padding: ".7rem .9rem .2rem" }}>
        <div className="sm-asklist-h" style={{ marginBottom: 2 }}>{t("HOUSE RULES — the agent follows these on every order")}</div>
        <div className="sm-ta-sub">{t("Plain English. Takes effect on the very next order. Example: a dozen eggs means a pack of 12 large eggs — pick the cheapest in stock.")}</div>
      </div>
      <div style={{ display: "flex", gap: 8, padding: ".6rem .9rem" }}>
        <input
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={t("Add a rule…")}
          maxLength={300}
          disabled={busy}
          style={{ flex: 1, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, padding: ".45rem .7rem", color: "inherit", font: "inherit" }}
        />
        <button type="button" className="sm-ta-ghost" style={btn} disabled={busy || !newRule.trim()} onClick={add}>
          {t("Add rule")}
        </button>
      </div>
      {err ? <div className="sm-ta-why" style={{ padding: "0 .9rem .5rem" }}>{err}</div> : null}
      <div style={{ padding: "0 .9rem .8rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {active.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            {editId === r.id ? (
              <>
                <input
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  maxLength={300}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void run(async () => {
                      await apiPut(`/supermarket/agent-rules/${encodeURIComponent(r.id)}`, { text: editText.trim() });
                      setEditId(null);
                    });
                    if (e.key === "Escape") setEditId(null);
                  }}
                  style={{ flex: 1, background: "var(--panel-2)", border: "1px solid var(--accent)", borderRadius: 8, padding: ".4rem .6rem", color: "inherit", font: "inherit" }}
                />
                <button type="button" className="sm-ta-ghost" style={btn} disabled={busy || !editText.trim()} onClick={() => void run(async () => {
                  await apiPut(`/supermarket/agent-rules/${encodeURIComponent(r.id)}`, { text: editText.trim() });
                  setEditId(null);
                })}>
                  {t("Save")}
                </button>
                <button type="button" className="sm-ta-ghost" style={btn} disabled={busy} onClick={() => setEditId(null)}>{t("Cancel")}</button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, lineHeight: 1.45 }}>
                  {r.text}
                  {r.history.length > 0 ? (
                    <span className="sm-ta-dim" style={{ display: "block", fontSize: ".72rem" }}>
                      {t("was:")} {r.history[0].text}
                    </span>
                  ) : null}
                </span>
                <button type="button" className="sm-ta-ghost" style={btn} disabled={busy} onClick={() => { setEditId(r.id); setEditText(r.text); }}>
                  {t("Change")}
                </button>
                {r.history.length > 0 ? (
                  <button type="button" className="sm-ta-ghost" style={btn} disabled={busy} title={r.history[0].text} onClick={() => void run(async () => {
                    await apiPost(`/supermarket/agent-rules/${encodeURIComponent(r.id)}/rollback`);
                  })}>
                    {t("Roll back")}
                  </button>
                ) : null}
                <button type="button" className="sm-ta-del" title={t("Turn off")} disabled={busy} onClick={() => void run(async () => {
                  await apiPost(`/supermarket/agent-rules/${encodeURIComponent(r.id)}/active`, { active: false });
                })}>
                  ✕
                </button>
              </>
            )}
          </div>
        ))}
        {active.length === 0 ? <div className="sm-ta-dim" style={{ fontSize: ".8rem" }}>{t("No rules yet — write the first one above.")}</div> : null}
        {off.length > 0 ? (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            <div className="sm-ta-dim" style={{ fontSize: ".72rem", marginBottom: 4 }}>{t("Switched-off rules")}</div>
            {off.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", opacity: 0.65 }}>
                <span style={{ flex: 1, textDecoration: "line-through" }}>{r.text}</span>
                <button type="button" className="sm-ta-ghost" style={btn} disabled={busy} onClick={() => void run(async () => {
                  await apiPost(`/supermarket/agent-rules/${encodeURIComponent(r.id)}/active`, { active: true });
                })}>
                  {t("Turn back on")}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type QueueRow = {
  phrase: string;
  displayPhrase: string;
  qty: number;
  constraints?: string;
  reason: string;
  count: number;
  lastHeardAt: string;
  lastCustomer: string;
  lastSourceType: string;
};

type TaughtRow = {
  id: string;
  phrase: string;
  displayPhrase: string;
  source: string;
  timesConfirmed: number;
  timesUsed: number;
  product: { posProductId: string; code: string; name: string; brand?: string | null; unitPriceCents: number; imageUrl?: string | null };
};

type Hit = { posProductId: string; code: string; name: string; brand?: string | null; sizeText?: string | null; unitPriceCents: number; imageUrl?: string | null; onHand?: number | null };

function ago(iso: string, t: (s: string) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function TeachRow({
  row,
  onTaught,
  onDismiss,
  t,
}: {
  row: QueueRow;
  onTaught: (phrase: string, product: Hit) => void;
  onDismiss: (phrase: string) => void;
  t: (s: string) => string;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setHits([]);
      return;
    }
    let dead = false;
    const timer = setTimeout(() => {
      void apiGet<{ items: Hit[] }>(`/supermarket/catalog/search?q=${encodeURIComponent(term)}`)
        .then((res) => {
          if (!dead) {
            setHits(res.items ?? []);
            setSel(0);
          }
        })
        .catch(() => {});
    }, 120);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [q]);

  const teach = useCallback(
    async (hit: Hit) => {
      if (busy) return;
      setBusy(true);
      setErr(null);
      try {
        // the search text IS "what he meant to say" — taught as a second lesson
        await apiPost("/supermarket/phrase-teaching/teach", { phrase: row.displayPhrase, posProductId: hit.posProductId, ...(q.trim() ? { meantPhrase: q.trim() } : {}) });
        onTaught(row.phrase, hit);
      } catch {
        setErr(t("Couldn't save that — try again."));
      } finally {
        setBusy(false);
      }
    },
    [busy, row.displayPhrase, row.phrase, onTaught, t],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, Math.max(0, hits.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter" && hits[sel]) {
        e.preventDefault();
        void teach(hits[sel]);
      } else if (e.key === "Escape") {
        setQ("");
        setHits([]);
        // jump to the next row's search box, keyboard-only triage
        const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".sm-ta-search input"));
        const idx = boxes.indexOf(boxRef.current as HTMLInputElement);
        boxes[idx + 1]?.focus();
      }
    },
    [hits, sel, teach],
  );

  const srcLabel = row.lastSourceType === "voicemail" ? t("voicemail") : row.lastSourceType === "text" ? t("text") : t("call");

  return (
    <div className="sm-ta-row">
      <div>
        <div className="sm-ta-phrase">
          {row.qty > 1 ? <span className="sm-ta-dim">{row.qty}× </span> : null}
          {row.displayPhrase}
          {row.constraints ? <span className="sm-ta-dim"> ({row.constraints})</span> : null}
        </div>
        <div className="sm-ta-meta">
          {t("heard")} <b>{row.count}×</b> · {t("last:")} {ago(row.lastHeardAt, t)}
          {row.lastCustomer ? <> · {row.lastCustomer}</> : null} · {srcLabel}
        </div>
        {row.reason ? <div className="sm-ta-why">✗ {row.reason}</div> : null}
        <div className="sm-ta-btns">
          <button type="button" className="sm-ta-ghost" onClick={() => onDismiss(row.phrase)}>
            {t("Not an item — dismiss")}
          </button>
        </div>
      </div>
      <div className={`sm-ta-teach${hits.length ? " sm-ta-open" : ""}`}>
        <div className="sm-ta-search">
          <Search size={14} aria-hidden />
          <input
            ref={boxRef}
            value={q}
            placeholder={t("Search the catalog — item # or name…")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            disabled={busy}
          />
        </div>
        {hits.length > 0 ? (
          <div className="sm-ta-dd">
            {hits.map((h, i) => (
              <div
                key={h.posProductId}
                className={`sm-ta-opt${i === sel ? " sm-ta-sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => void teach(h)}
              >
                <SmItemPhoto url={h.imageUrl} size={30} />
                <span className="sm-ta-nm">
                  <b>
                    {h.name}
                    {h.onHand !== null && h.onHand !== undefined && h.onHand <= 0 ? <span className="sm-stock-pill">{t("not in stock")}</span> : null}
                  </b>
                  <span>{hitSubtitle(h) || h.code}</span>
                </span>
                <span className="sm-ta-pr">{money(h.unitPriceCents)}</span>
                {i === sel ? <span className="sm-ta-enter">↵ Enter</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {err ? <div className="sm-ta-why">{err}</div> : null}
        <div className="sm-ta-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> {t("pick")} · <kbd>Enter</kbd> {t("teach it")} · <kbd>Esc</kbd> {t("next phrase")}
        </div>
      </div>
    </div>
  );
}

export function TeachAgentInner() {
  const { t } = useUiLanguage(SM_TEACH_PHRASES);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [taught, setTaught] = useState<TaughtRow[]>([]);
  const [retired, setRetired] = useState<TaughtRow[]>([]);
  const [dismissed, setDismissed] = useState<Array<{ phrase: string }>>([]);
  const [justTaught, setJustTaught] = useState<Map<string, Hit>>(new Map());
  const [tab, setTab] = useState<"queue" | "taught" | "dismissed">("queue");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await apiGet<{ queue: QueueRow[]; taught: TaughtRow[]; retired?: TaughtRow[]; dismissed: Array<{ phrase: string }> }>(
        "/supermarket/phrase-teaching",
      );
      setQueue(res.queue ?? []);
      setTaught(res.taught ?? []);
      setRetired(res.retired ?? []);
      setDismissed(res.dismissed ?? []);
    } catch {
      /* the shell stays; rows just don't fill */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onTaught = useCallback(
    (phrase: string, product: Hit) => {
      setJustTaught((prev) => new Map(prev).set(phrase, product));
      // refresh the taught table quietly; the row itself flips green in place
      void reload();
    },
    [reload],
  );

  const onDismiss = useCallback(
    (phrase: string) => {
      setQueue((prev) => prev.filter((r) => r.phrase !== phrase));
      void apiPost("/supermarket/phrase-teaching/dismiss", { phrase }).then(() => reload()).catch(() => reload());
    },
    [reload],
  );

  const undoTeach = useCallback(
    (row: TaughtRow) => {
      void apiDelete(`/supermarket/phrase-teaching/lessons/${row.id}`).then(() => reload()).catch(() => reload());
    },
    [reload],
  );

  // rollback: bringing a retired lesson back retires whatever replaced it —
  // a clean toggle, so a wrong re-correction is one click to undo
  const restoreLessonRow = useCallback(
    (row: TaughtRow) => {
      void apiPost(`/supermarket/phrase-teaching/lessons/${row.id}/restore`).then(() => reload()).catch(() => reload());
    },
    [reload],
  );

  const unDismiss = useCallback(
    (phrase: string) => {
      void apiPost("/supermarket/phrase-teaching/dismiss", { phrase, undo: true }).then(() => reload()).catch(() => reload());
    },
    [reload],
  );

  const autoFilled = taught.reduce((n, r) => n + (r.timesUsed || 0), 0);
  const pending = queue.filter((r) => !justTaught.has(r.phrase));

  return (
    <div className="sm-root sm-app">
      <div className="sm-ta-page">
        <div className="sm-ta-head">
          <div>
            <h1>{t("Teach the Agent")}</h1>
            <div className="sm-ta-sub">{t("Words the agent didn't understand. Pick what each one means — once — and it learns forever.")}</div>
          </div>
          <div className="sm-ta-stats">
            <div className="sm-ta-stat sm-ta-hot"><b>{pending.length}</b><span>{t("to teach")}</span></div>
            <div className="sm-ta-stat"><b>{taught.length}</b><span>{t("taught")}</span></div>
            <div className="sm-ta-stat sm-ta-ok"><b>{autoFilled}</b><span>{t("auto-filled")}</span></div>
          </div>
        </div>

        <HouseRules t={t} />

        <div className="sm-ta-toolbar">
          <button type="button" className={`sm-ta-chip${tab === "queue" ? " sm-ta-on" : ""}`} onClick={() => setTab("queue")}>
            {t("Needs teaching")} ({pending.length})
          </button>
          <button type="button" className={`sm-ta-chip${tab === "taught" ? " sm-ta-on" : ""}`} onClick={() => setTab("taught")}>
            {t("Taught")} ({taught.length})
          </button>
          <button type="button" className={`sm-ta-chip${tab === "dismissed" ? " sm-ta-on" : ""}`} onClick={() => setTab("dismissed")}>
            {t("Dismissed")} ({dismissed.length})
          </button>
          <span className="sm-ta-sort">{t("sorted by how often it's heard")}</span>
        </div>

        {tab === "queue" ? (
          <>
            {queue.map((row) => {
              const won = justTaught.get(row.phrase);
              if (won) {
                return (
                  <div className="sm-ta-row sm-ta-done" key={row.phrase}>
                    <div>
                      <div className="sm-ta-phrase">{row.displayPhrase}</div>
                      <div className="sm-ta-why sm-ta-okwhy">✓ {t("taught just now")}</div>
                    </div>
                    <div className="sm-ta-teach">
                      <div className="sm-ta-learned">
                        <span className="sm-ta-ck">✓</span>
                        <span className="sm-ta-nm">
                          <b>{won.name}</b>
                          <span>{won.code}</span>
                        </span>
                      </div>
                      <div className="sm-ta-hint">{t("From now on this phrase auto-fills with this item (shown with a \"?\" the first few times).")}</div>
                    </div>
                  </div>
                );
              }
              return <TeachRow key={row.phrase} row={row} onTaught={onTaught} onDismiss={onDismiss} t={t} />;
            })}
            {!loading && queue.length === 0 ? (
              <div className="sm-ta-empty">{t("Nothing to teach right now — the agent understood everything recent.")}</div>
            ) : null}
            {loading ? <div className="sm-ta-empty">{t("Loading…")}</div> : null}
          </>
        ) : null}

        {tab === "taught" ? (
          <div className="sm-ta-tablewrap">
            <table className="sm-ta-table">
              <tbody>
                <tr>
                  <th>{t("What they say")}</th>
                  <th>{t("What it means")}</th>
                  <th>{t("Used")}</th>
                  <th>{t("Source")}</th>
                  <th></th>
                </tr>
                {taught.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.displayPhrase}</b></td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <SmItemPhoto url={r.product.imageUrl} size={24} />
                        {r.product.name} · {money(r.product.unitPriceCents)}
                      </span>
                    </td>
                    <td className="sm-ta-dim">{t("auto-filled")} {r.timesUsed}×</td>
                    <td>
                      {r.source === "taught" ? (
                        <span className="sm-ta-tag sm-ta-tag-human">{t("taught by you")}</span>
                      ) : (
                        <span className="sm-ta-tag sm-ta-tag-auto">{t("learned from a rep's fix")}</span>
                      )}
                    </td>
                    <td><button type="button" className="sm-ta-del" title={t("undo")} onClick={() => undoTeach(r)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {taught.length === 0 ? <div className="sm-ta-empty">{t("Nothing taught yet.")}</div> : null}
            {retired.length > 0 ? (
              <div style={{ padding: ".6rem .9rem", borderTop: "1px solid var(--border)" }}>
                <div className="sm-ta-dim" style={{ fontSize: ".72rem", marginBottom: 4 }}>{t("replaced by a newer correction")}</div>
                {retired.map((r) => (
                  <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", opacity: 0.65, padding: ".2rem 0" }}>
                    <span style={{ flex: 1 }}>
                      <b>{r.displayPhrase}</b> <span className="sm-ta-dim">→ {r.product.name}</span>
                    </span>
                    <button type="button" className="sm-ta-ghost" style={{ fontSize: ".72rem", padding: ".2rem .55rem" }} onClick={() => restoreLessonRow(r)}>
                      {t("Bring back")}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "dismissed" ? (
          <div className="sm-ta-tablewrap">
            <table className="sm-ta-table">
              <tbody>
                {dismissed.map((d) => (
                  <tr key={d.phrase}>
                    <td><b>{d.phrase}</b></td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="sm-ta-ghost" onClick={() => unDismiss(d.phrase)}>{t("Bring back")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dismissed.length === 0 ? <div className="sm-ta-empty">{t("No dismissed phrases.")}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
