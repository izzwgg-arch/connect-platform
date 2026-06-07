"use client";

import Link from "next/link";
import { Headset, ListOrdered, PhoneCall, ShieldCheck, SignalHigh } from "lucide-react";
import { CRMPageHeader } from "../CRMPageHeader";
import type { QueueOperationalStats } from "../queue/queueTypes";

export function LiveWorkspaceIdle({
  recentContactHref,
  recentContactName,
  canSimulateCall = false,
  simulationLoading = false,
  simulationError = null,
  onSimulateIncomingCall,
}: {
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
  recentContactHref?: string | null;
  recentContactName?: string | null;
  canSimulateCall?: boolean;
  simulationLoading?: boolean;
  simulationError?: string | null;
  onSimulateIncomingCall?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <style>{`
        @keyframes liveSignalPulse {
          0%, 100% { transform: scale(0.96); opacity: 0.7; }
          50% { transform: scale(1.06); opacity: 1; }
        }
        @keyframes liveSignalGlow {
          0%, 100% { opacity: 0.26; filter: blur(34px); transform: scale(0.98); }
          50% { opacity: 0.56; filter: blur(48px); transform: scale(1.04); }
        }
        @keyframes liveScanFloat {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, -6px, 0); }
        }
        @keyframes liveSignalTrace {
          0% { transform: translateX(-32%); opacity: 0; }
          12% { opacity: 0.68; }
          55% { opacity: 0.95; }
          100% { transform: translateX(132%); opacity: 0; }
        }
        @keyframes liveSignalNode {
          0%, 100% { transform: translate3d(0, 0, 0) scale(0.9); opacity: 0.45; }
          50% { transform: translate3d(0, -10px, 0) scale(1.12); opacity: 1; }
        }
        @keyframes liveSignalWave {
          0% { stroke-dashoffset: 260; opacity: 0.18; }
          40% { opacity: 0.92; }
          100% { stroke-dashoffset: -260; opacity: 0.18; }
        }
        @keyframes liveSignalSheen {
          0% { transform: translateX(-120%) skewX(-16deg); opacity: 0; }
          20% { opacity: 0.52; }
          100% { transform: translateX(120%) skewX(-16deg); opacity: 0; }
        }
        @keyframes liveScannerBeam {
          0% { transform: translateX(-135%); opacity: 0; }
          12% { opacity: 0.78; }
          50% { opacity: 1; }
          100% { transform: translateX(135%); opacity: 0; }
        }
        @keyframes liveScannerLine {
          0%, 100% { transform: translateY(-3.4rem); opacity: 0.12; }
          45%, 55% { opacity: 0.9; }
          50% { transform: translateY(3.4rem); }
        }
        @keyframes liveScannerNode {
          0%, 100% { transform: scale(0.86); opacity: 0.42; }
          50% { transform: scale(1.18); opacity: 1; }
        }
        @keyframes liveScannerData {
          0% { transform: translateX(-18%); opacity: 0.18; }
          50% { opacity: 0.82; }
          100% { transform: translateX(18%); opacity: 0.18; }
        }
        @keyframes liveHoloColumn {
          0%, 100% { transform: scaleY(0.9); opacity: 0.34; filter: blur(0.5px); }
          50% { transform: scaleY(1.08); opacity: 0.78; filter: blur(0); }
        }
        @keyframes liveHoloSlice {
          0% { transform: translateY(5.8rem) scaleX(0.68); opacity: 0; }
          18% { opacity: 0.7; }
          52% { opacity: 1; }
          100% { transform: translateY(-5.8rem) scaleX(1.08); opacity: 0; }
        }
        @keyframes liveHoloParticle {
          0%, 100% { transform: translate3d(0, 0, 0) scale(0.84); opacity: 0.35; }
          50% { transform: translate3d(var(--x), var(--y), 0) scale(1.15); opacity: 1; }
        }
        @keyframes liveHoloRing {
          0% { transform: translateY(0) scaleX(0.58); opacity: 0.16; }
          50% { transform: translateY(-0.25rem) scaleX(1); opacity: 0.72; }
          100% { transform: translateY(0) scaleX(0.58); opacity: 0.16; }
        }
        @keyframes liveSignalSearchSweep {
          0% { transform: translateX(-130%); opacity: 0; }
          14% { opacity: 0.75; }
          48% { opacity: 1; }
          100% { transform: translateX(130%); opacity: 0; }
        }
        @keyframes liveSignalWave {
          0% { transform: translate(-50%, -50%) scale(0.92); opacity: 0.42; }
          50% { transform: translate(-50%, -50%) scale(1.14); opacity: 0.84; }
          100% { transform: translate(-50%, -50%) scale(0.92); opacity: 0.42; }
        }
        @keyframes liveSignalTraceDot {
          0%, 100% { transform: translate3d(0, 0, 0) scale(0.78); opacity: 0.34; }
          50% { transform: translate3d(var(--x), var(--y), 0) scale(1.18); opacity: 1; }
        }
        .crm-live-scan-shell {
          position: relative;
          overflow: hidden;
          min-height: calc(100vh - 16rem);
          display: grid;
          place-items: center;
          border: 0;
          background: transparent;
          box-shadow: none;
          backdrop-filter: none;
        }
        .crm-live-scan-shell::before {
          content: "";
          position: absolute;
          inset: 4% 8%;
          background-image:
            linear-gradient(color-mix(in srgb, var(--crm-border) 10%, transparent) 1px, transparent 1px),
            linear-gradient(90deg, color-mix(in srgb, var(--crm-border) 10%, transparent) 1px, transparent 1px);
          background-size: 64px 64px;
          mask-image: radial-gradient(circle, black 0 24%, transparent 64%);
          opacity: 0.34;
          pointer-events: none;
        }
        .crm-live-scan-shell::after {
          content: none;
          position: absolute;
          left: 18%;
          right: 18%;
          top: 24%;
          height: 1px;
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--crm-success) 42%, transparent), color-mix(in srgb, #6ee7f9 28%, transparent), transparent);
          animation: liveSignalTrace 4.8s cubic-bezier(.2,.8,.2,1) infinite;
          pointer-events: none;
        }
        .crm-live-scan-glow {
          position: absolute;
          width: min(32rem, 72vw);
          height: min(22rem, 54vw);
          border-radius: 999px;
          background:
            radial-gradient(circle at 38% 44%, color-mix(in srgb, var(--crm-accent) 15%, transparent), transparent 46%),
            radial-gradient(circle at 62% 54%, color-mix(in srgb, #7dd3fc 12%, transparent), transparent 50%),
            radial-gradient(circle at 50% 50%, color-mix(in srgb, #f7ead7 18%, transparent), transparent 58%);
          animation: liveSignalGlow 3.8s ease-in-out infinite;
          pointer-events: none;
        }
        .crm-live-scan-horizon {
          display: none;
        }
        .crm-live-scan-panel {
          position: relative;
          z-index: 1;
          width: min(42rem, calc(100% - 2rem));
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1.2rem;
          border-radius: 0;
          border: 0;
          background: transparent;
          box-shadow: none;
          backdrop-filter: none;
          padding: clamp(1rem, 3vw, 2rem);
          animation: liveScanFloat 5.5s ease-in-out infinite;
        }
        .crm-live-scan-panel::before,
        .crm-live-scan-panel::after {
          content: none;
          position: absolute;
          width: 3.25rem;
          height: 3.25rem;
          border-color: color-mix(in srgb, var(--crm-success) 38%, transparent);
          pointer-events: none;
        }
        .crm-live-scan-panel::before {
          top: 1rem;
          left: 1rem;
          border-top: 1px solid;
          border-left: 1px solid;
          border-radius: 1.25rem 0 0 0;
        }
        .crm-live-scan-panel::after {
          right: 1rem;
          bottom: 1rem;
          border-right: 1px solid;
          border-bottom: 1px solid;
          border-radius: 0 0 1.25rem 0;
        }
        .crm-live-holo-stage {
          position: relative;
          display: grid;
          place-items: center;
          width: min(25rem, 76vw);
          height: 14rem;
          isolation: isolate;
        }
        .crm-live-holo-stage::before {
          content: none;
          position: absolute;
          inset: 1rem 0;
          border-radius: 999px;
          background:
            linear-gradient(90deg, transparent, color-mix(in srgb, var(--crm-success) 13%, transparent), transparent),
            repeating-linear-gradient(90deg, transparent 0 28px, color-mix(in srgb, var(--crm-border) 12%, transparent) 29px 30px),
            repeating-linear-gradient(0deg, transparent 0 20px, color-mix(in srgb, var(--crm-success) 8%, transparent) 21px 22px);
          mask-image: radial-gradient(ellipse at center, black 0 34%, transparent 72%);
          box-shadow: 0 0 52px color-mix(in srgb, var(--crm-success) 12%, transparent);
          animation: liveHoloColumn 3.4s ease-in-out infinite;
          pointer-events: none;
        }
        .crm-live-holo-stage::after {
          content: none;
          position: absolute;
          top: 18%;
          bottom: 18%;
          width: 34%;
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--crm-success) 34%, transparent), color-mix(in srgb, #ffffff 24%, transparent), transparent);
          box-shadow: 0 0 34px color-mix(in srgb, var(--crm-success) 24%, transparent);
          animation: liveSignalSearchSweep 2.85s cubic-bezier(.2,.8,.2,1) infinite;
          pointer-events: none;
        }
        .crm-live-holo-ring {
          position: absolute;
          left: 50%;
          top: 50%;
          border-radius: 999px;
          border: 1px solid color-mix(in srgb, var(--crm-accent) 54%, #f7ead7);
          background:
            radial-gradient(circle, transparent 64%, color-mix(in srgb, var(--crm-accent) 7%, transparent) 65%, transparent 69%),
            conic-gradient(from 120deg, color-mix(in srgb, var(--crm-accent) 34%, transparent), color-mix(in srgb, #7dd3fc 24%, transparent), color-mix(in srgb, #f7ead7 28%, transparent), color-mix(in srgb, var(--crm-accent) 34%, transparent));
          box-shadow:
            0 0 22px color-mix(in srgb, var(--crm-accent) 13%, transparent),
            0 0 46px color-mix(in srgb, #7dd3fc 8%, transparent),
            inset 0 0 18px color-mix(in srgb, #f7ead7 12%, transparent);
          mask-image: radial-gradient(circle, transparent 61%, black 63%, black 66%, transparent 68%);
          animation: liveSignalWave 2.8s cubic-bezier(.45,0,.55,1) infinite;
          will-change: transform, opacity;
        }
        .crm-live-holo-ring.one {
          width: 6.6rem;
          height: 6.6rem;
          animation-delay: 0s;
        }
        .crm-live-holo-ring.two {
          width: 9.4rem;
          height: 9.4rem;
          animation-delay: -0.46s;
          opacity: 0.72;
        }
        .crm-live-holo-ring.three {
          width: 12.4rem;
          height: 12.4rem;
          animation-delay: -0.92s;
          opacity: 0.52;
        }
        .crm-live-holo-ring.one {
          filter: saturate(1.08);
        }
        .crm-live-holo-ring.two {
          filter: saturate(1.12);
        }
        .crm-live-holo-ring.three {
          filter: saturate(1.04);
        }
        .crm-live-scan-eyebrow {
          color: color-mix(in srgb, var(--crm-text) 82%, transparent);
          font-size: 0.7rem;
          font-weight: 950;
          letter-spacing: 0.2em;
          text-transform: uppercase;
        }
        .crm-live-scan-bars span {
          display: block;
          width: 4px;
          height: 18px;
          border-radius: 999px;
          background: currentColor;
          transform-origin: bottom;
          animation: liveScanBars 1.2s ease-in-out infinite;
        }
        .crm-live-scan-bars span:nth-child(2) { animation-delay: 0.12s; }
        .crm-live-scan-bars span:nth-child(3) { animation-delay: 0.24s; }
        .crm-live-scan-bars span:nth-child(4) { animation-delay: 0.36s; }
        .crm-live-scan-status {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          border-radius: 999px;
          border: 1px solid color-mix(in srgb, var(--crm-accent) 30%, #f7ead7);
          background:
            linear-gradient(135deg, color-mix(in srgb, #fff7ed 64%, transparent), color-mix(in srgb, var(--crm-accent) 9%, transparent)),
            color-mix(in srgb, #f7ead7 42%, transparent);
          color: color-mix(in srgb, var(--crm-accent) 78%, var(--crm-text));
          padding: 0.45rem 0.75rem;
          font-size: 0.72rem;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          box-shadow: 0 10px 28px color-mix(in srgb, var(--crm-accent) 9%, transparent);
        }
        .crm-live-scan-status i {
          width: 0.48rem;
          height: 0.48rem;
          border-radius: 999px;
          background: currentColor;
          box-shadow: 0 0 18px currentColor;
          animation: liveSignalPulse 1.6s ease-in-out infinite;
        }
        .crm-live-scan-chip-row {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 0.5rem;
        }
        .crm-live-scan-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          border-radius: 999px;
          border: 1px solid color-mix(in srgb, var(--crm-border) 26%, transparent);
          background: transparent;
          color: color-mix(in srgb, var(--crm-text) 72%, transparent);
          padding: 0.42rem 0.65rem;
          font-size: 0.73rem;
          font-weight: 800;
        }
        @media (prefers-reduced-motion: reduce) {
          .crm-live-holo-stage::before,
          .crm-live-holo-stage::after,
          .crm-live-holo-ring,
          .crm-live-scan-status i,
          .crm-live-scan-glow,
          .crm-live-scan-panel {
            animation: none;
          }
        }
      `}</style>

      <CRMPageHeader
        icon={<Headset className="h-5 w-5" />}
        title="Ready for live work"
        subtitle="Your communication cockpit for calls, notes, disposition, and timeline — open a contact from queue, campaigns, or an incoming screen pop."
        actions={
          <Link href="/crm/queue" className="tasks-primary-action">
            <ListOrdered className="h-4 w-4" />
            Open queue
          </Link>
        }
      />

      <section className="crm-live-scan-shell">
        <div className="crm-live-scan-glow" />
        <div className="crm-live-scan-horizon" />
        <div className="crm-live-scan-panel text-center">
          <div className="crm-live-holo-stage">
            <span className="crm-live-holo-ring one" />
            <span className="crm-live-holo-ring two" />
            <span className="crm-live-holo-ring three" />
          </div>

          <div className="flex flex-col items-center gap-4">
            <span className="crm-live-scan-eyebrow">Live call workspace</span>
            <span className="crm-live-scan-status"><i /> Scanning for live CRM calls</span>
            <div>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-crm-muted">
                Inbound and outbound call numbers are checked against CRM contacts in this tenant. A match opens this workspace with the caller context ready.
              </p>
            </div>
            <div className="crm-live-scan-chip-row">
              <span className="crm-live-scan-chip"><ShieldCheck className="h-3.5 w-3.5" /> Tenant scoped</span>
              <span className="crm-live-scan-chip"><PhoneCall className="h-3.5 w-3.5" /> Inbound + outbound</span>
              <span className="crm-live-scan-chip"><SignalHigh className="h-3.5 w-3.5" /> Live state</span>
            </div>
          </div>

          {recentContactHref ? (
            <div className="mt-5 flex justify-center">
              <Link href={recentContactHref} className="tasks-primary-action">
                <SignalHigh className="h-4 w-4" />
                Open recent workspace{recentContactName ? `: ${recentContactName}` : ""}
              </Link>
            </div>
          ) : null}

          {canSimulateCall ? (
            <div className="mt-2 flex flex-col items-center gap-2">
              <button
                type="button"
                className="tasks-primary-action"
                disabled={simulationLoading}
                onClick={onSimulateIncomingCall}
              >
                <PhoneCall className="h-4 w-4" />
                {simulationLoading ? "Simulating incoming call..." : "Simulate incoming CRM call"}
              </button>
              {simulationError ? <p className="text-xs font-medium text-crm-danger">{simulationError}</p> : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
