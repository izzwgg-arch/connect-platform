"use client";

import { useParams } from "next/navigation";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { MessagesShell } from "@/components/messaging/MessagesShell";

export default function ThreadPage() {
  const params = useParams<{ threadId: string }>();
  return (
    <RequireAuth>
      <AppShell title="Messages">
        <MessagesShell threadId={params.threadId} />
      </AppShell>
    </RequireAuth>
  );
}
