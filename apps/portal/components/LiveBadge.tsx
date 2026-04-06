"use client";

import type { TelephonySocketStatus } from "../hooks/useTelephonySocket";

interface Props {
  status: TelephonySocketStatus;
}

const labels: Record<TelephonySocketStatus, string> = {
  idle: "WS off",
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Reconnecting…",
  error: "WS error",
  failed: "WS failed",
};

const classes: Record<TelephonySocketStatus, string> = {
  idle: "neutral",
  connecting: "info",
  connected: "success",
  disconnected: "warning",
  error: "danger",
  failed: "danger",
};

export function LiveBadge({ status }: Props) {
  return (
    <span className={`chip ${classes[status]}`} title="Telephony WebSocket status">
      {status === "connected" ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "currentColor",
              animation: "pulse 1.5s infinite",
              display: "inline-block",
            }}
          />
          {labels[status]}
        </span>
      ) : (
        labels[status]
      )}
    </span>
  );
}
