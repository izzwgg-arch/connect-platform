"use client";

/**
 * Admin → Onboarding → one sign-up: exactly what the customer did, step by step.
 *
 * Izzy, 2026-08-24: "on each invitation, I should be able to see exactly what
 * the user did, step by step, in crazy detail, so we can analyze it later."
 *
 * ⛔ The detail was ALREADY being recorded and had been since the journey
 * beacons shipped — TYH Industries carries 98 events, to the second. What this
 * page replaced printed all 98 as one unbroken <ul> of raw ISO timestamps at
 * the bottom of the screen. So this is a reading problem, not a recording one,
 * which is why it works retroactively on every sign-up that has ever happened.
 *
 * The two lanes are deliberate: what the CUSTOMER did, and what WE did after
 * they paid, are different stories for different questions, and they used to be
 * jumbled into one list where reading either meant skipping past the other.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import "../onboarding-admin.css";

type Beat = { at: string; text: string; tone: "plain" | "good" | "warn" | "quiet" };
type StoryStep = {
  step: string;
  seconds: number | null;
  beats: Beat[];
  problems: number;
  reached: boolean;
  flag: string;
  tone: "ok" | "warn" | "hot";
};
type Phase = { title: string; from: string | null; to: string | null; beats: Beat[]; tone: "ok" | "warn" | "hot"; flag: string };
type Story = {
  summary: {
    invitedAt: string | null;
    openedAt: string | null;
    submittedAt: string | null;
    paidAt: string | null;
    activeSeconds: number | null;
    stepsReached: number;
    stepsTotal: number;
    blockedCount: number;
    emptySearchCount: number;
    searchCount: number;
    wentBackCount: number;
    lastActivityAt: string | null;
  };
  customer: StoryStep[];
  platform: Phase[];
  raw: Beat[];
};
type Payload = {
  submission: {
    id: string;
    companyName: string;
    contactName: string;
    mainEmail: string;
    status: string;
    publicPath: string | null;
    paidAmountCents: number | null;
    provisionedDid: string | null;
    pbxSetupStatus: string | null;
    setupError: string | null;
    createdTenantId: string | null;
    extensions: { extNumber: string; displayName: string | null; email: string | null }[];
  };
  story: Story;
};

type Lane = "customer" | "platform" | "raw";

function humanSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Wall-clock time of day, in the reader's own zone — these are read against
 *  "what happened at 4pm", never against a date. */
function clock(at: string): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

function dayAndClock(at: string | null): string {
  if (!at) return "—";
  try {
    const d = new Date(at);
    return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(at)}`;
  } catch {
    return "—";
  }
}

export default function AdminOnboardingStoryPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("customer");
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const apiBase = useMemo(() => getPortalApiBaseUrl(), []);

  const reload = useCallback(async () => {
    try {
      const r = await apiGet<Payload>(`/admin/onboarding/submissions/${encodeURIComponent(id)}/story`);
      setData(r);
      setError(null);
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "We couldn't load this sign-up.");
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function retrySetup() {
    setRetrying(true);
    setNotice(null);
    try {
      await apiPost(`/admin/onboarding/submissions/${encodeURIComponent(id)}/retry-setup`, {});
      setNotice("Setup is running again — the steps below will fill in as it goes.");
      await reload();
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "We couldn't restart the setup.");
    } finally {
      setRetrying(false);
    }
  }

  if (error && !data) {
    return (
      <div className="oi-root">
        <p className="oi-back">
          <Link href="/admin/onboarding">← Back to invitations</Link>
        </p>
        <div className="oi-warn">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }
  if (!data) return <div className="oi-root"><p className="oi-sub">Loading…</p></div>;

  const { submission: s, story } = data;
  const sum = story.summary;
  const name = s.companyName || s.mainEmail || "Unnamed sign-up";

  const stateLabel =
    s.status === "ACTIVE" || s.status === "COMPLETED"
      ? "Live"
      : s.status === "CANCELED"
        ? "Cancelled"
        : sum.paidAt
          ? "Setting up their phones"
          : sum.openedAt
            ? "Filling it in"
            : "Not opened yet";
  const pillClass =
    stateLabel === "Live" ? "oi-live" : stateLabel === "Not opened yet" || stateLabel === "Cancelled" ? "oi-cold" : "oi-doing";

  return (
    <div className="oi-root">
      <p className="oi-back">
        <Link href="/admin/onboarding">← Back to invitations</Link>
      </p>
      <div className="oi-crumb">
        <h1 className="oi-h1">{name}</h1>
        <span className={`oi-pill ${pillClass}`}>
          <i className="oi-d" />
          {stateLabel}
        </span>
      </div>
      <p className="oi-story-sub">
        {[
          s.mainEmail || "no email on file",
          sum.invitedAt ? `invited ${dayAndClock(sum.invitedAt)}` : null,
          sum.openedAt ? `opened it ${dayAndClock(sum.openedAt)}` : "never opened",
          sum.paidAt ? `paid ${dayAndClock(sum.paidAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="oi-kpis">
        <div className="oi-kpi">
          <b>{sum.activeSeconds != null ? humanSeconds(sum.activeSeconds) : "—"}</b>
          <span>{sum.paidAt ? "from opening the link to paying" : "from opening the link to their last move"}</span>
        </div>
        <div className="oi-kpi">
          <b>
            {sum.stepsReached} of {sum.stepsTotal}
          </b>
          <span>steps finished</span>
        </div>
        <div className={`oi-kpi${sum.blockedCount > 0 ? " oi-bad" : ""}`}>
          <b>{sum.blockedCount}×</b>
          <span>the wizard stopped them</span>
        </div>
        <div className={`oi-kpi${sum.emptySearchCount > 0 ? " oi-bad" : ""}`}>
          <b>{sum.emptySearchCount}</b>
          <span>searches that found nothing</span>
        </div>
        <div className="oi-kpi">
          <b>{sum.wentBackCount}×</b>
          <span>went back a step</span>
        </div>
      </div>

      <div className="oi-tabs">
        <button type="button" className={`oi-tab${lane === "customer" ? " oi-on" : ""}`} onClick={() => setLane("customer")}>
          What the customer did
        </button>
        <button type="button" className={`oi-tab${lane === "platform" ? " oi-on" : ""}`} onClick={() => setLane("platform")}>
          What we did
        </button>
        <button type="button" className={`oi-tab${lane === "raw" ? " oi-on" : ""}`} onClick={() => setLane("raw")}>
          Everything, raw
        </button>
        <span className="oi-spacer" />
        <a className="oi-tab" href={`${apiBase}/admin/onboarding/submissions/${encodeURIComponent(id)}/story.csv`}>
          ⭳ Export
        </a>
      </div>

      {notice ? (
        <div className="oi-warn" style={{ marginBottom: 14, borderColor: "var(--success)" }}>
          <span aria-hidden="true">✓</span>
          <span>{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div className="oi-warn" style={{ marginBottom: 14 }}>
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </div>
      ) : null}

      {lane === "customer" ? (
        <div className="oi-tl">
          {story.customer.map((step) => (
            <div key={step.step} className={`oi-tl-step oi-${step.tone}`}>
              <div className="oi-tl-head">
                <span className="oi-tl-name">{step.step}</span>
                <span className={`oi-tl-time${step.seconds != null && step.seconds >= 120 ? " oi-slow" : ""}`}>
                  {step.seconds != null ? humanSeconds(step.seconds) : ""}
                </span>
                <span className={`oi-tl-flag${step.tone === "warn" ? " oi-w" : step.tone === "hot" ? " oi-r" : " oi-g"}`}>
                  {step.flag}
                </span>
              </div>
              {step.beats.length ? (
                <div className="oi-tl-beats">
                  {step.beats.map((b, i) => (
                    <div key={i} className={`oi-beat${b.tone === "warn" ? " oi-w" : b.tone === "good" ? " oi-g" : b.tone === "quiet" ? " oi-quiet" : ""}`}>
                      <span className="oi-t">{clock(b.at)}</span>
                      <span className="oi-m">{b.text}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {lane === "platform" ? (
        story.platform.length === 0 ? (
          <p className="oi-sub">
            Nothing yet — we only start buying and building once the customer has paid.
          </p>
        ) : (
          <div className="oi-tl">
            {story.platform.map((phase) => (
              <div key={phase.title} className={`oi-tl-step oi-${phase.tone}`}>
                <div className="oi-tl-head">
                  <span className="oi-tl-name">{phase.title}</span>
                  <span className="oi-tl-time">
                    {phase.from ? clock(phase.from) : ""}
                    {phase.to && phase.to !== phase.from ? ` → ${clock(phase.to)}` : ""}
                  </span>
                  <span className={`oi-tl-flag${phase.tone === "warn" ? " oi-w" : phase.tone === "hot" ? " oi-r" : " oi-g"}`}>
                    {phase.flag}
                  </span>
                </div>
                <div className="oi-tl-beats">
                  {phase.beats.map((b, i) => (
                    <div key={i} className={`oi-beat${b.tone === "warn" ? " oi-w" : b.tone === "good" ? " oi-g" : ""}`}>
                      <span className="oi-t">{clock(b.at)}</span>
                      <span className="oi-m">{b.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}

      {lane === "raw" ? (
        <div className="oi-card">
          <p className="oi-card-h">Every recorded moment</p>
          <p className="oi-card-s">
            {story.raw.length} events, exactly as stored. Use Export to pull them out as a spreadsheet.
          </p>
          <div className="oi-tl-beats" style={{ borderLeft: "none", paddingLeft: 0, marginLeft: 0 }}>
            {story.raw.map((b, i) => (
              <div key={i} className={`oi-beat${b.tone === "warn" ? " oi-w" : ""}`}>
                <span className="oi-t">{clock(b.at)}</span>
                <span className="oi-m">{b.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="oi-sect">
        <h3>The account</h3>
      </div>
      <div className="oi-card">
        <div className="oi-meta" style={{ marginTop: 0, gap: 18 }}>
          <span>
            Number: <b style={{ color: "var(--text)" }}>{s.provisionedDid || "—"}</b>
          </span>
          <span>
            Paid: <b style={{ color: "var(--text)" }}>{s.paidAmountCents != null ? `$${(s.paidAmountCents / 100).toFixed(2)}` : "not paid"}</b>
          </span>
          <span>
            Build: <b style={{ color: "var(--text)" }}>{s.pbxSetupStatus || "not started"}</b>
          </span>
          <span>
            Extensions: <b style={{ color: "var(--text)" }}>{s.extensions.length}</b>
          </span>
        </div>
        {s.setupError ? (
          <div className="oi-warn" style={{ marginTop: 12 }}>
            <span aria-hidden="true">⚠</span>
            <span>{s.setupError}</span>
          </div>
        ) : null}
        {s.extensions.length ? (
          <div className="oi-tl-beats" style={{ marginTop: 12 }}>
            {s.extensions.map((e) => (
              <div key={e.extNumber} className="oi-beat">
                <span className="oi-t">{e.extNumber}</span>
                <span className="oi-m">
                  {e.displayName || "(no name)"} {e.email ? `· ${e.email}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="oi-foot">
          {s.publicPath ? (
            <a className="oi-btn" href={s.publicPath} target="_blank" rel="noreferrer">
              Open their sign-up page
            </a>
          ) : null}
          <a className="oi-btn" href={`${apiBase}/admin/onboarding/submissions/${encodeURIComponent(id)}/vitalpbx.csv`}>
            Download VitalPBX CSV
          </a>
          <button className="oi-btn" type="button" disabled={retrying} onClick={retrySetup}>
            {retrying ? "Restarting…" : "Retry setup"}
          </button>
        </div>
      </div>
    </div>
  );
}
