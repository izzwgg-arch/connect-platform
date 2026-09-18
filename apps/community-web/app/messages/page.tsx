"use client";

import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { MessagesShell } from "@/components/messaging/MessagesShell";

export default function MessagesPage() {
  return (
    <RequireAuth>
      <AppShell title="Messages">
        <MessagesShell />
      </AppShell>
    </RequireAuth>
  );
}
