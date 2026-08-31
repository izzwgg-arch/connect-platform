"use client";

/**
 * Admin → Onboarding — invite a customer, then watch what they do.
 *
 * Built to the mock-up Izzy approved on 2026-08-24. The screen it replaced
 * could only make a link and hand it to you as text; the "Main Email" box on it
 * read like it emailed the customer and never did — across 23 sign-ups the
 * platform had sent ZERO invitation emails.
 *
 * ⛔ "Just make me a link" is not a lesser button. Plenty of these customers are
 * easier to reach on WhatsApp than by email, so sending never hides the link:
 * the confirmation keeps it on screen with a Copy button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, apiDelete } from "../../../../services/apiClient";
import "./onboarding-admin.css";

type Invitation = {
  id: string;
  companyName: string;
  contactName: string;
  mainEmail: string;
  publicPath: string | null;
  state: "not_opened" | "in_progress" | "stalled" | "awaiting_payment" | "building" | "live" | "cancelled";
  stateLabel: string;
  storyLine: string;
  needsNudge: boolean;
  canResend: boolean;
  createdAt: string;
  openedAt: string | null;
};

type Counts = { all: number; nudge: number; inProgress: number; finished: number };
type Filter = "all" | "nudge" | "inProgress" | "finished";

const PILL_CLASS: Record<Invitation["state"], string> = {
  live: "oi-live",
  in_progress: "oi-doing",
  building: "oi-doing",
  awaiting_payment: "oi-paying",
  stalled: "oi-nudge",
  not_opened: "oi-cold",
  cancelled: "oi-cold",
};

function absoluteLink(path: string | null): string | null {
  if (!path) return null;
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return null;
  }
}

export default function AdminOnboardingPage() {
  const [rows, setRows] = useState<Invitation[]>([]);
  const [counts, setCounts] = useState<Counts>({ all: 0, nudge: 0, inProgress: 0, finished: 0 });
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  // What the link is FOR: the full sign-up, or one scoped job — "just submit a
  // port" / "just add extensions" (Izzy, 2026-08-30). Scoped links open a
  // single short flow with no payment step.
  const [kind, setKind] = useState<"full" | "port" | "extension">("full");
  const [busy, setBusy] = useState<"send" | "link" | null>(null);
  const [taken, setTaken] = useState<{ tenantName: string | null } | null>(null);
  const [sent, setSent] = useState<{ email: string | null; link: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ invitations: Invitation[]; counts: Counts }>("/admin/onboarding/invitations");
      setRows(res.invitations || []);
      setCounts(res.counts || { all: 0, nudge: 0, inProgress: 0, finished: 0 });
      setError(null);
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "We couldn't load the invitations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Warn as they type if the address already has a Loopcom login — inviting one
  // runs the whole sign-up and then silently fails to send that person their
  // welcome email, because addresses are unique across the whole platform.
  const checkTimer = useRef<any>(null);
  useEffect(() => {
    const value = email.trim();
    if (checkTimer.current) clearTimeout(checkTimer.current);
    if (!value.includes("@")) {
      setTaken(null);
      return;
    }
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await apiGet<{ taken: boolean; tenantName: string | null }>(
          `/admin/onboarding/email-check?email=${encodeURIComponent(value)}`,
        );
        setTaken(res.taken ? { tenantName: res.tenantName } : null);
      } catch {
        setTaken(null); // never block sending over a failed check
      }
    }, 400);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [email]);

  async function create(send: boolean) {
    setBusy(send ? "send" : "link");
    setError(null);
    try {
      const res = await apiPost<{ link: string; sent: boolean; emailError: string | null }>(
        "/admin/onboarding/invitations",
        { email: email.trim() || undefined, companyName: company.trim() || undefined, send, kind },
      );
      setSent({ email: send && res.sent ? email.trim() : null, link: res.link });
      if (send && !res.sent) {
        setError("We couldn't send that email. The link below still works — copy it and send it yourself.");
      }
      setEmail("");
      setCompany("");
      setKind("full");
      setTaken(null);
      await refresh();
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  async function resend(row: Invitation) {
    setRowBusy(row.id);
    setError(null);
    try {
      await apiPost(`/admin/onboarding/submissions/${encodeURIComponent(row.id)}/resend`, {});
      setCopied(`resent:${row.id}`);
      setTimeout(() => setCopied(null), 2500);
      await refresh();
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "We couldn't resend that invitation.");
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(row: Invitation) {
    const label = row.companyName || row.mainEmail || "this link";
    if (!confirm(`Delete the sign-up for ${label}? This can't be undone.`)) return;
    setRowBusy(row.id);
    try {
      await apiDelete(`/admin/onboarding/submissions/${encodeURIComponent(row.id)}`);
      await refresh();
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "We couldn't delete that.");
    } finally {
      setRowBusy(null);
    }
  }

  function copy(text: string, key: string) {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard blocked — the link is on screen either way */
    }
  }

  const visible = useMemo(() => {
    const passes = (r: Invitation) =>
      filter === "all"
        ? true
        : filter === "nudge"
          ? r.needsNudge
          : filter === "finished"
            ? r.state === "live"
            : r.state === "in_progress" || r.state === "awaiting_payment" || r.state === "building";
    return rows.filter(passes);
  }, [rows, filter]);

  // Links nobody ever opened, with nothing to chase, are folded away — most of
  // them have no name and no email, so there is no action available on them.
  const dead = useMemo(
    () => (filter === "all" ? visible.filter((r) => r.state === "not_opened" && !r.mainEmail && !r.companyName) : []),
    [visible, filter],
  );
  const shown = useMemo(() => visible.filter((r) => !dead.includes(r)), [visible, dead]);

  return (
    <div className="oi-root">
      <h1 className="oi-h1">Onboarding</h1>
      <p className="oi-sub">
        Send a new customer the link that sets up their phone system.{" "}
        <Link href="/admin/onboarding/ports" style={{ color: "var(--accent)", fontWeight: 600 }}>Port queue &amp; texting registrations →</Link>
      </p>

      {sent ? (
        <div className="oi-card oi-sent">
          <p className="oi-sent-h">
            <span className="oi-tick">✓</span>
            {sent.email ? `Invitation sent to ${sent.email}` : "Your link is ready"}
          </p>
          <p className="oi-card-s" style={{ marginBottom: 0 }}>
            {sent.email
              ? "Here's the same link, in case you'd rather text it to them as well."
              : "Copy this and send it however suits the customer."}
          </p>
          <div className="oi-linkrow">
            <div className="oi-link" title={sent.link}>{sent.link}</div>
            <button className="oi-btn" type="button" onClick={() => copy(sent.link, "sent")}>
              {copied === "sent" ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="oi-meta">
            <span>Sent just now · not opened yet</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <button className="oi-btn oi-quiet" type="button" style={{ padding: "2px 0" }} onClick={() => setSent(null)}>
              Invite someone else
            </button>
          </div>
        </div>
      ) : (
        <div className="oi-card">
          <p className="oi-card-h">Invite a customer</p>
          <p className="oi-card-s">We'll email them the link. Or just make the link and send it yourself.</p>

          {/* What the link is for — a scoped link opens one short flow with no
              payment step, for a customer who already has an account. */}
          <div className="oi-filters" style={{ margin: "0 0 12px" }} role="radiogroup" aria-label="What the link is for">
            {(
              [
                ["full", "Full sign-up"],
                ["port", "Transfer a number only"],
                ["extension", "Add extensions only"],
              ] as ["full" | "port" | "extension", string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={kind === key}
                className={`oi-filter${kind === key ? " oi-on" : ""}`}
                onClick={() => setKind(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="oi-fields">
            <div className="oi-field">
              <label htmlFor="oi-email">Their email</label>
              <input
                id="oi-email"
                className={`oi-input${email.trim() ? " oi-filled" : ""}`}
                type="email"
                autoComplete="off"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="oi-field">
              <label htmlFor="oi-company">
                Company <span style={{ fontWeight: 400, opacity: 0.7 }}>— optional</span>
              </label>
              <input
                id="oi-company"
                className={`oi-input${company.trim() ? " oi-filled" : ""}`}
                autoComplete="off"
                placeholder="Their business name"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>
          </div>

          <div className="oi-foot">
            <button
              className="oi-btn oi-primary"
              type="button"
              disabled={busy !== null || !email.trim()}
              onClick={() => create(true)}
            >
              {busy === "send" ? "Sending…" : "Send the invitation"}
            </button>
            <span className="oi-or">or</span>
            <button className="oi-btn" type="button" disabled={busy !== null} onClick={() => create(false)}>
              {busy === "link" ? "Making it…" : "Just make me a link"}
            </button>
          </div>

          {/* The already-has-a-login warning is a FULL-sign-up concern (it
              kills the welcome email at the end). On a scoped link the address
              having a login is expected — it's an existing customer. */}
          {taken && kind === "full" ? (
            <div className="oi-warn">
              <span aria-hidden="true">⚠</span>
              <span>
                <b>Heads up —</b> this address already has a Loopcom login
                {taken.tenantName ? ` (${taken.tenantName})` : ""}. Their welcome email won't go out at the end of sign-up.
                Use a different address for the new company.
              </span>
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <div className="oi-warn" style={{ marginTop: 14 }}>
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="oi-sect">
        <h3>Invitations</h3>
        <div className="oi-filters">
          {(
            [
              ["all", "All", counts.all],
              ["nudge", "Needs a nudge", counts.nudge],
              ["inProgress", "In progress", counts.inProgress],
              ["finished", "Finished", counts.finished],
            ] as [Filter, string, number][]
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              className={`oi-filter${filter === key ? " oi-on" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label} <span className="oi-n">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? <p className="oi-sub">Loading…</p> : null}
      {!loading && shown.length === 0 && dead.length === 0 ? (
        <p className="oi-sub">
          {filter === "all" ? "No invitations yet — send the first one above." : "Nothing in this list right now."}
        </p>
      ) : null}

      {shown.map((r) => {
        const link = absoluteLink(r.publicPath);
        return (
          <div key={r.id} className={`oi-row${r.needsNudge ? " oi-nudge" : ""}`}>
            <div className="oi-who">
              <p className="oi-name">
                {r.companyName || <span className="oi-unnamed">Unnamed link</span>}
                {r.contactName ? <span style={{ opacity: 0.65, fontWeight: 400 }}>· {r.contactName}</span> : null}
              </p>
              <p className={`oi-email${r.mainEmail ? "" : " oi-none"}`}>
                {r.mainEmail || "no email — you can only copy this one"}
              </p>
              <p className="oi-when">{r.storyLine}</p>
            </div>
            <span className={`oi-pill ${PILL_CLASS[r.state]}`}>
              <i className="oi-d" />
              {r.stateLabel}
            </span>
            <div className="oi-acts">
              {link ? (
                <button className="oi-act" type="button" onClick={() => copy(link, `link:${r.id}`)}>
                  {copied === `link:${r.id}` ? "Copied" : "Copy link"}
                </button>
              ) : null}
              {r.canResend ? (
                <button className="oi-act" type="button" disabled={rowBusy === r.id} onClick={() => resend(r)}>
                  {copied === `resent:${r.id}` ? "Sent" : rowBusy === r.id ? "Sending…" : "Resend"}
                </button>
              ) : null}
              <Link className="oi-act oi-act-quiet" href={`/admin/onboarding/${encodeURIComponent(r.id)}`}>
                Open
              </Link>
              <button
                className="oi-more"
                type="button"
                title="Delete this sign-up"
                aria-label={`Delete the sign-up for ${r.companyName || r.mainEmail || "this link"}`}
                disabled={rowBusy === r.id}
                onClick={() => remove(r)}
              >
                ⋯
              </button>
            </div>
          </div>
        );
      })}

      {dead.length > 0 ? (
        showOld ? (
          <>
            {dead.map((r) => {
              const link = absoluteLink(r.publicPath);
              return (
                <div key={r.id} className="oi-row oi-nudge">
                  <div className="oi-who">
                    <p className="oi-name">
                      <span className="oi-unnamed">Unnamed link</span>
                    </p>
                    <p className="oi-email oi-none">no email — you can only copy this one</p>
                    <p className="oi-when">{r.storyLine}</p>
                  </div>
                  <span className="oi-pill oi-cold">
                    <i className="oi-d" />
                    {r.stateLabel}
                  </span>
                  <div className="oi-acts">
                    {link ? (
                      <button className="oi-act" type="button" onClick={() => copy(link, `link:${r.id}`)}>
                        {copied === `link:${r.id}` ? "Copied" : "Copy link"}
                      </button>
                    ) : null}
                    <Link className="oi-act oi-act-quiet" href={`/admin/onboarding/${encodeURIComponent(r.id)}`}>
                      Open
                    </Link>
                    <button className="oi-more" type="button" disabled={rowBusy === r.id} onClick={() => remove(r)}>
                      ⋯
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="oi-fold">
              <span>Showing every old link.</span>
              <button className="oi-act" type="button" onClick={() => setShowOld(false)}>
                Fold them away
              </button>
            </div>
          </>
        ) : (
          <div className="oi-fold">
            <span>
              <b style={{ color: "var(--text)" }}>
                {dead.length} older link{dead.length === 1 ? "" : "s"} nobody ever opened.
              </b>{" "}
              {dead.length === 1 ? "It has" : "Most have"} no name and no email.
            </span>
            <span>
              <button className="oi-act" type="button" onClick={() => setShowOld(true)}>
                Show them
              </button>
            </span>
          </div>
        )
      ) : null}

      <div className="oi-sect" style={{ marginTop: 26 }}>
        <h3>Across every sign-up</h3>
        <Link className="oi-act" href="/admin/onboarding/patterns">
          Where sign-ups get stuck →
        </Link>
      </div>
    </div>
  );
}
