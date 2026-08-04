"use client";

/**
 * One-time "finish your setup" prompt.
 *
 * A customer who signed up through the wizard is supposed to land on IVR
 * Studio's first-run right after the build — but if they closed the tab or
 * never clicked through, their system answers calls with nothing configured.
 * On their first sign-in, if their tenant came from onboarding and still has
 * no phone menu, this offers to take them back to finish.
 *
 * Rules:
 *  - Server decides eligibility (GET /me/onboarding-setup-state): admin of an
 *    onboarding-created tenant with zero IVR menus. Once a menu exists, the
 *    server answers show:false forever — no client state needed.
 *  - Shown once per browser: any choice (go or later) writes a local flag.
 *  - Never throws, never blocks the app — silent on any failure.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "../services/apiClient";

const SEEN_KEY = "cc-onboarding-setup-nudge-v1";

export function OnboardingSetupNudge() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    try {
      if (window.localStorage.getItem(SEEN_KEY)) return;
    } catch { /* storage blocked — still fine to ask the server */ }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet<{ show: boolean }>("/me/onboarding-setup-state");
        if (!cancelled && r?.show) setOpen(true);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!open) return null;

  const done = () => {
    try { window.localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    setOpen(false);
  };

  return (
    <div className="setup-nudge-backdrop" role="dialog" aria-modal="true" aria-label="Finish setting up your phone system">
      <div className="setup-nudge-card">
        <div className="setup-nudge-icon" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/>
          </svg>
        </div>
        <h2 className="setup-nudge-title">One thing left to finish</h2>
        <p className="setup-nudge-sub">
          Your phone system is live — but you haven&apos;t decided what callers hear yet.
          It takes about a minute: pick a greeting and where calls should go. Until then,
          callers get a plain default.
        </p>
        <div className="setup-nudge-actions">
          <button
            className="setup-nudge-go"
            onClick={() => { done(); router.push("/pbx/ivr-studio?firstrun=1"); }}
          >
            Finish my setup →
          </button>
          <button className="setup-nudge-later" onClick={done}>
            I&apos;ll do it later
          </button>
        </div>
        <p className="setup-nudge-hint">You can always get there from PBX → IVR Studio.</p>
      </div>

      <style jsx global>{`
        .setup-nudge-backdrop {
          position: fixed; inset: 0; z-index: 260;
          display: flex; align-items: center; justify-content: center; padding: 20px;
          background: rgba(5, 10, 18, 0.62); backdrop-filter: blur(3px);
        }
        .setup-nudge-card {
          width: 100%; max-width: 430px; text-align: center;
          border-radius: 18px; padding: 30px 28px 22px;
          background: #16212e; border: 1px solid #27384a;
          box-shadow: 0 1px 2px rgba(0,0,0,.35), 0 24px 60px -24px rgba(0,0,0,.8);
          color: #e7edf4;
        }
        .setup-nudge-icon {
          width: 58px; height: 58px; margin: 0 auto 16px; border-radius: 16px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(59,130,246,.14); border: 1px solid rgba(59,130,246,.28);
          color: #3b82f6;
        }
        .setup-nudge-title { font-size: 21px; font-weight: 720; letter-spacing: -.4px; margin: 0 0 8px; }
        .setup-nudge-sub { font-size: 14px; line-height: 1.6; color: #aebccc; margin: 0 0 20px; }
        .setup-nudge-actions { display: flex; flex-direction: column; gap: 9px; }
        .setup-nudge-go {
          padding: 12px 20px; border-radius: 12px; border: none; cursor: pointer;
          background: #2f6bff; color: #fff; font-weight: 650; font-size: 15px;
        }
        .setup-nudge-go:hover { filter: brightness(1.08); }
        .setup-nudge-later {
          padding: 10px 20px; border-radius: 12px; cursor: pointer;
          background: transparent; border: 1px solid #27384a; color: #aebccc;
          font-weight: 550; font-size: 13.5px;
        }
        .setup-nudge-later:hover { border-color: #3b82f6; color: #e7edf4; }
        .setup-nudge-hint { margin: 14px 0 0; font-size: 12px; color: #8093a6; }

        /* Light theme — follows the platform's explicit toggle. */
        :root[data-theme="light"] .setup-nudge-backdrop { background: rgba(15, 27, 45, 0.38); }
        :root[data-theme="light"] .setup-nudge-card {
          background: #ffffff; border-color: #dce4ef; color: #0f1b2d;
          box-shadow: 0 1px 2px rgba(15,23,42,.05), 0 24px 56px -28px rgba(15,23,42,.5);
        }
        :root[data-theme="light"] .setup-nudge-icon {
          background: rgba(47,107,255,.08); border-color: rgba(47,107,255,.2); color: #2f6bff;
        }
        :root[data-theme="light"] .setup-nudge-sub { color: #3d5068; }
        :root[data-theme="light"] .setup-nudge-later { border-color: #dce4ef; color: #3d5068; }
        :root[data-theme="light"] .setup-nudge-later:hover { border-color: #2f6bff; color: #0f1b2d; }
        :root[data-theme="light"] .setup-nudge-hint { color: #64748b; }
      `}</style>
    </div>
  );
}
