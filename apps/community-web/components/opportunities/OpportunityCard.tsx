"use client";

import Link from "next/link";
import { Avatar, Button, Chip, timeAgo } from "@/components/ui";
import type { OrgCard, PersonCard } from "@/components/graph/types";
import "./opportunities.css";

export type OpportunityDto = {
  id: string;
  title: string;
  description: string;
  fields: Record<string, unknown>;
  location: string | null;
  status: "OPEN" | "CLOSED" | "REMOVED";
  interestCount: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityItem = {
  opportunity: OpportunityDto;
  type: { id: string; slug: string; name: string; fieldSchema?: unknown } | null;
  poster: PersonCard | null;
  organization: OrgCard | null;
  interestCount: number;
  myInterest: boolean;
};

export function OpportunityCard({
  item,
  onInterested,
  onQuestion,
  onShare,
  busy,
}: {
  item: OpportunityItem;
  onInterested: (id: string) => void;
  onQuestion: (id: string) => void;
  onShare: (id: string) => void;
  busy?: boolean;
}) {
  const { opportunity: o, type, poster, organization } = item;
  const posterName = organization?.displayName ?? poster?.name ?? "Someone";
  const meta = [item.opportunity.location, timeAgo(o.createdAt), `${item.interestCount} interested`].filter(Boolean).join(" · ");

  return (
    <div className="card tight oc-card" data-testid={`opportunities-card-${o.id}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Chip kind="ac">{type?.name ?? "Opportunity"}</Chip>
        <small className="dim xs">{timeAgo(o.createdAt)}</small>
      </div>
      <Link href={`/opportunities/${o.id}`} className="oc-title">
        <b>{o.title}</b>
      </Link>
      <div className="row xs dim oc-poster">
        <Avatar name={posterName} assetId={organization?.logoAssetId ?? poster?.avatarAssetId ?? null} size={18} />
        <span>{posterName}</span>
        <span>· {meta}</span>
      </div>
      {o.status !== "OPEN" ? <Chip kind="warn">{o.status === "CLOSED" ? "Closed" : "Removed"}</Chip> : null}
      <div className="row oc-actions">
        <Button kind="p" small loading={busy} disabled={item.myInterest || o.status !== "OPEN"} onClick={() => onInterested(o.id)} data-testid={`opportunities-interested-${o.id}`}>
          {item.myInterest ? "Interested ✓" : "I'm interested"}
        </Button>
        <Button small onClick={() => onQuestion(o.id)} data-testid={`opportunities-question-${o.id}`}>
          Ask a question
        </Button>
        <Button kind="g" small icon="share" onClick={() => onShare(o.id)} data-testid={`opportunities-share-${o.id}`}>
          Share
        </Button>
      </div>
    </div>
  );
}
