"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Chip, Empty, Icon, Skeleton, Switch, useToast } from "@/components/ui";
import { ListingCard, type ListingItem } from "@/components/marketplace/ListingCard";
import "@/components/marketplace/marketplace.css";

type CategoryNode = { id: string; slug: string; name: string; count: number; children: CategoryNode[] };

const TYPES: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "SERVICE", label: "Services" },
  { value: "PRODUCT", label: "Products" },
  { value: "WHOLESALE", label: "Wholesale" },
  { value: "BUSINESS_ASSET", label: "Business assets" },
  { value: "PROFESSIONAL_SERVICE", label: "Professional services" },
];

const SORTS: Array<{ value: string; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
];

export default function MarketplacePage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [categoryStack, setCategoryStack] = useState<CategoryNode[]>([]);
  const [type, setType] = useState("");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [sort, setSort] = useState("relevance");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ListingItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [messageFor, setMessageFor] = useState<string | null>(null);

  useEffect(() => {
    api<{ categories: CategoryNode[] }>("/marketplace/categories")
      .then((r) => setCategories(r.categories))
      .catch(() => setCategories([]));
  }, []);

  const currentCategory = categoryStack[categoryStack.length - 1] ?? null;
  const visibleChildren = currentCategory ? currentCategory.children : categories;

  const load = useCallback(
    async (cursor?: string) => {
      cursor ? setLoadingMore(true) : setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (type) params.set("type", type);
        if (currentCategory) params.set("category", currentCategory.slug);
        if (verifiedOnly) params.set("verifiedOnly", "1");
        params.set("sort", sort);
        if (cursor) params.set("cursor", cursor);
        const r = await api<{ items: ListingItem[]; nextCursor: string | null }>(`/listings?${params.toString()}`);
        setItems((cur) => (cursor ? [...cur, ...r.items] : r.items));
        setNextCursor(r.nextCursor);
      } catch (e: any) {
        toast(e?.message ?? "Couldn't load the marketplace.", { kind: "err" });
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, type, currentCategory?.id, verifiedOnly, sort],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, type, currentCategory?.id, verifiedOnly, sort]);

  async function toggleSave(id: string, next: boolean) {
    setSavingId(id);
    setItems((cur) => cur.map((it) => (it.listing.id === id ? { ...it, saved: next } : it)));
    try {
      if (next) await api(`/listings/${id}/save`, { method: "POST" });
      else await api(`/listings/${id}/save`, { method: "DELETE" });
    } catch (e: any) {
      setItems((cur) => cur.map((it) => (it.listing.id === id ? { ...it, saved: !next } : it)));
      toast(e?.message ?? "Couldn't save that.", { kind: "err" });
    } finally {
      setSavingId(null);
    }
  }

  const [messageBody, setMessageBody] = useState("");
  const [sending, setSending] = useState(false);
  async function sendMessage() {
    if (!messageFor || !messageBody.trim()) return;
    setSending(true);
    try {
      await api(`/listings/${messageFor}/message`, { method: "POST", body: { body: messageBody.trim() } });
      toast("Message sent.");
      setMessageFor(null);
      setMessageBody("");
    } catch (e: any) {
      toast((e as ApiError)?.message ?? "Couldn't send that message.", { kind: "err" });
    } finally {
      setSending(false);
    }
  }

  const breadcrumb = useMemo(() => [{ id: "__all", slug: "", name: "All", count: 0, children: categories }, ...categoryStack], [categories, categoryStack]);

  return (
    <AppShell title="Marketplace">
      <div className="col" style={{ gridColumn: "1/-1" }}>
        <div className="card">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(qInput.trim());
            }}
          >
            <input className="in" style={{ flex: 1 }} placeholder="Search the marketplace" value={qInput} onChange={(e) => setQInput(e.target.value)} data-testid="marketplace-search-input" />
            <Button kind="p" type="submit" icon="search" data-testid="marketplace-search-submit">
              Search
            </Button>
            <Button href="/marketplace/new" icon="plus" data-testid="marketplace-post-listing">
              Post a listing
            </Button>
          </form>

          <div className="pill-row mkt-filters" data-testid="marketplace-type-chips">
            {TYPES.map((t) => (
              <Chip key={t.value || "all"} kind={type === t.value ? "sel" : ""} onClick={() => setType(t.value)} testId={`marketplace-type-${t.value || "all"}`}>
                {t.label}
              </Chip>
            ))}
          </div>

          <div className="pill-row mkt-filters" data-testid="marketplace-category-chips">
            {breadcrumb.map((node, i) => (
              <span key={node.id} className="row xs" style={{ gap: 4 }}>
                {i > 0 ? <span className="mkt-crumb">›</span> : null}
                <Chip
                  kind={i === breadcrumb.length - 1 ? "sel" : "ac"}
                  onClick={() => setCategoryStack(categoryStack.slice(0, i))}
                  testId={`marketplace-crumb-${node.slug || "all"}`}
                >
                  {node.name}
                </Chip>
              </span>
            ))}
            {visibleChildren
              .filter((c) => !breadcrumb.some((b) => b.id === c.id))
              .map((c) => (
                <Chip key={c.id} onClick={() => setCategoryStack([...categoryStack, c])} testId={`marketplace-category-${c.slug}`}>
                  {c.name}
                  {c.count ? <span className="n"> · {c.count}</span> : null}
                </Chip>
              ))}
          </div>

          <div className="row sm dim" style={{ marginTop: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
            <span>{loading ? "Loading…" : `${items.length} listing${items.length === 1 ? "" : "s"}`}</span>
            <span className="row">
              <label className="row xs" style={{ gap: 6 }}>
                <Switch on={verifiedOnly} onChange={setVerifiedOnly} label="Verified sellers only" id="mkt-verified" />
                <span>Verified sellers only</span>
              </label>
              <select className="in" value={sort} onChange={(e) => setSort(e.target.value)} data-testid="marketplace-sort" style={{ width: 190 }}>
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    Sort: {s.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </div>

        {loading ? (
          <div className="grid2">
            <Skeleton h={220} />
            <Skeleton h={220} />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No listings match yet" text="Try a different search or category." action={<Button href="/marketplace/new" icon="plus">Post a listing</Button>} />
        ) : (
          <>
            <div className="grid2" data-testid="marketplace-grid">
              {items.map((it) => (
                <ListingCard key={it.listing.id} item={it} onSave={toggleSave} onMessage={setMessageFor} saving={savingId === it.listing.id} />
              ))}
            </div>
            {nextCursor ? (
              <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
                <Button loading={loadingMore} onClick={() => load(nextCursor)} data-testid="marketplace-load-more">
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {messageFor ? (
        <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && setMessageFor(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Message the seller">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ fontSize: 17 }}>Message the seller</h2>
              <button type="button" className="ib" aria-label="Close" onClick={() => setMessageFor(null)}>
                <Icon name="x" />
              </button>
            </div>
            <textarea
              className="in"
              style={{ minHeight: 100, marginTop: 10 }}
              placeholder="Ask about pricing, timing, or anything else…"
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              data-testid="marketplace-message-body"
            />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <Button kind="p" loading={sending} disabled={!messageBody.trim()} onClick={sendMessage} data-testid="marketplace-message-send">
                Send
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
