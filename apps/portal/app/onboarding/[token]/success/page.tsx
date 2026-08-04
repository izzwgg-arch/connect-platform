"use client";
/**
 * "We're setting up your phone system" — the screen after paying.
 *
 * Deliberately not a spinner. It names each stage and ticks it off as it
 * happens, because a couple of minutes of silence after handing over a card
 * feels far longer than a couple of minutes of visible progress. When the build
 * finishes it hands straight over to setting up the phone menu, which is the
 * one remaining thing only the customer can decide.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface Step { key: string; label: string; done: boolean; detail: string | null }
interface Progress {
  paid: boolean; built: boolean; failed: boolean; error: string | null;
  steps: Step[]; current: string | null; tenantId: string | null;
  recentActivity: { at: string; message: string }[];
}

export default function OnboardingSuccessPage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token ?? "");
  const [p, setP] = useState<Progress | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const stop = useRef(false);

  const poll = useCallback(async () => {
    if (!token || stop.current) return;
    try {
      const r = await fetch(`/api/onboarding/${encodeURIComponent(token)}/progress`);
      if (!r.ok) throw new Error(String(r.status));
      const data: Progress = await r.json();
      setP(data);
      setUnreachable(false);
      if (data.built || data.failed) stop.current = true; // nothing left to watch
    } catch {
      // A blip must not replace real progress with an error — say it only after
      // contact is actually lost, and keep trying.
      setUnreachable(true);
    }
  }, [token]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => { void poll(); }, 4000);
    return () => clearInterval(t);
  }, [poll]);

  const steps = p?.steps ?? [];
  const doneCount = steps.filter((s) => s.done).length;
  const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;

  return (
    <div className="ob-success-wrap">
      <div className="ob-success-icon" aria-hidden>
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor">
          <circle cx="18" cy="18" r="10" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.4" />
          <circle cx="18" cy="18" r="6" fill="currentColor" fillOpacity="0.12" strokeWidth="1.5" />
          <circle cx="18" cy="18" r="2.5" fill="currentColor" stroke="none" />
        </svg>
      </div>

      {p?.failed ? (
        <>
          <h1 className="ob-success-title">Something went wrong while building</h1>
          <p className="ob-success-sub">
            Your payment went through and your number is safe — the setup just didn&rsquo;t finish. We can
            see what happened and we&rsquo;ll pick it up. Nothing is lost, and you don&rsquo;t need to sign
            up again.
          </p>
          {p.error && <div className="ob-prog-error">{p.error}</div>}
        </>
      ) : p?.built ? (
        <>
          <h1 className="ob-success-title">Your phone system is ready</h1>
          <p className="ob-success-sub">
            Everyone on your team has been emailed their login. There&rsquo;s one thing left — deciding what
            happens when someone calls you.
          </p>
          <a className="ob-prog-cta" href="/pbx/ivr-studio?firstrun=1">Set up what callers hear →</a>
          <p className="ob-prog-skip">It takes about a minute, and you can change it any time.</p>
        </>
      ) : (
        <>
          <h1 className="ob-success-title">Setting up your phone system</h1>
          <p className="ob-success-sub">
            This takes a couple of minutes. You can leave this page open — or close it, and we&rsquo;ll email
            everyone their login the moment it&rsquo;s ready.
          </p>
        </>
      )}

      {!p?.failed && (
        <>
          <div className="ob-prog-bar" aria-hidden><i style={{ width: `${pct}%` }} /></div>
          <div className="ob-prog-steps">
            {steps.map((s) => {
              const state = s.done ? "done" : p?.current === s.key ? "now" : "wait";
              return (
                <div key={s.key} className={`ob-prog-step ${state}`}>
                  <span className="ob-prog-dot">{s.done ? "✓" : state === "now" ? "•" : ""}</span>
                  <span className="ob-prog-text">
                    <b>{s.label}</b>
                    {s.detail && <span>{s.detail}</span>}
                  </span>
                </div>
              );
            })}
            {steps.length === 0 && (
              <div className="ob-prog-step wait">
                <span className="ob-prog-dot" /><span className="ob-prog-text"><b>Starting…</b></span>
              </div>
            )}
          </div>
        </>
      )}

      {unreachable && (
        <p className="ob-prog-skip">
          We&rsquo;ve briefly lost contact with the server — still trying. Your setup carries on regardless.
        </p>
      )}

      <p className="ob-success-note">
        Questions? Reply to your onboarding email or reach us at{" "}
        <a href="mailto:support@connectcomunications.com">support@connectcomunications.com</a>
      </p>

      <style jsx global>{`
        .ob-prog-bar { height: 7px; border-radius: 99px; background: rgba(15,23,42,.08);
          margin: 22px auto 18px; max-width: 420px; overflow: hidden; }
        .ob-prog-bar i { display: block; height: 100%; background: #2f6bff; transition: width .5s ease; }
        .ob-prog-steps { display: flex; flex-direction: column; gap: 9px; max-width: 420px; margin: 0 auto; text-align: left; }
        .ob-prog-step { display: flex; gap: 12px; align-items: center; padding: 12px 14px;
          border: 1px solid rgba(15,23,42,.10); border-radius: 12px; background: #f8fafc; }
        .ob-prog-step .ob-prog-dot { width: 24px; height: 24px; border-radius: 50%; flex: none;
          display: grid; place-items: center; font-size: 12px; font-weight: 750;
          background: #fff; border: 1px solid rgba(15,23,42,.14); color: #94a3b8; }
        .ob-prog-step.done .ob-prog-dot { background: #16a34a; border-color: #16a34a; color: #fff; }
        .ob-prog-step.now .ob-prog-dot { background: #2f6bff; border-color: #2f6bff; color: #fff; }
        .ob-prog-text b { display: block; font-size: 14px; font-weight: 620; }
        .ob-prog-text span { display: block; font-size: 12.5px; color: #64748b; margin-top: 2px; }
        .ob-prog-step.wait .ob-prog-text b { color: #94a3b8; font-weight: 550; }
        .ob-prog-cta { display: inline-block; margin-top: 20px; padding: 13px 24px; border-radius: 12px;
          background: #2f6bff; color: #fff; font-weight: 660; font-size: 15px; text-decoration: none; }
        .ob-prog-cta:hover { filter: brightness(1.07); }
        .ob-prog-skip { margin-top: 12px; font-size: 12.5px; color: #94a3b8; }
        .ob-prog-error { max-width: 420px; margin: 16px auto 0; padding: 12px 14px; border-radius: 11px;
          font-size: 13px; color: #c9414c; background: rgba(201,65,76,.08); border: 1px solid rgba(201,65,76,.3); }
      `}</style>
    </div>
  );
}
