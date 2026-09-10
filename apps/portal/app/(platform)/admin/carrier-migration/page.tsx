"use client";

/**
 * Admin → Carrier migration — moving every number off VoIP.ms and onto
 * SignalWire, a few at a time, without dropping a call or a text.
 *
 * The screen is built around the one idea that makes this safe: a number is
 * not one switch, it is THREE, on three different clocks.
 *
 *   Calls coming in  — move by themselves; the only gap is between the number
 *                      landing and being pointed at our trunk, which the
 *                      arrival watcher closes.
 *   Texts            — inbound moves by itself; OUTBOUND needs the 10DLC
 *                      registration approved first, or the customer can
 *                      receive texts and not answer them.
 *   Calls going out  — set once per CUSTOMER with one caller ID, on the phone
 *                      system. So numbers move as a block per customer, and
 *                      the switch itself is a change a person makes.
 *
 * SUPER_ADMIN only — the api refuses everyone else and this renders that
 * refusal honestly rather than an empty board.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiGet, apiPost } from "../../../../services/apiClient";
import "./carrierMigration.css";

type Carrier = "voipms" | "signalwire";

type Gate = {
  id: "tendlc" | "attestation" | "voice";
  level: "ok" | "pending" | "blocked";
  title: string;
  status: string;
  detail: string;
};

type BoardNumber = {
  did: string;
  formatted: string;
  e164: string;
  tenantId: string | null;
  tenantName: string;
  status: string;
  stage: string;
  voice: Carrier;
  sms: Carrier | "none";
  hasTexting: boolean;
  blockers: string[];
  holdReason: string | null;
  protectedReason: string | null;
  portReference: string | null;
  focDate: string | null;
  landedAt: string | null;
  pointedAt: string | null;
  lastError: string | null;
  claimSeconds: number | null;
};

type BoardCustomer = {
  tenantId: string | null;
  tenantName: string;
  numbers: BoardNumber[];
  outbound: { level: "ok" | "pending" | "blocked"; label: string; detail: string };
  protectedCount: number;
};

type BoardResponse = {
  gates: Gate[];
  summary: { total: number; onVoipms: number; moving: number; onSignalwire: number; textingNumbers: number; customers: number };
  customers: BoardCustomer[];
};

type DetailResponse = {
  number: BoardNumber;
  customer: { tenantId: string | null; tenantName: string; outbound: BoardCustomer["outbound"]; numberCount: number };
  gates: Gate[];
  smsSwitch: { allowed: boolean; reason?: string; message: string };
};

type EventRow = { id: string; at: string; event: string; payload: any };

function carrierChip(c: Carrier | "none", kind: "voice" | "sms") {
  if (c === "none") return <span className="cm-chip cm-chip--none">No texting</span>;
  if (c === "signalwire") return <span className={`cm-chip ${kind === "voice" ? "cm-chip--ok" : "cm-chip--ok"}`}>SignalWire</span>;
  return <span className="cm-chip cm-chip--old">VoIP.ms</span>;
}

function stageClass(n: BoardNumber): string {
  if (n.status === "live" || n.status === "done") return "cm-stage cm-stage--live";
  if (n.status === "held" || n.blockers.length > 0) return "cm-stage cm-stage--blocked";
  return "cm-stage";
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

export default function CarrierMigrationPage() {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDid, setOpenDid] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailMsg, setDetailMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [portRef, setPortRef] = useState("");
  const [focDate, setFocDate] = useState("");
  const [holdReason, setHoldReason] = useState("");

  const load = useCallback(async () => {
    try {
      const b = await apiGet<BoardResponse>("/admin/carrier-migration/board");
      setBoard(b);
      setError(null);
    } catch (e: any) {
      setError(
        e instanceof ApiError && e.status === 403
          ? "This screen is for the platform owner."
          : e?.body?.message || "Couldn't load the migration board. Refresh to try again.",
      );
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const r = await apiGet<{ events: EventRow[] }>("/admin/carrier-migration/events?limit=40");
      setEvents(r.events || []);
    } catch {
      // The event feed is context, never the point — a failure here must not
      // take the board down with it.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadEvents();
  }, [load, loadEvents]);

  const openNumber = useCallback(async (did: string) => {
    setOpenDid(did);
    setDetail(null);
    setDetailMsg(null);
    setPortRef("");
    setFocDate("");
    setHoldReason("");
    try {
      const d = await apiGet<DetailResponse>(`/admin/carrier-migration/numbers/${encodeURIComponent(did)}`);
      setDetail(d);
      setPortRef(d.number.portReference || "");
      setFocDate(d.number.focDate ? d.number.focDate.slice(0, 10) : "");
    } catch (e: any) {
      setDetailMsg({ kind: "err", text: e?.body?.message || "Couldn't open that number." });
    }
  }, []);

  function closeDrawer() {
    setOpenDid(null);
    setDetail(null);
    setDetailMsg(null);
  }

  async function act(path: string, body: Record<string, unknown>, okText: string) {
    if (!openDid) return;
    setBusy(true);
    setDetailMsg(null);
    try {
      await apiPost(`/admin/carrier-migration/numbers/${encodeURIComponent(openDid)}/${path}`, body);
      setDetailMsg({ kind: "ok", text: okText });
      await Promise.all([load(), loadEvents()]);
      const d = await apiGet<DetailResponse>(`/admin/carrier-migration/numbers/${encodeURIComponent(openDid)}`);
      setDetail(d);
    } catch (e: any) {
      setDetailMsg({ kind: "err", text: e?.body?.message || "That didn't go through. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function runSweep() {
    setBusy(true);
    try {
      await apiPost("/admin/carrier-migration/sweep", {});
      await Promise.all([load(), loadEvents()]);
    } catch (e: any) {
      setError(e?.body?.message || "Couldn't run the check.");
    } finally {
      setBusy(false);
    }
  }

  const s = board?.summary;
  const pct = (n: number) => (s && s.total > 0 ? (n / s.total) * 100 : 0);

  return (
    <div className="cm-root">
      <div className="cm-head">
        <div>
          <h1>Carrier migration</h1>
          <div className="cm-sub">
            VoIP.ms → SignalWire
            {s ? ` · ${s.total} numbers · ${s.customers} customers` : ""} ·{" "}
            <Link href="/apps/signalwire" style={{ color: "var(--accent)" }}>
              SignalWire console
            </Link>
          </div>
        </div>
        <div className="cm-actions">
          <button type="button" className="cm-btn cm-btn--ghost" onClick={() => void runSweep()} disabled={busy}>
            Check for arrivals now
          </button>
          <button type="button" className="cm-btn" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="cm-msg cm-msg--err">{error}</div>}

      {board && (
        <>
          <div className="cm-gates">
            {board.gates.map((g) => (
              <div key={g.id} className={`cm-gate cm-gate--${g.level}`}>
                <h2>{g.title}</h2>
                <div className="cm-gate-status">{g.status}</div>
                <p>{g.detail}</p>
              </div>
            ))}
          </div>

          <div className="cm-strip">
            <div className="cm-strip-top">
              <span className="cm-strip-count">
                <b>{s!.onSignalwire}</b> of <b>{s!.total}</b> numbers moved
              </span>
              <span className="cm-legend">
                <span>
                  <i className="cm-dot" style={{ background: "var(--cm-old)" }} />
                  On VoIP.ms {s!.onVoipms}
                </span>
                <span>
                  <i className="cm-dot" style={{ background: "var(--cm-new)" }} />
                  Moving {s!.moving}
                </span>
                <span>
                  <i className="cm-dot" style={{ background: "var(--success)" }} />
                  On SignalWire {s!.onSignalwire}
                </span>
              </span>
            </div>
            <div className="cm-bar">
              {s!.onSignalwire > 0 && <i style={{ width: `${pct(s!.onSignalwire)}%`, background: "var(--success)" }} />}
              {s!.moving > 0 && <i style={{ width: `${pct(s!.moving)}%`, background: "var(--cm-new)" }} />}
              <i style={{ width: `${pct(s!.onVoipms - s!.moving)}%`, background: "var(--cm-old)" }} />
            </div>
          </div>

          <div className="cm-tablewrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Calls in</th>
                  <th>Texts</th>
                  <th>Stage</th>
                </tr>
              </thead>
              <tbody>
                {board.customers.map((c) => (
                  // The key belongs on the mapped element, which is the
                  // fragment — not the first <tr> inside it.
                  <Fragment key={`g-${c.tenantId || c.tenantName}`}>
                    <tr className="cm-grp">
                      <td colSpan={4}>
                        <span className="cm-grp-name">
                          {c.tenantName}
                          <span className="cm-grp-count">
                            {c.numbers.length} number{c.numbers.length === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className={`cm-grp-out cm-grp-out--${c.outbound.level}`} title={c.outbound.detail}>
                          Calls out: {c.outbound.label}
                        </span>
                      </td>
                    </tr>
                    {c.numbers.map((n) => (
                      <tr key={n.did}>
                        <td>
                          <button type="button" className="cm-num" onClick={() => void openNumber(n.did)}>
                            {n.formatted}
                          </button>
                        </td>
                        <td>{carrierChip(n.voice, "voice")}</td>
                        <td>{carrierChip(n.sms, "sms")}</td>
                        <td className={stageClass(n)}>
                          <b>{n.stage}</b>
                          {n.claimSeconds !== null && n.status === "live" && (
                            <span> · pointed at us in {n.claimSeconds}s</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {board.customers.length === 0 && <div className="cm-empty">No numbers on the estate yet.</div>}
          </div>

          <div className="cm-card">
            <h3>What happened</h3>
            <div className="cm-csub">Every filing, claim and switch, newest first.</div>
            {events.length === 0 ? (
              <div className="cm-note">Nothing yet.</div>
            ) : (
              <div className="cm-events">
                {events.map((e) => (
                  <div key={e.id}>
                    <span className="cm-ev-t">{shortTime(e.at)}</span> <b>{e.event}</b>{" "}
                    {e.payload?.did ? String(e.payload.did) : ""}{" "}
                    {typeof e.payload?.gapSeconds === "number" ? `· pointed in ${e.payload.gapSeconds}s` : ""}
                    {typeof e.payload?.claimed === "number" && e.event === "sweep"
                      ? `· considered ${e.payload.considered ?? 0}, claimed ${e.payload.claimed}`
                      : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {openDid && (
        <>
          <button type="button" className="cm-drawer-back" aria-label="Close" onClick={closeDrawer} />
          <aside className="cm-drawer" role="dialog" aria-label="Number detail">
            <div className="cm-drawer-head">
              <div>
                <h2>{detail?.number.formatted || openDid}</h2>
                <div className="cm-sub">
                  {detail ? `${detail.customer.tenantName} · ${detail.customer.numberCount} number${detail.customer.numberCount === 1 ? "" : "s"}` : "Loading…"}
                </div>
              </div>
              <button type="button" className="cm-x" onClick={closeDrawer} aria-label="Close">
                ×
              </button>
            </div>

            <div className="cm-drawer-body">
              {detailMsg && <div className={`cm-msg cm-msg--${detailMsg.kind}`}>{detailMsg.text}</div>}

              {detail && (
                <>
                  {detail.number.protectedReason && (
                    <div className="cm-protected">
                      <strong style={{ color: "var(--cm-ink-crit)" }}>This is one of ours.</strong>{" "}
                      {detail.number.protectedReason}
                    </div>
                  )}

                  <div className="cm-card">
                    <h3>Where it stands</h3>
                    <div className="cm-csub">{detail.number.stage}</div>
                    <dl className="cm-kv">
                      <dt>Calls coming in</dt>
                      <dd>{detail.number.voice === "signalwire" ? "SignalWire" : "VoIP.ms"}</dd>
                      <dt>Texts</dt>
                      <dd>{detail.number.sms === "none" ? "Not on this number" : detail.number.sms === "signalwire" ? "SignalWire" : "VoIP.ms"}</dd>
                      <dt>Calls going out</dt>
                      <dd title={detail.customer.outbound.detail}>{detail.customer.outbound.label}</dd>
                      {detail.number.portReference && (
                        <>
                          <dt>Port reference</dt>
                          <dd>{detail.number.portReference}</dd>
                        </>
                      )}
                      {detail.number.focDate && (
                        <>
                          <dt>Due</dt>
                          <dd>{shortTime(detail.number.focDate)}</dd>
                        </>
                      )}
                      {detail.number.landedAt && (
                        <>
                          <dt>Landed</dt>
                          <dd>{shortTime(detail.number.landedAt)}</dd>
                        </>
                      )}
                      {detail.number.pointedAt && (
                        <>
                          <dt>Pointed at us</dt>
                          <dd>
                            {shortTime(detail.number.pointedAt)}
                            {detail.number.claimSeconds !== null ? ` · ${detail.number.claimSeconds}s gap` : ""}
                          </dd>
                        </>
                      )}
                    </dl>
                    {detail.number.lastError && (
                      <div className="cm-msg cm-msg--warn" style={{ marginTop: 10 }}>
                        Last problem: {detail.number.lastError}
                      </div>
                    )}
                  </div>

                  {detail.number.blockers.length > 0 && (
                    <div className="cm-card">
                      <h3>Why it can't go yet</h3>
                      <div className="cm-csub">Clear these before filing.</div>
                      <ul className="cm-blockers">
                        {detail.number.blockers.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="cm-card">
                    <h3>Record the filing</h3>
                    <div className="cm-csub">
                      SignalWire has no porting API, so you file it in their dashboard and record it here. This never
                      contacts a carrier.
                    </div>
                    <div className="cm-field">
                      <label htmlFor="cm-ref">SignalWire order reference</label>
                      <input id="cm-ref" value={portRef} onChange={(e) => setPortRef(e.target.value)} placeholder="optional" />
                    </div>
                    <div className="cm-field">
                      <label htmlFor="cm-foc">Confirmed date it moves</label>
                      <input id="cm-foc" type="date" value={focDate} onChange={(e) => setFocDate(e.target.value)} />
                    </div>
                    <button
                      type="button"
                      className="cm-btn cm-btn--primary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          "filed",
                          { portReference: portRef.trim() || undefined, focDate: focDate ? new Date(`${focDate}T12:00:00Z`).toISOString() : undefined },
                          "Recorded. From the confirmed date we check every 30 seconds and point it at the phone system the moment it lands.",
                        )
                      }
                    >
                      Mark it filed
                    </button>
                  </div>

                  <div className="cm-card">
                    <h3>Move the texting</h3>
                    <div className="cm-csub">{detail.smsSwitch.message}</div>
                    <button
                      type="button"
                      className="cm-btn"
                      disabled={busy || !detail.smsSwitch.allowed}
                      onClick={() => void act("sms-switch", {}, "Texting on this number now sends through SignalWire.")}
                    >
                      Move texting to SignalWire
                    </button>
                  </div>

                  <div className="cm-card">
                    <h3>{detail.number.status === "held" ? "Held back" : "Hold it back"}</h3>
                    <div className="cm-csub">
                      {detail.number.status === "held"
                        ? detail.number.holdReason || "Held back by hand."
                        : "Keep this number out of every wave until somebody releases it."}
                    </div>
                    {detail.number.status === "held" ? (
                      <button type="button" className="cm-btn" disabled={busy} onClick={() => void act("hold", { hold: false }, "Released.")}>
                        Release it
                      </button>
                    ) : (
                      <>
                        <div className="cm-field">
                          <label htmlFor="cm-hold">Why</label>
                          <input id="cm-hold" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="e.g. account is in the overdue countdown" />
                        </div>
                        <button
                          type="button"
                          className="cm-btn cm-btn--danger"
                          disabled={busy}
                          onClick={() => void act("hold", { hold: true, reason: holdReason.trim() || undefined }, "Held back.")}
                        >
                          Hold it back
                        </button>
                      </>
                    )}
                  </div>

                  {(detail.number.status === "filed" || detail.number.status === "landing") && (
                    <div className="cm-card">
                      <h3>Point it at us now</h3>
                      <div className="cm-csub">
                        The watcher does this by itself. Use this only if you want to force a check this second.
                      </div>
                      <button type="button" className="cm-btn" disabled={busy} onClick={() => void act("claim", {}, "Pointed at the phone system.")}>
                        Check and claim now
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
