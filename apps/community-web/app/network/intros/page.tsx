"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Empty, Skeleton, useToast } from "@/components/ui";
import type { OrgCard, PersonCard } from "@/components/graph/types";
import "@/components/intros/intros.css";

type IntroItem = {
  id: string;
  status: "REQUESTED" | "APPROVED" | "DECLINED" | "WITHDRAWN" | "COMPLETED";
  message: string | null;
  draft: string | null;
  threadId: string | null;
  createdAt: string;
  decidedAt: string | null;
  requester: PersonCard | null;
  middle: PersonCard | null;
  targetPerson: PersonCard | null;
  targetOrg: OrgCard | null;
};

function targetName(item: IntroItem): string {
  return item.targetPerson?.name ?? item.targetOrg?.displayName ?? "them";
}

function statusKind(status: IntroItem["status"]): "" | "ok" | "warn" | "bad" {
  if (status === "APPROVED" || status === "COMPLETED") return "ok";
  if (status === "DECLINED" || status === "WITHDRAWN") return "bad";
  return "warn";
}

export default function IntrosPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [tab, setTab] = useState<"middle" | "requester">("middle");
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<IntroItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(
    async (role: "middle" | "requester") => {
      setLoading(true);
      try {
        const r = await api<{ items: IntroItem[] }>(`/intros?role=${role}`);
        setItems(r.items);
        setDrafts(Object.fromEntries(r.items.map((i) => [i.id, i.draft ?? ""])));
      } catch (e: any) {
        toast(e?.message ?? "Couldn't load introductions.", { kind: "err" });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function suggest(id: string) {
    setBusyId(id);
    try {
      const r = await api<{ text: string; source: "template" | "ai" }>(`/intros/${id}/draft/suggest`, { method: "POST" });
      setDrafts((d) => ({ ...d, [id]: r.text }));
      toast(r.source === "ai" ? "Drafted." : "Drafted from a template — no AI key is configured.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't draft that.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function saveDraft(id: string) {
    try {
      await api(`/intros/${id}/draft`, { method: "PATCH", body: { draft: drafts[id] ?? "" } });
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that draft.", { kind: "err" });
    }
  }

  async function approve(id: string) {
    setBusyId(id);
    try {
      await saveDraft(id);
      await api(`/intros/${id}/approve`, { method: "POST", body: {} });
      toast("Introduced — the thread is open in Messages.");
      setItems((s) => s.filter((i) => i.id !== id));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't approve that.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function decline(id: string) {
    setBusyId(id);
    try {
      await api(`/intros/${id}/decline`, { method: "POST" });
      setItems((s) => s.filter((i) => i.id !== id));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't decline that.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function withdraw(id: string) {
    setBusyId(id);
    try {
      await api(`/intros/${id}/withdraw`, { method: "POST" });
      setItems((s) => s.filter((i) => i.id !== id));
      toast("Withdrawn.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't withdraw that.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell title="Introductions">
      <div className="card" style={{ gridColumn: "1/-1" }}>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button type="button" className={tab === "middle" ? "on" : ""} onClick={() => setTab("middle")} data-testid="intros-tab-tome">
            Requests to me
          </button>
          <button type="button" className={tab === "requester" ? "on" : ""} onClick={() => setTab("requester")} data-testid="intros-tab-mine">
            My requests
          </button>
        </div>

        {loading ? (
          <div className="list">
            <Skeleton h={90} />
            <Skeleton h={90} />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title={tab === "middle" ? "No one has asked you for an introduction" : "You haven't asked for any introductions"}
            text={tab === "requester" ? "Find someone's profile or company page and ask a connection to introduce you." : "Requests will show up here — you decide whether to make them."}
          />
        ) : tab === "middle" ? (
          <div className="list" data-testid="intros-tome-list">
            {items.map((item) => (
              <div className="li" key={item.id} style={{ alignItems: "flex-start" }}>
                <Avatar name={item.requester?.name ?? "?"} assetId={item.requester?.avatarAssetId} size={40} />
                <div className="t" style={{ width: "100%" }}>
                  <b>{item.requester?.name}</b> wants an introduction to <b>{targetName(item)}</b>
                  {item.message ? (
                    <p className="sm dim" style={{ marginTop: 4 }}>
                      &ldquo;{item.message}&rdquo;
                    </p>
                  ) : null}
                  <textarea
                    className="intro-draft"
                    style={{ marginTop: 8 }}
                    placeholder="Write the introduction message…"
                    value={drafts[item.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                    onBlur={() => void saveDraft(item.id)}
                    data-testid={`intros-draft-${item.id}`}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <Button small loading={busyId === item.id} onClick={() => suggest(item.id)} data-testid={`intros-suggest-${item.id}`}>
                      Suggest a draft
                    </Button>
                    <Button small kind="p" icon="check" loading={busyId === item.id} onClick={() => approve(item.id)} data-testid={`intros-approve-${item.id}`}>
                      Approve
                    </Button>
                    <Button small icon="x" loading={busyId === item.id} onClick={() => decline(item.id)} data-testid={`intros-decline-${item.id}`}>
                      Decline
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="list" data-testid="intros-mine-list">
            {items.map((item) => (
              <div className="li" key={item.id}>
                <Avatar name={item.middle?.name ?? "?"} assetId={item.middle?.avatarAssetId} size={40} />
                <div className="t">
                  Asked <b>{item.middle?.name}</b> to introduce you to <b>{targetName(item)}</b>
                  <div style={{ marginTop: 4 }}>
                    <Chip kind={statusKind(item.status)}>{item.status}</Chip>
                  </div>
                </div>
                <div className="row">
                  {item.status === "APPROVED" && item.threadId ? (
                    <Link className="btn p s" href={`/messages/${item.threadId}`} data-testid={`intros-open-thread-${item.id}`}>
                      Open thread
                    </Link>
                  ) : null}
                  {item.status === "REQUESTED" ? (
                    <Button small loading={busyId === item.id} onClick={() => withdraw(item.id)} data-testid={`intros-withdraw-${item.id}`}>
                      Withdraw
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
