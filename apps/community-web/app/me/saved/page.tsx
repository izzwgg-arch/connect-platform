"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Button, Empty, Skeleton } from "@/components/ui";
import { PostCard } from "@/components/feed/PostCard";
import type { Post } from "@/components/feed/types";
import "@/components/feed/feed.css";

export default function SavedPostsPage() {
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(() => {
    api<{ items: Post[]; nextCursor: string | null }>("/me/saved").then((r) => {
      setItems(r.items);
      setCursor(r.nextCursor);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: Post[]; nextCursor: string | null }>(`/me/saved?cursor=${encodeURIComponent(cursor)}`);
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  function onRemoved(id: string) {
    setItems((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
  }
  function onChanged(post: Post) {
    setItems((cur) => {
      if (!cur) return cur;
      if (!post.saved) return cur.filter((p) => p.id !== post.id);
      return cur.map((p) => (p.id === post.id ? post : p));
    });
  }

  return (
    <RequireAuth>
      <AppShell cols="narrow" title="Saved posts">
        <div className="col">
          <div className="card">
            <div className="ct">Saved posts</div>
          </div>
          {items === null ? (
            <div className="card">
              <Skeleton h={80} />
            </div>
          ) : items.length === 0 ? (
            <div className="card saved-empty">
              <Empty title="No saved posts yet" text="Tap Save on any post to keep it here for later." />
            </div>
          ) : (
            <>
              {items.map((p) => (
                <PostCard
                  key={p.id}
                  post={p}
                  onChanged={onChanged}
                  onRemoved={onRemoved}
                  testId="saved-post"
                  surface="saved"
                />
              ))}
              {cursor ? (
                <Button kind="g" loading={loadingMore} onClick={() => void loadMore()} data-testid="saved-load-more">
                  Load more
                </Button>
              ) : null}
            </>
          )}
        </div>
      </AppShell>
    </RequireAuth>
  );
}
