"use client";

/**
 * Admin → Onboarding → Where sign-ups get stuck.
 *
 * One timeline says what happened to one customer; this says what to fix.
 * Run against the real data the day it was designed it produced three findings
 * nobody could see before: "Your number" takes a median of 6m 38s against 3-58s
 * for every other step, 15 of the 21 number searches ever run came back empty,
 * and the most common thing that ever stopped anybody was "Please pick a number
 * from the list." — the same defect seen from the other side.
 *
 * ⛔ Medians, not averages. With this few sign-ups one tab left open overnight
 * would drag an average into nonsense and invent a problem that isn't there.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet } from "../../../../../services/apiClient";
import "../onboarding-admin.css";

type Patterns = {
  stepTimings: { step: string; samples: number; medianSeconds: number; maxSeconds: number }[];
  blockers: { step: string; message: string; count: number }[];
  searches: { query: string; count: number; emptyCount: number }[];
  searchTotal: number;
  searchEmptyTotal: number;
  backTracks: { from: string; to: string; count: number }[];
  submissionsConsidered: number;
};

function humanSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export default function AdminOnboardingPatternsPage() {
  const [data, setData] = useState<Patterns | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await apiGet<Patterns>("/admin/onboarding/patterns"));
      } catch (e: any) {
        setError(e?.body?.message || e?.message || "We couldn't work out the patterns.");
      }
    })();
  }, []);

  // The bars are read against the worst step, so the outlier is the thing you
  // see first — which is the entire point of the screen.
  const worst = useMemo(() => Math.max(1, ...(data?.stepTimings || []).map((t) => t.medianSeconds)), [data]);
  const slowest = useMemo(
    () => (data?.stepTimings || []).reduce<Patterns["stepTimings"][number] | null>((a, b) => (!a || b.medianSeconds > a.medianSeconds ? b : a), null),
    [data],
  );
  const runnerUp = useMemo(() => {
    const sorted = [...(data?.stepTimings || [])].sort((a, b) => b.medianSeconds - a.medianSeconds);
    return sorted[1] ?? null;
  }, [data]);

  return (
    <div className="oi-root">
      <p className="oi-back">
        <Link href="/admin/onboarding">← Back to invitations</Link>
      </p>
      <h1 className="oi-h1">Where sign-ups get stuck</h1>
      <p className="oi-sub">
        Every customer who has ever opened a sign-up link
        {data ? ` — ${data.submissionsConsidered} in total.` : "."}
      </p>

      {error ? (
        <div className="oi-warn">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </div>
      ) : null}
      {!data && !error ? <p className="oi-sub">Working it out…</p> : null}

      {data ? (
        <div className="oi-pat-grid">
          <div className="oi-pat">
            <h4>How long each step takes</h4>
            <p className="oi-s">Typical time, all sign-ups</p>
            {data.stepTimings.length === 0 ? (
              <p className="oi-sub">Nobody has finished a step yet.</p>
            ) : (
              data.stepTimings.map((t) => (
                <div key={t.step} className={`oi-bar${slowest && t.step === slowest.step ? " oi-hot" : ""}`}>
                  <span className="oi-l" title={`${t.samples} sign-up${t.samples === 1 ? "" : "s"}, longest ${humanSeconds(t.maxSeconds)}`}>
                    {t.step}
                  </span>
                  <span className="oi-g">
                    <i style={{ width: `${Math.max(1, Math.round((t.medianSeconds / worst) * 100))}%` }} />
                  </span>
                  <span className="oi-v">{humanSeconds(t.medianSeconds)}</span>
                </div>
              ))
            )}
            {slowest && runnerUp && runnerUp.medianSeconds > 0 && slowest.medianSeconds >= runnerUp.medianSeconds * 3 ? (
              <div className="oi-pat-lead">
                <b>
                  “{slowest.step}” takes {Math.round(slowest.medianSeconds / Math.max(1, runnerUp.medianSeconds))} times longer
                  than any other step.
                </b>{" "}
                It is the hardest thing about signing up with Loopcom.
              </div>
            ) : null}
          </div>

          <div className="oi-pat">
            <h4>What stopped people</h4>
            <p className="oi-s">Error messages customers actually hit</p>
            {data.blockers.length === 0 ? (
              <p className="oi-sub">Nobody has been blocked yet.</p>
            ) : (
              data.blockers.slice(0, 8).map((b) => (
                <div key={`${b.step}|${b.message}`} className="oi-pat-row">
                  <span className="oi-n">{b.count}×</span>
                  <span className="oi-q">“{b.message}”</span>
                  <span className="oi-w">{b.step}</span>
                </div>
              ))
            )}

            <h4 style={{ marginTop: 20 }}>Number searches that found nothing</h4>
            <p className="oi-s">
              {data.searchEmptyTotal} of the {data.searchTotal} searches ever run came back empty
            </p>
            {data.searches.filter((s) => s.emptyCount > 0).length === 0 ? (
              <p className="oi-sub">Every search so far found numbers.</p>
            ) : (
              data.searches
                .filter((s) => s.emptyCount > 0)
                .slice(0, 8)
                .map((s) => (
                  <div key={s.query} className="oi-pat-row">
                    <span className="oi-n">{s.emptyCount}×</span>
                    <span className="oi-q">{s.query}</span>
                    <span className="oi-w">{s.emptyCount === s.count ? "all empty" : `${s.count - s.emptyCount} found numbers`}</span>
                  </div>
                ))
            )}
            {data.searchEmptyTotal > data.searchTotal / 2 && data.searchTotal > 0 ? (
              <div className="oi-pat-lead">
                <b>More than half of all number searches find nothing.</b> Worth knowing before the next customer goes looking.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {data && data.backTracks.length ? (
        <>
          <div className="oi-sect">
            <h3>Where people go back</h3>
          </div>
          <div className="oi-card">
            {data.backTracks.slice(0, 6).map((b) => (
              <div key={`${b.from}|${b.to}`} className="oi-pat-row">
                <span className="oi-n">{b.count}×</span>
                <span className="oi-q">
                  {b.from} → back to {b.to}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
