"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar, Empty, Icon, Skeleton, timeAgo } from "@/components/ui";
import type { ThreadListItem } from "./types";

type Tab = "inbox" | "requests" | "archived";

export function ThreadList({ activeId }: { activeId?: string }) {
  const { me, on } = useAuth();
  const [tab, setTab] = useState<Tab>("inbox");
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      const r = await api<{ items: ThreadListItem[]; nextCursor: string | null }>(`/threads?tab=${t}`);
      setItems(r.items);
      setNextCursor(r.nextCursor);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  // Realtime: a new/updated message or a thread state change (accept/decline/leave/read)
  // can move a thread between tabs or reorder it — simplest correct thing is to
  // refresh the current tab's first page whenever either event arrives.
  useEffect(() => {
    const offMsg = on("message", () => void load(tabRef.current));
    const offThread = on("thread", () => void load(tabRef.current));
    return () => {
      offMsg();
      offThread();
    };
  }, [on, load]);

  async function loadMore() {
    if (!nextCursor) return;
    const r = await api<{ items: ThreadListItem[]; nextCursor: string | null }>(`/threads?tab=${tab}&cursor=${encodeURIComponent(nextCursor)}`);
    setItems((cur) => [...cur, ...r.items]);
    setNextCursor(r.nextCursor);
  }

  return (
    <div className="msg-pane-list">
      <div className="msg-list-head">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b style={{ fontSize: 16 }}>Messages</b>
          <Link href="/network" className="ib" aria-label="Find someone to message" data-testid="messages-new" title="Start a new conversation from My network">
            <Icon name="plus" />
          </Link>
        </div>
        <div className="msg-tabs" role="tablist">
          {(["inbox", "requests", "archived"] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-testid={`messages-tab-${t}`}>
              {t === "inbox" ? "Inbox" : t === "requests" ? "Requests" : "Archived"}
            </button>
          ))}
        </div>
      </div>
      <div className="msg-scroll" data-testid="messages-list">
        {loading ? (
          <div style={{ padding: 12, display: "grid", gap: 10 }}>
            <Skeleton h={48} />
            <Skeleton h={48} />
            <Skeleton h={48} />
          </div>
        ) : !items.length ? (
          <Empty title={tab === "inbox" ? "No conversations yet" : tab === "requests" ? "No message requests" : "Nothing archived"} text={tab === "inbox" ? "Messages from your connections will show up here." : undefined} />
        ) : (
          items.map((it) => {
            const other = it.kind === "DIRECT" ? it.participants.find((p) => p.person.id !== me?.person.id) : null;
            return (
              <Link key={it.id} href={`/messages/${it.id}`} className={`msg-row ${it.id === activeId ? "active" : ""}`} data-testid={`messages-thread-${it.id}`}>
                <Avatar name={it.title} assetId={other?.person.avatarAssetId} size={40} square={it.kind !== "DIRECT"} />
                <div className="t">
                  <div className="top">
                    <b>{it.title}</b>
                    <small className="mono" style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{timeAgo(it.lastMessageAt)}</small>
                  </div>
                  {it.kind !== "DIRECT" ? <div className="sub">Group · {it.participants.length} people</div> : null}
                  <div className={`preview ${it.unreadCount > 0 ? "unread" : ""}`}>
                    {it.requestFromMe ? "Message request · " : ""}
                    {it.lastMessagePreview || "No messages yet"}
                  </div>
                </div>
                <div className="meta">
                  {it.pinnedAt ? <Icon name="pin" /> : null}
                  {it.unreadCount > 0 ? <span className="msg-unread-badge">{it.unreadCount > 99 ? "99+" : it.unreadCount}</span> : null}
                </div>
              </Link>
            );
          })
        )}
        {nextCursor ? (
          <div style={{ padding: 10, textAlign: "center" }}>
            <button type="button" className="btn g s" onClick={() => void loadMore()} data-testid="messages-load-more">
              Load more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
