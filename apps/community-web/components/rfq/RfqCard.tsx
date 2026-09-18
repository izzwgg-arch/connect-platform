"use client";

import Link from "next/link";
import { Chip, fmtDate, fmtMoney, timeAgo } from "@/components/ui";

export type RfqCardData = {
  id: string;
  number: string;
  title: string;
  description: string;
  status: string;
  visibility?: string;
  category: { id: string; slug: string; name: string } | null;
  quantity: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  location: string | null;
  deadline: string | null;
  closesAt: string | null;
  quoteCount: number;
  createdAt: string;
  viewedAt?: string | null;
  declinedAt?: string | null;
};

const STATUS_KIND: Record<string, "" | "ok" | "warn" | "bad" | "ac"> = {
  OPEN: "ok",
  SHORTLISTING: "warn",
  ACCEPTED: "ac",
  CLOSED: "",
  CANCELLED: "bad",
};

function budgetLabel(rfq: RfqCardData): string | null {
  if (rfq.budgetMin && rfq.budgetMax) return `${fmtMoney(rfq.budgetMin)} – ${fmtMoney(rfq.budgetMax)}`;
  if (rfq.budgetMax) return `Under ${fmtMoney(rfq.budgetMax)}`;
  if (rfq.budgetMin) return `From ${fmtMoney(rfq.budgetMin)}`;
  return null;
}

/** The one card every RFQ list (my requests, vendor inbox, public browse, feed embeds) renders. */
export function RfqCard({ rfq, action, testId }: { rfq: RfqCardData; action?: React.ReactNode; testId?: string }) {
  const budget = budgetLabel(rfq);
  return (
    <div className="card tight" data-testid={testId}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row xs">
          <Chip kind={STATUS_KIND[rfq.status] ?? ""}>{rfq.status === "OPEN" ? "Open" : rfq.status[0] + rfq.status.slice(1).toLowerCase()}</Chip>
          <Chip>{rfq.number}</Chip>
        </div>
        <small className="dim xs">{timeAgo(rfq.createdAt)}</small>
      </div>
      <Link href={`/rfq/${rfq.id}`}>
        <b style={{ display: "block", marginTop: 8, fontSize: 14.5 }}>{rfq.title}</b>
      </Link>
      <div className="row xs dim" style={{ marginTop: 6, flexWrap: "wrap" }}>
        {rfq.category ? <span>{rfq.category.name}</span> : null}
        {rfq.quantity ? <span>· {rfq.quantity}</span> : null}
        {rfq.location ? <span>· {rfq.location}</span> : null}
        {budget ? <span>· {budget}</span> : null}
        {rfq.closesAt ? <span>· closes {fmtDate(rfq.closesAt)}</span> : null}
      </div>
      <div className="row xs dim" style={{ marginTop: 6, justifyContent: "space-between" }}>
        <span>
          {rfq.quoteCount} quote{rfq.quoteCount === 1 ? "" : "s"}
        </span>
        {rfq.declinedAt ? <Chip kind="bad">Declined</Chip> : rfq.viewedAt === null ? <Chip kind="warn">New</Chip> : null}
      </div>
      {action ? <div className="row" style={{ marginTop: 10 }}>{action}</div> : null}
    </div>
  );
}
