"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Empty, Skeleton } from "@/components/ui";
import { PostCard } from "@/components/feed/PostCard";
import type { Post } from "@/components/feed/types";
import "@/components/feed/feed.css";

export default function PostDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me, loading: authLoading } = useAuth();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    setLoading(true);
    api<{ post: Post }>(me ? `/posts/${id}` : `/public/posts/${id}`, { auth: !!me })
      .then((r) => setPost(r.post))
      .catch((e: ApiError) => setError(e.message ?? "That post wasn't found."))
      .finally(() => setLoading(false));
  }, [id, me, authLoading]);

  const body = loading ? (
    <div className="col">
      <div className="card">
        <Skeleton h={120} />
      </div>
    </div>
  ) : error || !post ? (
    <div className="col">
      <div className="card">
        <Empty title="Post not found" text={error ?? "It may have been deleted, or you don't have access to it."} />
      </div>
    </div>
  ) : (
    <div className="col">
      <PostCard post={post} onChanged={setPost} testId="postpage" surface="post_detail" />
    </div>
  );

  if (authLoading) return null;

  if (me) {
    return (
      <AppShell cols="narrow" title="Post">
        {body}
      </AppShell>
    );
  }

  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span style={{ flex: 1 }} />
        <Link className="btn" href="/login" data-testid="postpage-anon-signin">
          Sign in
        </Link>
        <Link className="btn p" href="/join" data-testid="postpage-anon-join">
          Join free
        </Link>
      </nav>
      <div className="content narrow">{body}</div>
    </div>
  );
}
