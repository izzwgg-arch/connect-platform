"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, newIdempotencyKey } from "@/lib/api";
import { Empty, Skeleton } from "@/components/ui";

function NewThreadRedirect() {
  const router = useRouter();
  const search = useSearchParams();
  const { me } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const to = search.get("to");
    if (!to) {
      setError("No one to message — pick someone from their profile or My network first.");
      return;
    }
    if (to === me?.person.id) {
      setError("You can't start a conversation with yourself.");
      return;
    }
    if (started.current) return;
    started.current = true;
    api<{ id: string }>("/threads", { method: "POST", body: { personIds: [to] }, idempotencyKey: newIdempotencyKey() })
      .then((thread) => router.replace(`/messages/${thread.id}`))
      .catch((err) => setError((err as Error).message || "Couldn't start that conversation."));
  }, [search, me?.person.id, router]);

  if (error) {
    return <Empty title="Couldn't start that conversation" text={error} action={<a className="btn g" href="/messages">Back to Messages</a>} />;
  }
  return (
    <div style={{ padding: 20 }}>
      <Skeleton h={60} />
    </div>
  );
}

export default function NewMessagePage() {
  return (
    <RequireAuth>
      <AppShell title="New message">
        <NewThreadRedirect />
      </AppShell>
    </RequireAuth>
  );
}
