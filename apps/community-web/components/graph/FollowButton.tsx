"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button, useToast } from "@/components/ui";

/** Person or organization follow toggle — used from profiles, company pages and search. */
export function FollowButton({
  targetId,
  kind,
  following,
  small = true,
  testId = "follow",
}: {
  targetId: string;
  kind: "person" | "organization";
  following: boolean;
  small?: boolean;
  testId?: string;
}) {
  const [on, setOn] = useState(following);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const path = kind === "person" ? `/people/${targetId}/follow` : `/organizations/${targetId}/follow`;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !on;
    try {
      await api(path, { method: next ? "POST" : "DELETE" });
      setOn(next);
    } catch (e: any) {
      toast(e?.message ?? "That didn't go through.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button kind={on ? "g" : ""} small={small} icon={on ? "check" : "plus"} loading={busy} onClick={() => void toggle()} data-testid={`${testId}-${on ? "following" : "follow"}`}>
      {on ? "Following" : "Follow"}
    </Button>
  );
}
