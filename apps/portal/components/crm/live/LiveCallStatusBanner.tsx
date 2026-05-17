"use client";

import { useEffect, useState } from "react";
import { Phone, PhoneIncoming, PhoneOutgoing, Radio } from "lucide-react";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { cn } from "../cn";
import { crm } from "../crmClasses";

const STATE_LABEL: Record<string, string> = {
  ringing: "Ringing",
  dialing: "Dialing",
  up: "Connected",
  held: "On hold",
  hungup: "Ended",
  unknown: "Live call",
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function LiveCallStatusBanner({
  linkedId,
  fromNumber,
  className,
}: {
  linkedId: string | null;
  fromNumber: string | null;
  className?: string;
}) {
  const { calls } = useTelephony();
  const [elapsed, setElapsed] = useState(0);

  const activeCall = linkedId
    ? (Array.from(calls.values()).find((c) => c.linkedId === linkedId) ?? null)
    : (Array.from(calls.values()).find((c) => c.state !== "hungup") ?? null);

  useEffect(() => {
    if (!activeCall?.answeredAt) {
      setElapsed(0);
      return;
    }
    const startMs = new Date(activeCall.answeredAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeCall?.answeredAt]);

  const state = activeCall?.state ?? null;
  const direction = activeCall?.direction ?? (fromNumber ? "inbound" : null);
  const phone = activeCall?.from ?? fromNumber ?? "";
  const isLive = state && state !== "hungup";

  if (!activeCall && !linkedId && !fromNumber) {
    return (
      <StatusCard
        className={className}
        title="No active call"
        detail="Open a lead from My Queue or answer an incoming screen pop."
      />
    );
  }

  if (!activeCall && (linkedId || fromNumber)) {
    return (
      <StatusCard
        className={className}
        title="Call context loaded"
        detail={
          fromNumber
            ? `Screen pop from ${fromNumber} — telephony state not linked yet.`
            : "Waiting for telephony to report call state."
        }
        accent
      />
    );
  }

  if (!isLive && state === "hungup") {
    return (
      <StatusCard
        className={className}
        title="Call ended"
        detail={phone ? `Last: ${phone}` : "Session complete — log disposition below."}
      />
    );
  }

  return (
    <StatusCard
      className={cn(
        "border-crm-success/40 bg-crm-success/10",
        state === "ringing" && "border-crm-warning/40 bg-crm-warning/10",
        state === "held" && "border-crm-accent/35 bg-crm-accent/10",
        className,
      )}
      title={STATE_LABEL[state ?? "unknown"] ?? "Live call"}
      detail={phone}
      live
      elapsed={activeCall?.answeredAt && elapsed > 0 ? formatDuration(elapsed) : undefined}
      direction={direction}
    />
  );
}

function StatusCard({
  className,
  title,
  detail,
  live,
  elapsed,
  direction,
  accent,
}: {
  className?: string;
  title: string;
  detail?: string;
  live?: boolean;
  elapsed?: string;
  direction?: string | null;
  accent?: boolean;
}) {
  const DirIcon =
    direction === "inbound" ? PhoneIncoming : direction === "outbound" ? PhoneOutgoing : live ? Radio : Phone;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-crm-lg border px-4 py-3",
        accent ? "border-crm-accent/30 bg-crm-accent/8" : "border-crm-border bg-crm-surface-2/60",
        live && "border-crm-success/40 bg-crm-success/10",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-crm",
          live ? "bg-crm-success/20 text-crm-success" : "bg-crm-surface text-crm-muted",
        )}
      >
        <DirIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-sm font-semibold", live ? "text-crm-success" : "text-crm-text")}>
            {title}
          </span>
          {live ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-crm-success/40 bg-crm-success/15 px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-wider text-crm-success">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-crm-success" />
              Live
            </span>
          ) : null}
        </div>
        {detail ? (
          <p className={cn(crm.footnote, "mt-0.5 font-mono tabular-nums")}>{detail}</p>
        ) : null}
      </div>
      {elapsed ? (
        <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-crm-text">{elapsed}</span>
      ) : null}
    </div>
  );
}
