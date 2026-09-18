"use client";

import { useRouter } from "next/navigation";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Composer } from "@/components/feed/Composer";
import "@/components/feed/feed.css";

export default function NewPostPage() {
  const router = useRouter();
  return (
    <RequireAuth>
      <AppShell cols="narrow" title="Create a post">
        <div className="col">
          <Composer
            testId="new-post-composer"
            placeholder="Share an update, a job, or what you need…"
            onPosted={(post) => router.push(post.publishedAt ? `/posts/${post.id}` : "/")}
          />
        </div>
      </AppShell>
    </RequireAuth>
  );
}
