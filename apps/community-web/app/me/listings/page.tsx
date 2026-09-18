"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";
import { Button, Chip, Empty, Skeleton, useToast } from "@/components/ui";
import { priceLabel, type ListingItem } from "@/components/marketplace/ListingCard";
import "@/components/marketplace/marketplace.css";

function MyListings() {
  const toast = useToast();
  const [items, setItems] = useState<ListingItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: ListingItem[] }>("/me/listings");
      setItems(r.items);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load your listings.", { kind: "err" });
      setItems([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <div className="card">
        <div className="ct">
          My listings
          <span className="more">
            <Button href="/marketplace/new" small icon="plus" data-testid="me-listings-new">
              Post a listing
            </Button>
          </span>
        </div>
        {!items ? (
          <div className="list">
            <Skeleton h={56} />
            <Skeleton h={56} />
          </div>
        ) : items.length === 0 ? (
          <Empty title="You haven't posted anything yet" text="Services, products, wholesale or a business asset — post it to the marketplace." action={<Button href="/marketplace/new">Post a listing</Button>} />
        ) : (
          <div className="list" data-testid="me-listings-list">
            {items.map((it) => (
              <div className="li" key={it.listing.id}>
                <div className="t">
                  <b>{it.listing.title}</b>
                  <small>
                    {priceLabel(it.listing)} · {it.listing.status} · {it.listing.viewCount} views
                  </small>
                </div>
                {it.listing.status === "REMOVED" ? <Chip kind="bad">removed</Chip> : it.listing.availability !== "AVAILABLE" ? <Chip kind="warn">{it.listing.availability}</Chip> : null}
                <Button small href={`/marketplace/${it.listing.id}`} data-testid={`me-listings-open-${it.listing.id}`}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyListingsPage() {
  return (
    <RequireAuth>
      <AppShell title="My listings">
        <MyListings />
      </AppShell>
    </RequireAuth>
  );
}
