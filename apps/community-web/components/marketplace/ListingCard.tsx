"use client";

import Link from "next/link";
import { Avatar, Button, Chip, Icon, fmtMoney } from "@/components/ui";
import type { OrgCard, PersonCard } from "@/components/graph/types";
import "./marketplace.css";

export type ListingDto = {
  id: string;
  type: string;
  title: string;
  description: string;
  categoryId: string | null;
  priceMin: string | null;
  priceMax: string | null;
  priceUnit: string | null;
  minimumOrder: string | null;
  turnaround: string | null;
  delivery: string | null;
  availability: "AVAILABLE" | "LIMITED" | "SOLD_OUT";
  serviceArea: string[];
  status: string;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ListingItem = {
  listing: ListingDto;
  seller: { organization: OrgCard | null; person: PersonCard | null };
  media: Array<{ id: string; url: string }>;
  verified: boolean;
  saved: boolean;
};

export function priceLabel(l: Pick<ListingDto, "priceMin" | "priceMax" | "priceUnit">): string {
  const unit = l.priceUnit ? ` ${l.priceUnit}` : "";
  if (l.priceMin && l.priceMax && l.priceMin !== l.priceMax) return `${fmtMoney(l.priceMin)}–${fmtMoney(l.priceMax)}${unit}`;
  if (l.priceMin) return `From ${fmtMoney(l.priceMin)}${unit}`;
  if (l.priceMax) return `Up to ${fmtMoney(l.priceMax)}${unit}`;
  return "Ask for price";
}

const AVAILABILITY_LABEL: Record<string, string> = { AVAILABLE: "Available", LIMITED: "Limited availability", SOLD_OUT: "Sold out" };

export function ListingCard({
  item,
  onSave,
  onMessage,
  saving,
}: {
  item: ListingItem;
  onSave: (id: string, next: boolean) => void;
  onMessage: (id: string) => void;
  saving?: boolean;
}) {
  const { listing, seller, media, verified } = item;
  const sellerName = seller.organization?.displayName ?? seller.person?.name ?? "Unknown seller";
  const sellerLocation = seller.organization?.location ?? seller.person?.location ?? null;
  const vendorId = seller.organization?.id ?? seller.person?.id ?? "";
  const meta = [listing.minimumOrder, listing.turnaround, listing.delivery].filter(Boolean).join(" · ");

  return (
    <div className="card tight lc-card" data-testid={`marketplace-card-${listing.id}`}>
      <Link href={`/marketplace/${listing.id}`} className="lc-thumb" aria-label={listing.title}>
        {media[0] ? <img src={media[0].url} alt="" /> : <span className="lc-thumb-empty" />}
      </Link>
      <Link href={`/marketplace/${listing.id}`} className="lc-title">
        <b>{listing.title}</b>
      </Link>
      <div className="row xs dim lc-seller">
        <Avatar name={sellerName} assetId={seller.organization?.logoAssetId ?? null} size={18} />
        <span>{sellerName}</span>
        {verified ? <Chip kind="ok" icon="check">verified</Chip> : <Chip kind="warn">unverified</Chip>}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b className="mono" style={{ color: "var(--accent)" }}>{priceLabel(listing)}</b>
        {sellerLocation ? (
          <small className="dim row xs" style={{ gap: 4 }}>
            <Icon name="pin" size={14} />
            {sellerLocation}
          </small>
        ) : null}
      </div>
      {listing.availability !== "AVAILABLE" ? <Chip kind={listing.availability === "SOLD_OUT" ? "bad" : "warn"}>{AVAILABILITY_LABEL[listing.availability]}</Chip> : null}
      {meta ? <small className="dim lc-meta">{meta}</small> : null}
      <div className="row lc-actions">
        <Button kind="p" small href={`/rfq/new?vendor=${encodeURIComponent(vendorId)}&listing=${encodeURIComponent(listing.id)}`} data-testid={`marketplace-quote-${listing.id}`}>
          Request quote
        </Button>
        <Button small onClick={() => onMessage(listing.id)} data-testid={`marketplace-message-${listing.id}`}>
          Message
        </Button>
        <Button kind="g" small icon="save" loading={saving} onClick={() => onSave(listing.id, !item.saved)} data-testid={`marketplace-save-${listing.id}`}>
          {item.saved ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}
