"use client";

import { useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { Button, Menu, useToast } from "@/components/ui";

export type ConnectState = "none" | "outgoing" | "incoming" | "connected";

/**
 * Self-contained connect control used from profiles, search results, "People
 * you may know" and the connections table. Owns its own request lifecycle so
 * a caller only needs to pass what it already has.
 */
export function ConnectButton({
  personId,
  connectionId = null,
  status,
  small = true,
  testId = "connect",
  onChange,
}: {
  personId: string;
  connectionId?: string | null;
  status: ConnectState;
  small?: boolean;
  testId?: string;
  onChange?: (next: { status: ConnectState; connectionId: string | null }) => void;
}) {
  const [state, setState] = useState<ConnectState>(status);
  const [connId, setConnId] = useState<string | null>(connectionId);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function apply(next: ConnectState, id: string | null) {
    setState(next);
    setConnId(id);
    onChange?.({ status: next, connectionId: id });
  }

  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e?.message ?? "That didn't go through.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  const request = () =>
    guarded(async () => {
      const r = await api<{ id: string; status: string }>("/connections/request", { method: "POST", body: { personId }, idempotencyKey: newIdempotencyKey() });
      apply(r.status === "ACTIVE" ? "connected" : "outgoing", r.id);
      toast(r.status === "ACTIVE" ? "You're connected." : "Request sent.");
    });

  const withdraw = () =>
    guarded(async () => {
      if (!connId) return;
      await api(`/connections/${connId}/withdraw`, { method: "POST" });
      apply("none", null);
    });

  const accept = () =>
    guarded(async () => {
      if (!connId) return;
      await api(`/connections/${connId}/accept`, { method: "POST" });
      apply("connected", connId);
      toast("Connected.");
    });

  const remove = () =>
    guarded(async () => {
      if (!connId) return;
      await api(`/connections/${connId}`, { method: "DELETE" });
      apply("none", null);
      toast("Connection removed.");
    });

  if (state === "connected") {
    return (
      <Menu trigger={<Button kind="g" small={small} icon="check" loading={busy} data-testid={`${testId}-connected`}>Connected</Button>} label="Connection options">
        <button type="button" onClick={() => void remove()} data-testid={`${testId}-remove`}>
          Remove connection
        </button>
      </Menu>
    );
  }
  if (state === "outgoing") {
    return (
      <Button kind="g" small={small} loading={busy} onClick={() => void withdraw()} data-testid={`${testId}-withdraw`}>
        Pending
      </Button>
    );
  }
  if (state === "incoming") {
    return (
      <Button kind="p" small={small} loading={busy} onClick={() => void accept()} data-testid={`${testId}-accept`}>
        Accept
      </Button>
    );
  }
  return (
    <Button kind="p" small={small} icon="plus" loading={busy} onClick={() => void request()} data-testid={`${testId}-connect`}>
      Connect
    </Button>
  );
}
