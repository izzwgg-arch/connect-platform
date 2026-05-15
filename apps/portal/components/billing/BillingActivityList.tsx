"use client";

import { billingEventIcon, billingEventLabel, formatDateTime } from "../../lib/billingUi";

export type BillingActivityRow = {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
  metadata?: unknown;
};

export function BillingActivityList({ events }: { events: BillingActivityRow[] }) {
  if (!events.length) return null;
  return (
    <div className="billing-timeline-v2">
      {events.map((ev) => (
        <div className="billing-timeline-v2__item" key={ev.id}>
          <div className="billing-timeline-v2__icon" aria-hidden>
            {billingEventIcon(ev.type)}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{billingEventLabel(ev.type)}</div>
            <div className="billing-timeline-v2__time">{formatDateTime(ev.createdAt)}</div>
            {ev.message ? (
              <div className="muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>
                {ev.message}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
