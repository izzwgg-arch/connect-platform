"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Empty, Skeleton, useToast } from "@/components/ui";
import { RfqCard, type RfqCardData } from "@/components/rfq/RfqCard";
import "@/components/rfq/rfq.css";

type Tab = "buyer" | "vendor" | "public";

export default function RfqListPage() {
  return (
    <RequireAuth>
      <AppShell title="RFQs">
        <Inner />
      </AppShell>
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("buyer");
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<RfqCardData[]>([]);

  const load = useCallback(
    async (t: Tab) => {
      setLoading(true);
      try {
        if (t === "buyer") {
          const r = await api<{ items: RfqCardData[] }>("/rfq?role=buyer");
          setItems(r.items);
        } else if (t === "vendor") {
          const r = await api<{ items: RfqCardData[] }>("/rfq/inbox");
          setItems(r.items);
        } else {
          const r = await api<{ items: RfqCardData[] }>("/public/rfqs?limit=30");
          setItems(r.items);
        }
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "Couldn't load RFQs.", { kind: "err" });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  return (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 18 }}>RFQs &amp; quotes</h2>
          <Button kind="p" icon="plus" href="/rfq/new" data-testid="rfq-new">
            Post a request
          </Button>
        </div>
        <div className="tabs" style={{ marginTop: 10 }}>
          <button type="button" className={tab === "buyer" ? "on" : ""} onClick={() => setTab("buyer")} data-testid="rfq-tab-buyer">
            My requests
          </button>
          <button type="button" className={tab === "vendor" ? "on" : ""} onClick={() => setTab("vendor")} data-testid="rfq-tab-vendor">
            Vendor inbox
          </button>
          <button type="button" className={tab === "public" ? "on" : ""} onClick={() => setTab("public")} data-testid="rfq-tab-public">
            Browse public
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid2" style={{ marginTop: 12 }}>
          <Skeleton h={120} />
          <Skeleton h={120} />
        </div>
      ) : items.length ? (
        <div className="grid2" style={{ marginTop: 12 }} data-testid="rfq-list">
          {items.map((rfq) => (
            <RfqCard key={rfq.id} rfq={rfq} testId={`rfq-card-${rfq.id}`} />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <Empty
            title={tab === "buyer" ? "No requests yet" : tab === "vendor" ? "No open requests match your business" : "No public requests right now"}
            text={tab === "buyer" ? "Post what you need and matching vendors are notified automatically." : undefined}
            action={tab === "buyer" ? <Button kind="p" href="/rfq/new">Post a request</Button> : undefined}
          />
        </div>
      )}
    </div>
  );
}
