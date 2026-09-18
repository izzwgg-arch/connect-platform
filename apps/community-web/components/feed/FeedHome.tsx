"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Avatar, Button, Empty, Icon, Skeleton, fmtDate, timeAgo } from "@/components/ui";
import { FollowButton } from "@/components/graph/FollowButton";
import { Composer } from "./Composer";
import { PostCard } from "./PostCard";
import { FEED_MODES, FEED_MODE_LABELS, type FeedItem, type FeedMode, type Post } from "./types";
import "./feed.css";

const MODE_STORAGE_KEY = "lc.feed.mode";

type RailBusiness = { id: string; slug: string; displayName: string; logoAssetId: string | null; reason: string };
type RailRfq = { id: string; title: string; location: string | null; quoteCount: number; href: string };
type RailEvent = { id: string; title: string; startsAt: string; venue: string | null; href: string };
type Rail = { businesses: RailBusiness[]; rfqs: RailRfq[]; events: RailEvent[] };

export function FeedHome() {
  const [mode, setMode] = useState<FeedMode>("for_you");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [rail, setRail] = useState<Rail | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_STORAGE_KEY) as FeedMode | null;
      if (saved && FEED_MODES.includes(saved)) setMode(saved);
    } catch {
      /* no storage */
    }
  }, []);

  const load = useCallback(async (m: FeedMode) => {
    setLoading(true);
    try {
      const r = await api<{ items: FeedItem[]; nextCursor: string | null }>(`/feed?mode=${m}`);
      setItems(r.items);
      setCursor(r.nextCursor);
    } catch {
      setItems([]);
      setCursor(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(mode);
  }, [mode, load]);

  useEffect(() => {
    api<Rail>("/feed/rail")
      .then(setRail)
      .catch(() => setRail({ businesses: [], rfqs: [], events: [] }));
  }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: FeedItem[]; nextCursor: string | null }>(`/feed?mode=${mode}&cursor=${encodeURIComponent(cursor)}`);
      setItems((cur) => [...cur, ...r.items]);
      setCursor(r.nextCursor);
    } catch {
      /* stop trying this tick */
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, mode]);

  function switchMode(m: FeedMode) {
    setMode(m);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, m);
    } catch {
      /* no storage */
    }
  }

  function onPosted(post: Post) {
    if (post.publishedAt) setItems((cur) => [{ post, recommendationId: "", why: null }, ...cur]);
  }
  function onChanged(post: Post) {
    setItems((cur) => cur.map((it) => (it.post.id === post.id ? { ...it, post } : it)));
  }
  function onRemoved(id: string) {
    setItems((cur) => cur.filter((it) => it.post.id !== id));
  }

  return (
    <>
      <div className="col">
        <Composer onPosted={onPosted} testId="feed-composer" />

        <div className="tabs" data-testid="feed-mode-tabs">
          {FEED_MODES.map((m) => (
            <button key={m} className={m === mode ? "on" : ""} onClick={() => switchMode(m)} data-testid={`feed-mode-${m}`}>
              {FEED_MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="card">
            <Skeleton h={80} />
          </div>
        ) : items.length === 0 ? (
          <div className="card feed-empty">
            <Empty
              title={mode === "following" ? "Nothing from your network yet" : "Nothing here yet"}
              text={mode === "following" ? "Follow a few people or companies, or switch to Latest." : "Check back soon, or try a different tab."}
              action={
                mode === "following" ? (
                  <Button kind="p" href="/network" data-testid="feed-empty-network">
                    Find your network
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          items.map((it, i) => (
            <PostCard
              key={it.post.id}
              post={it.post}
              onChanged={onChanged}
              onRemoved={onRemoved}
              recommendationId={it.recommendationId || null}
              surface="feed"
              position={i}
              why={it.why}
              testId="feed-post"
            />
          ))
        )}
        <div ref={sentinelRef} />
        {loadingMore ? <Skeleton h={40} /> : null}
      </div>

      <div className="col">
        <div className="card">
          <div className="ct">
            Businesses you may need <Link className="more" href="/search?type=organizations">See all</Link>
          </div>
          {!rail ? (
            <Skeleton h={60} />
          ) : rail.businesses.length === 0 ? (
            <p className="sm dim">Follow a few companies to see recommendations here.</p>
          ) : (
            <div className="list">
              {rail.businesses.map((b) => (
                <div className="li" key={b.id}>
                  <Avatar name={b.displayName} assetId={b.logoAssetId} size={36} square />
                  <div className="t">
                    <Link href={`/companies/${b.slug}`}>
                      <b>{b.displayName}</b>
                    </Link>
                    <small className="xs" style={{ color: "var(--accent)" }}>
                      {b.reason}
                    </small>
                  </div>
                  <FollowButton targetId={b.id} kind="organization" following={false} testId={`feed-rail-follow-${b.id}`} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="ct">
            RFQs near you <Link className="more" href="/rfq">See all</Link>
          </div>
          {!rail ? (
            <Skeleton h={60} />
          ) : rail.rfqs.length === 0 ? (
            <p className="sm dim">No open RFQs right now.</p>
          ) : (
            <div className="list sm">
              {rail.rfqs.map((r) => (
                <Link className="li" href={r.href} key={r.id}>
                  <span className="sev" style={{ background: "var(--accent)" }} />
                  <div className="t">
                    <b>{r.title}</b>
                    <small>
                      {r.location ?? "Anywhere"} · {r.quoteCount} quote{r.quoteCount === 1 ? "" : "s"}
                    </small>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="ct">This week</div>
          {!rail ? (
            <Skeleton h={60} />
          ) : rail.events.length === 0 ? (
            <p className="sm dim">No upcoming events.</p>
          ) : (
            <div className="list sm">
              {rail.events.map((e) => (
                <div className="li" key={e.id}>
                  <Icon name="cal" />
                  <div className="t">
                    <b>{e.title}</b>
                    <small>
                      {fmtDate(e.startsAt, { month: "short", day: "numeric" })} · {timeAgo(e.startsAt)} {e.venue ? `· ${e.venue}` : ""}
                    </small>
                  </div>
                  <Button small href={e.href} data-testid={`feed-rail-rsvp-${e.id}`}>
                    RSVP
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
