"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Empty, Skeleton, useToast } from "@/components/ui";
import type { PersonCard } from "@/components/graph/types";
import "@/components/graph/graph.css";

type Pending = { id: string; person: PersonCard; message: string | null; createdAt: string };
type Suggestion = { person: PersonCard; reason: string; recommendationId: string };

export default function NetworkPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [incoming, setIncoming] = useState<Pending[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [counts, setCounts] = useState<{ all: number } | null>(null);
  const [followingOrgs, setFollowingOrgs] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pending, sugg, connCounts, following] = await Promise.all([
        api<{ incoming: Pending[]; outgoing: Pending[] }>("/connections/pending"),
        api<{ items: Suggestion[] }>("/network/suggestions?limit=12"),
        api<{ counts: { all: number } }>("/connections/counts"),
        api<{ items: unknown[] }>("/me/following?type=organizations"),
      ]);
      setIncoming(pending.incoming);
      setSuggestions(sugg.items);
      setCounts(connCounts.counts);
      setFollowingOrgs(following.items.length);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load your network.", { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function respond(id: string, action: "accept" | "ignore") {
    setBusyId(id);
    try {
      await api(`/connections/${id}/${action}`, { method: "POST" });
      setIncoming((s) => s.filter((r) => r.id !== id));
      if (action === "accept") toast("Connected.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't do that.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function connect(personId: string) {
    setBusyId(personId);
    try {
      const r = await api<{ status: string }>("/connections/request", { method: "POST", body: { personId } });
      setSuggestions((s) => s.filter((x) => x.person.id !== personId));
      toast(r.status === "ACTIVE" ? "You're connected." : "Request sent.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't send that request.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(recommendationId: string) {
    setSuggestions((s) => s.filter((x) => x.recommendationId !== recommendationId));
    try {
      await api(`/network/suggestions/${recommendationId}/dismiss`, { method: "POST" });
    } catch {
      /* best-effort; the card is already gone from the viewer's session */
    }
  }

  return (
    <AppShell cols="two" title="My network">
      <div className="col">
        <div className="card">
          <div className="ct">
            Invitations {incoming.length ? <Chip kind="ac">{incoming.length}</Chip> : null}
          </div>
          {loading ? (
            <div className="list">
              <Skeleton h={56} />
              <Skeleton h={56} />
            </div>
          ) : incoming.length === 0 ? (
            <Empty title="No pending invitations" text="Requests people send you will show up here." />
          ) : (
            <div className="list" data-testid="network-invitations">
              {incoming.map((r) => (
                <div className="li" key={r.id}>
                  <Link href={`/people/${r.person.username}`}>
                    <Avatar name={r.person.name} assetId={r.person.avatarAssetId} size={44} />
                  </Link>
                  <div className="t">
                    <b>{r.person.name}</b>
                    <small>{[r.person.headline, r.person.primaryOrg?.displayName].filter(Boolean).join(" · ")}</small>
                    {r.message ? <small style={{ color: "var(--text)", marginTop: 3 }}>&ldquo;{r.message}&rdquo;</small> : null}
                  </div>
                  <div className="row">
                    <Button kind="p" small loading={busyId === r.id} onClick={() => respond(r.id, "accept")} data-testid={`network-accept-${r.id}`}>
                      Accept
                    </Button>
                    <Button small loading={busyId === r.id} onClick={() => respond(r.id, "ignore")} data-testid={`network-ignore-${r.id}`}>
                      Ignore
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="ct">People you may know</div>
          {loading ? (
            <div className="grid3">
              <Skeleton h={160} />
              <Skeleton h={160} />
              <Skeleton h={160} />
            </div>
          ) : suggestions.length === 0 ? (
            <Empty title="No suggestions right now" text="Connect with a few people and we'll find more." />
          ) : (
            <div className="grid3" data-testid="network-suggestions">
              {suggestions.map((s) => (
                <div className="card tight pymk-card" key={s.recommendationId}>
                  <button
                    type="button"
                    className="ib pymk-dismiss"
                    aria-label={`Dismiss ${s.person.name}`}
                    onClick={() => dismiss(s.recommendationId)}
                    data-testid={`network-dismiss-${s.person.id}`}
                  >
                    ×
                  </button>
                  <Link href={`/people/${s.person.username}`} style={{ display: "block", textAlign: "center" }}>
                    <Avatar name={s.person.name} assetId={s.person.avatarAssetId} size={52} />
                    <b style={{ display: "block", marginTop: 8 }}>{s.person.name}</b>
                  </Link>
                  <small className="dim" style={{ display: "block", textAlign: "center" }}>
                    {[s.person.headline, s.person.primaryOrg?.displayName].filter(Boolean).join(" · ")}
                  </small>
                  <small className="xs" style={{ display: "block", textAlign: "center", color: "var(--accent)", margin: "4px 0 8px" }}>
                    {s.reason}
                  </small>
                  <Button kind="" wide small icon="plus" loading={busyId === s.person.id} onClick={() => connect(s.person.id)} data-testid={`network-connect-${s.person.id}`}>
                    Connect
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="col">
        <div className="card">
          <div className="ct">Introductions</div>
          <p className="sm dim">Ask a connection to introduce you to someone they know.</p>
          <Button href="/network/intros" small data-testid="network-intros-link">
            Open introductions
          </Button>
        </div>
        <div className="card">
          <div className="ct">Manage</div>
          <div className="list sm">
            <div className="li">
              <div className="t">
                <b>{counts ? counts.all : "…"} connections</b>
              </div>
              <Link href="/connections" data-testid="network-manage-connections">
                View
              </Link>
            </div>
            <div className="li">
              <div className="t">
                <b>{followingOrgs} companies followed</b>
              </div>
              <Link href="/network/following" data-testid="network-manage-following">
                View
              </Link>
            </div>
            <div className="li">
              <div className="t">
                <b>Import contacts</b>
                <small>Add emails or a CSV/VCF export — you choose what to send.</small>
              </div>
              <Button href="/network/import" small data-testid="network-import-link">
                Import
              </Button>
            </div>
            <div className="li">
              <div className="t">
                <b>Blocked &amp; muted</b>
              </div>
              <Link href="/settings/blocked" data-testid="network-manage-blocked">
                View
              </Link>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
