"use client";

/**
 * The Orders Desk — supermarket mode's home base (plan Phases 2–3).
 * ⛔ PORTED from the approved mockups ("The Orders Desk" v9, screens 1 + 2)
 * — port the mockup, do not re-derive it. Markup and classes mirror the
 * mockup with the uniform `sm-` prefix; styles live in ./supermarket.css.
 *
 * Screen 1 (the list): KPI strip, needs-review table, sent-with-tracking.
 * Screen 2 (draft review, ?draft=<id>): the original message beside the
 * editable order; ONE quick-add box — numbers or names, keyboard only
 * (↑/↓ move, Enter adds & refocuses, Esc clears, 3×104 adds three at once);
 * WIC auto-comment; notes; approve = the ONLY path to the register.
 *
 * ⛔ The page gates itself (PermissionGate) — hiding the sidebar item is
 * presentation, not access. The server additionally mode-gates every route.
 */

import "./supermarket.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ExternalLink, MessageCircle, Mic, Phone, Play, Search } from "lucide-react";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useUiLanguage } from "../../../hooks/useUiLanguage";
import { apiGet, apiPatch, apiPost, ApiError } from "../../../services/apiClient";

export const SM_ORDERS_PHRASES = [
  "Orders", "Supermarket mode", "New order",
  "Needs review", "Sent today", "From voicemail", "From texts",
  "Sent", "All orders", "Review", "Open",
  "Customer", "Received", "Draft", "Flags",
  "Voicemail", "Text", "Call", "items",
  "Nothing needs review right now.", "No orders yet today.",
  "Sent today — tracked by Loopcom",
  "What they sent", "Order draft — check & put through",
  "Translation:", "WIC mentioned", "Card on file",
  "Open original voicemail", "Open original text", "from voicemail", "from text", "from a call",
  "Item", "Qty", "Unit", "Subtotal", "Total",
  "item # or name", "move", "add & next", "clear",
  "typing a number adds by item # directly",
  "Comments — goes on the order", "Notes",
  "Send to a person", "Save for later", "Put order through", "Dismiss",
  "Pickup", "Delivery",
  "The order went through.", "Saved.",
  "This draft was already put through.",
  "Loading…", "This screen is switched off for your account.",
] as string[];

type DraftRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  threadId: string | null;
  customerName: string;
  customerPhone: string;
  posCustomerId: string | null;
  items: DraftItem[];
  comments: string;
  notes: string;
  status: string;
  orderMethod: string;
  posOrderId: string | null;
  submitError: string | null;
  createdAt: string;
  submittedAt: string | null;
  transcript?: string;
  translation?: string;
};

type DraftItem = {
  posProductId: string;
  code: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  matchedFrom?: string;
};

type CatalogHit = { posProductId: string; code: string; name: string; unitPriceCents: number; imageUrl?: string | null };

/**
 * One product-photo renderer for every supermarket surface. ⛔ A broken or
 * absent image must collapse to the neutral glyph, never a broken-image icon —
 * the desk-phone PhonePhoto lesson: give every <img> a real onError fallback.
 * URLs are the store's own webstore CDN (public, https — the portal CSP allows
 * any https image).
 */
function SmItemPhoto({ url, size }: { url?: string | null; size: number }) {
  const [dead, setDead] = useState(false);
  const box: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--panel-2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
  };
  if (!url || dead) {
    return (
      <span style={box} aria-hidden>
        <span style={{ fontSize: size * 0.5, lineHeight: 1, opacity: 0.45 }}>🛒</span>
      </span>
    );
  }
  return (
    <span style={box}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" width={size} height={size} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" onError={() => setDead(true)} />
    </span>
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ago(iso: string, t: (s: string) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr === 1 ? "1 hr ago" : `${hr} hr ago`;
}

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body: any = e.body;
    return body?.message || body?.error || e.message || fallback;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────

function OrdersList() {
  const { t } = useUiLanguage(SM_ORDERS_PHRASES);
  const router = useRouter();
  const [summary, setSummary] = useState<{ needsReview: number; submittedToday: number; fromVoicemail: number; fromText: number } | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [sent, setSent] = useState<DraftRow[]>([]);
  const [tab, setTab] = useState<"review" | "sent" | "all">("review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sum, needs, done] = await Promise.all([
        apiGet<any>("/supermarket/summary"),
        apiGet<{ drafts: DraftRow[] }>("/supermarket/drafts?status=NEEDS_REVIEW"),
        apiGet<{ drafts: DraftRow[] }>("/supermarket/drafts?status=SUBMITTED"),
      ]);
      setSummary(sum);
      setDrafts(needs.drafts ?? []);
      setSent(done.drafts ?? []);
      setError(null);
    } catch (e) {
      setError(errText(e, "Orders could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const newOrder = useCallback(async () => {
    try {
      const res = await apiPost<{ draft: DraftRow }>("/supermarket/drafts", { sourceType: "call" });
      router.push(`/orders?draft=${res.draft.id}`);
    } catch (e) {
      setError(errText(e, "A new order could not be started."));
    }
  }, [router]);

  const listShown = tab === "sent" ? sent : tab === "all" ? [...drafts, ...sent] : drafts;

  return (
    <div className="sm-content" style={{ minHeight: "auto" }}>
      <div className="sm-pagehead">
        <h3>{t("Orders")}</h3>
        <span className="sm-crumb">{t("Supermarket mode")}</span>
        <span className="sm-spacer" />
        <button type="button" className="sm-btn sm-ghost" onClick={() => void newOrder()}>＋ {t("New order")}</button>
      </div>

      <div className="sm-kpis">
        <div className="sm-kpi"><div className="sm-k">{t("Needs review")}</div><div className="sm-v">{summary?.needsReview ?? "—"}</div><div className="sm-d" /></div>
        <div className="sm-kpi"><div className="sm-k">{t("Sent today")}</div><div className="sm-v">{summary?.submittedToday ?? "—"}</div><div className="sm-d sm-up" /></div>
        <div className="sm-kpi"><div className="sm-k">{t("From voicemail")}</div><div className="sm-v">{summary?.fromVoicemail ?? "—"}</div><div className="sm-d" /></div>
        <div className="sm-kpi"><div className="sm-k">{t("From texts")}</div><div className="sm-v">{summary?.fromText ?? "—"}</div><div className="sm-d" /></div>
      </div>

      <div className="sm-toolbar">
        <span className="sm-tabs">
          <button type="button" className={`sm-tab${tab === "review" ? " sm-on" : ""}`} onClick={() => setTab("review")}>{t("Needs review")}</button>
          <button type="button" className={`sm-tab${tab === "sent" ? " sm-on" : ""}`} onClick={() => setTab("sent")}>{t("Sent")}</button>
          <button type="button" className={`sm-tab${tab === "all" ? " sm-on" : ""}`} onClick={() => setTab("all")}>{t("All orders")}</button>
        </span>
        <span className="sm-spacer" />
      </div>

      {error ? <p className="sm-mut" role="alert">{error}</p> : null}
      {loading ? <p className="sm-mut">{t("Loading…")}</p> : null}

      {tab !== "sent" ? (
        <div className="sm-table">
          <div className="sm-thead"><span /><span>{t("Customer")}</span><span>{t("Received")}</span><span>{t("Draft")}</span><span>{t("Flags")}</span><span /></div>
          {drafts.length === 0 && !loading ? (
            <div className="sm-trow"><span /><span className="sm-cellsub">{t("Nothing needs review right now.")}</span><span /><span /><span /><span /></div>
          ) : null}
          {drafts.map((d) => {
            const est = (d.items ?? []).reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
            const wic = /WIC/i.test(d.comments ?? "");
            return (
              <div className="sm-trow" key={d.id}>
                <span className="sm-srcic" aria-hidden>{d.sourceType === "voicemail" ? <Mic size={14} /> : d.sourceType === "text" ? <MessageCircle size={14} /> : <Phone size={14} />}</span>
                <div className="sm-who"><b>{d.customerName || d.customerPhone || "—"}</b><span>{d.customerPhone}{d.posCustomerId ? ` · acct ${d.posCustomerId}` : ""}</span></div>
                <span className="sm-cellsub">{t(d.sourceType === "voicemail" ? "Voicemail" : d.sourceType === "text" ? "Text" : "Call")} · {ago(d.createdAt, t)}</span>
                <span className="sm-cellsub"><span className="sm-amount">{(d.items ?? []).length} {t("items")} · {money(est)}</span> est.</span>
                <span>
                  {wic ? <span className="sm-pill sm-wic"><i />WIC</span> : null}{" "}
                  {(d.notes ?? "").length > 0 ? <span className="sm-pill sm-info"><i />note</span> : null}
                </span>
                <Link className="sm-btn sm-primary" href={`/orders?draft=${d.id}`}>{t("Review")}</Link>
              </div>
            );
          })}
        </div>
      ) : null}

      {tab !== "review" ? (
        <>
          <p className="sm-flab" style={{ margin: "1.2rem 0 0.5rem" }}>{t("Sent today — tracked by Loopcom")}</p>
          <div className="sm-table">
            {sent.length === 0 && !loading ? (
              <div className="sm-trow"><span /><span className="sm-cellsub">{t("No orders yet today.")}</span><span /><span /><span /><span /></div>
            ) : null}
            {sent.map((d) => {
              const total = (d.items ?? []).reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
              return (
                <div className="sm-trow" key={d.id}>
                  <span className="sm-srcic sm-done" aria-hidden><Check size={14} /></span>
                  <div className="sm-who"><b>{d.customerName || d.customerPhone || "—"}</b><span>{d.posOrderId ? `#${d.posOrderId} · ` : ""}{t(d.sourceType === "voicemail" ? "from voicemail" : d.sourceType === "text" ? "from text" : "from a call")}</span></div>
                  <span className="sm-cellsub"><span className="sm-amount">{money(total)}</span></span>
                  <span><span className="sm-pill sm-info"><i />{d.orderMethod}</span></span>
                  <span />
                  <Link className="sm-btn sm-quiet" href={`/orders?draft=${d.id}`}>{t("Open")}</Link>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function DraftReview({ draftId, compact }: { draftId: string; compact?: boolean }) {
  const { t } = useUiLanguage(SM_ORDERS_PHRASES);
  const router = useRouter();
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [comments, setComments] = useState("");
  const [notes, setNotes] = useState("");
  const [orderMethod, setOrderMethod] = useState<"Pickup" | "Delivery">("Pickup");
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── the ONE quick-add box (mockup note 5) ────────────────────────────────
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await apiGet<{ draft: DraftRow }>(`/supermarket/drafts/${encodeURIComponent(draftId)}`);
        if (dead) return;
        setDraft(res.draft);
        setItems(Array.isArray(res.draft.items) ? res.draft.items : []);
        setComments(res.draft.comments ?? "");
        setNotes(res.draft.notes ?? "");
        setOrderMethod(res.draft.orderMethod === "Delivery" ? "Delivery" : "Pickup");
      } catch (e) {
        if (!dead) setError(errText(e, "The draft could not be loaded."));
      }
    })();
    return () => {
      dead = true;
    };
  }, [draftId]);

  // Cursor lives in the box — always (mockup: "a rep never touches the mouse").
  useEffect(() => {
    boxRef.current?.focus();
  }, [draft]);

  // Suggestions as you type; a pure number is added directly on Enter.
  useEffect(() => {
    const term = q.replace(/^\d+[x×]/i, "").trim();
    if (term.length < 1) {
      setHits([]);
      setHi(0);
      return;
    }
    let dead = false;
    const timer = setTimeout(async () => {
      try {
        const res = await apiGet<{ items: CatalogHit[] }>(`/supermarket/catalog/search?q=${encodeURIComponent(term)}`);
        if (!dead) {
          setHits(res.items ?? []);
          setHi(0);
        }
      } catch {
        if (!dead) setHits([]);
      }
    }, 120);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [q]);

  const addHit = useCallback(
    (hit: CatalogHit, qty: number) => {
      setItems((prev) => {
        const existing = prev.find((i) => i.posProductId === hit.posProductId);
        if (existing) {
          return prev.map((i) => (i.posProductId === hit.posProductId ? { ...i, qty: Math.min(99, i.qty + qty) } : i));
        }
        return [...prev, { posProductId: hit.posProductId, code: hit.code, name: hit.name, qty, unitPriceCents: hit.unitPriceCents }];
      });
      setQ("");
      setHits([]);
      boxRef.current?.focus();
    },
    [],
  );

  const onBoxKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((v) => Math.min(hits.length - 1, v + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((v) => Math.max(0, v - 1));
        return;
      }
      if (e.key === "Escape") {
        setQ("");
        setHits([]);
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      // Register trick: 3×104 / 3x104 adds three of item 104 at once.
      const mult = q.match(/^(\d{1,2})[x×](.+)$/i);
      const qty = mult ? Math.max(1, Math.min(99, Number(mult[1]))) : 1;
      const term = (mult ? mult[2] : q).trim();
      if (!term) return;
      if (hits.length > 0) {
        addHit(hits[Math.max(0, Math.min(hi, hits.length - 1))], qty);
        return;
      }
      if (/^\d+$/.test(term)) {
        void apiGet<{ items: CatalogHit[] }>(`/supermarket/catalog/search?q=${encodeURIComponent(term)}`)
          .then((res) => {
            const exact = (res.items ?? []).find((i) => i.code === term) ?? (res.items ?? [])[0];
            if (exact) addHit(exact, qty);
          })
          .catch(() => {});
      }
    },
    [q, hits, hi, addHit],
  );

  const bumpQty = useCallback((posProductId: string, delta: number) => {
    setItems((prev) =>
      prev
        .map((i) => (i.posProductId === posProductId ? { ...i, qty: i.qty + delta } : i))
        .filter((i) => i.qty >= 1),
    );
  }, []);

  const subtotal = useMemo(() => items.reduce((s, i) => s + i.unitPriceCents * i.qty, 0), [items]);
  const readOnly = draft?.status === "SUBMITTED" || draft?.status === "SUBMITTING";

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await apiPatch(`/supermarket/drafts/${encodeURIComponent(draft.id)}`, { items: items as any, comments, notes, orderMethod });
      setOkMsg(t("Saved."));
      setError(null);
    } catch (e) {
      setError(errText(e, "The draft could not be saved."));
    } finally {
      setBusy(false);
    }
  }, [draft, items, comments, notes, orderMethod, t]);

  const putThrough = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await apiPost<any>(`/supermarket/drafts/${encodeURIComponent(draft.id)}/approve`, {
        items: items as any,
        comments,
        notes,
        orderMethod,
      });
      setOkMsg(res.alreadySubmitted ? t("This draft was already put through.") : t("The order went through."));
      setError(null);
      setDraft((d) => (d ? { ...d, status: "SUBMITTED", posOrderId: res.posOrderId ?? d.posOrderId } : d));
    } catch (e) {
      setError(errText(e, "The register did not accept the order."));
    } finally {
      setBusy(false);
    }
  }, [draft, items, comments, notes, orderMethod, t]);

  const dismiss = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await apiPost(`/supermarket/drafts/${encodeURIComponent(draft.id)}/dismiss`);
      router.push("/orders");
    } catch (e) {
      setError(errText(e, "The draft could not be dismissed."));
      setBusy(false);
    }
  }, [draft, router]);

  if (!draft) {
    return <p className="sm-mut" style={{ padding: "1rem" }}>{error ?? t("Loading…")}</p>;
  }

  const sourceHref = draft.sourceType === "voicemail" ? "/voicemail" : draft.sourceType === "text" ? "/chat" : null;

  return (
    <div className="sm-content" style={{ minHeight: "auto" }}>
      <div className="sm-pagehead">
        {compact ? null : (
          <span className="sm-crumb">
            <Link href="/orders" style={{ color: "inherit" }}>{t("Orders")}</Link> / <b>{draft.customerName || draft.customerPhone || "—"}</b>
          </span>
        )}
        <span className="sm-spacer" />
        <span className="sm-pill sm-info"><i />{t(draft.sourceType === "voicemail" ? "from voicemail" : draft.sourceType === "text" ? "from text" : "from a call")}</span>
        {sourceHref ? (
          <Link className="sm-btn sm-ghost" href={sourceHref}>
            <ExternalLink size={13} aria-hidden /> {t(draft.sourceType === "voicemail" ? "Open original voicemail" : "Open original text")}
          </Link>
        ) : null}
      </div>

      <div className="sm-review" style={compact ? { gridTemplateColumns: "1fr" } : undefined}>
        {draft.transcript ? (
          <div className="sm-card">
            <div className="sm-card-h">{t("What they sent")}</div>
            <div className="sm-card-b">
              {draft.sourceType === "voicemail" ? (
                <div className="sm-player"><span className="sm-play"><Play size={12} aria-hidden /></span><span className="sm-wave" /><span className="sm-dur" /></div>
              ) : null}
              <div className="sm-yid">{draft.transcript}</div>
              {draft.translation ? (
                <div className="sm-tr"><b>{t("Translation:")}</b> {draft.translation}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="sm-card">
          <div className="sm-card-h">{t("Order draft — check & put through")}</div>
          <div className="sm-card-b">
            <div className="sm-acct">
              {draft.posCustomerId ? <b>Acct {draft.posCustomerId}</b> : <b>{draft.customerPhone || "—"}</b>}
              {/WIC/i.test(comments) ? <span className="sm-pill sm-wic"><i />{t("WIC mentioned")}</span> : null}
            </div>

            <table className="sm-items">
              <tbody>
                <tr><th>{t("Item")}</th><th>{t("Qty")}</th><th className="sm-num">{t("Unit")}</th><th className="sm-num">{t("Subtotal")}</th></tr>
                {items.map((i) => (
                  <tr key={i.posProductId} className={i.matchedFrom === "name" ? "sm-flagged" : undefined}>
                    <td>{i.name || i.code}<br /><span className="sm-sku">{i.code}</span></td>
                    <td>
                      <span className="sm-qty">
                        <i role="button" tabIndex={-1} onClick={() => !readOnly && bumpQty(i.posProductId, -1)}>−</i>
                        <b>{i.qty}</b>
                        <i role="button" tabIndex={-1} onClick={() => !readOnly && bumpQty(i.posProductId, +1)}>＋</i>
                      </span>
                    </td>
                    <td className="sm-num">{money(i.unitPriceCents)}</td>
                    <td className="sm-num">{money(i.unitPriceCents * i.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!readOnly ? (
              <div style={{ marginBottom: ".8rem" }}>
                <div className="sm-fieldbox" style={{ borderColor: "var(--accent)", boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)", borderRadius: hits.length ? "9px 9px 0 0" : "9px" }}>
                  <Search size={13} aria-hidden style={{ color: "var(--text-dim)" }} />
                  <input
                    ref={boxRef}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={onBoxKey}
                    placeholder={t("item # or name")}
                    aria-label={t("item # or name")}
                    style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit", fontWeight: 700 }}
                  />
                </div>
                {hits.length > 0 ? (
                  <div style={{ border: "1px solid var(--border)", borderTop: 0, borderRadius: "0 0 9px 9px", background: "var(--panel)", overflow: "hidden" }}>
                    {hits.map((h, idx) => (
                      <div
                        key={h.posProductId}
                        role="option"
                        aria-selected={idx === hi}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          addHit(h, 1);
                        }}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "2rem 5.2rem 1fr auto",
                          gap: ".7rem",
                          padding: ".5rem .8rem",
                          alignItems: "center",
                          fontSize: ".84rem",
                          cursor: "pointer",
                          ...(idx === hi
                            ? { background: "color-mix(in srgb, var(--accent) 14%, transparent)", boxShadow: "inset 2px 0 0 var(--accent)" }
                            : { color: "var(--text-dim)", borderTop: "1px solid var(--border)" }),
                        }}
                      >
                        <SmItemPhoto url={h.imageUrl} size={28} />
                        <span className="sm-sku" style={{ fontSize: ".74rem" }}>{h.code}</span>
                        {idx === hi ? <b>{h.name}</b> : <span>{h.name}</span>}
                        <span className="sm-amount">{money(h.unitPriceCents)}</span>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: "1.1rem", padding: ".4rem .8rem", borderTop: "1px solid var(--border)", background: "var(--panel-2)", fontSize: ".68rem", color: "var(--text-dim)" }}>
                      <span><b style={{ color: "var(--text)" }}>↑ ↓</b> {t("move")}</span>
                      <span><b style={{ color: "var(--text)" }}>Enter</b> {t("add & next")}</span>
                      <span><b style={{ color: "var(--text)" }}>Esc</b> {t("clear")}</span>
                      <span className="sm-spacer" />
                      <span>{t("typing a number adds by item # directly")}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="sm-flab">{t("Comments — goes on the order")}</div>
            <div className="sm-fieldbox">
              <input
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                disabled={readOnly}
                aria-label={t("Comments — goes on the order")}
                style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }}
              />
              {/WIC/i.test(comments) ? <span className="sm-auto">auto</span> : null}
            </div>
            <div className="sm-flab">{t("Notes")}</div>
            <div className="sm-fieldbox">
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={readOnly}
                aria-label={t("Notes")}
                style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit" }}
              />
            </div>

            <div className="sm-flab">{t("Delivery")}</div>
            <div className="sm-fieldbox" style={{ gap: ".9rem" }}>
              <label style={{ display: "inline-flex", gap: ".35rem", alignItems: "center" }}>
                <input type="radio" name="sm-method" checked={orderMethod === "Pickup"} disabled={readOnly} onChange={() => setOrderMethod("Pickup")} /> {t("Pickup")}
              </label>
              <label style={{ display: "inline-flex", gap: ".35rem", alignItems: "center" }}>
                <input type="radio" name="sm-method" checked={orderMethod === "Delivery"} disabled={readOnly} onChange={() => setOrderMethod("Delivery")} /> {t("Delivery")}
              </label>
            </div>

            <div className="sm-totals"><span>{t("Subtotal")} <b>{money(subtotal)}</b></span><span>{t("Total")} <b>{money(subtotal)}</b></span></div>

            {error ? <p className="sm-mut" role="alert">{error}</p> : null}
            {okMsg ? <p className="sm-mut" role="status">{okMsg}</p> : null}

            {!readOnly ? (
              <div className="sm-actions">
                <button type="button" className="sm-btn sm-danger" disabled={busy} onClick={() => void dismiss()}>{t("Dismiss")}</button>
                <button type="button" className="sm-btn sm-quiet" disabled={busy} onClick={() => void save()}>{t("Save for later")}</button>
                <button type="button" className="sm-btn sm-primary" disabled={busy || items.length === 0} onClick={() => void putThrough()}>{t("Put order through")}</button>
              </div>
            ) : (
              <div className="sm-actions">
                <span className="sm-pill sm-done"><i />{draft.posOrderId ? `#${draft.posOrderId}` : t("The order went through.")}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function OrdersInner() {
  const params = useSearchParams();
  const draftId = params?.get("draft") ?? null;
  return <div className="sm-root sm-app">{draftId ? <DraftReview draftId={draftId} /> : <OrdersList />}</div>;
}

