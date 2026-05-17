"use client";

import { billingEventIcon, billingEventLabel, formatDateTime, groupBillingEventsByDay } from "../../lib/billingUi";

export type BillingActivityRow = {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
  metadata?: unknown;
};

export function BillingActivityList({ events }: { events: BillingActivityRow[] }) {
  if (!events.length) return null;
  const groups = groupBillingEventsByDay(events);
  return (
    <div className="billing-timeline-v2">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="billing-p8-timeline-day">{group.label}</div>
          {group.items.map((ev) => (
            <div className="billing-timeline-v2__item" key={ev.id}>
              <div className="billing-timeline-v2__icon" aria-hidden>
                {billingEventIcon(ev.type)}
              </div>
              <div>
                <div className="billing-timeline-v2__label">{billingEventLabel(ev.type)}</div>
                <div className="billing-timeline-v2__time">{formatDateTime(ev.createdAt)}</div>
                {ev.message ? <div className="billing-timeline-v2__msg">{ev.message}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
