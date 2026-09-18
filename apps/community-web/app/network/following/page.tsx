"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Empty, Skeleton, useToast } from "@/components/ui";
import type { OrgCard, PersonCard } from "@/components/graph/types";

export default function FollowingPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [tab, setTab] = useState<"people" | "organizations">("organizations");
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<PersonCard[]>([]);
  const [orgs, setOrgs] = useState<OrgCard[]>([]);

  useEffect(() => {
    setLoading(true);
    Promise.all([api<{ items: PersonCard[] }>("/me/following?type=people"), api<{ items: OrgCard[] }>("/me/following?type=organizations")])
      .then(([p, o]) => {
        setPeople(p.items);
        setOrgs(o.items);
      })
      .catch((e) => toast(e?.message ?? "Couldn't load who you follow.", { kind: "err" }))
      .finally(() => setLoading(false));
  }, [toast]);

  async function unfollowPerson(id: string) {
    setPeople((s) => s.filter((p) => p.id !== id));
    await api(`/people/${id}/follow`, { method: "DELETE" }).catch(() => undefined);
  }
  async function unfollowOrg(id: string) {
    setOrgs((s) => s.filter((o) => o.id !== id));
    await api(`/organizations/${id}/follow`, { method: "DELETE" }).catch(() => undefined);
  }

  return (
    <AppShell title="Following">
      <div className="card" style={{ gridColumn: "1/-1" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ fontSize: 18 }}>Following</h2>
        </div>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button type="button" className={tab === "organizations" ? "on" : ""} onClick={() => setTab("organizations")} data-testid="following-tab-orgs">
            Companies <span className="n">{orgs.length}</span>
          </button>
          <button type="button" className={tab === "people" ? "on" : ""} onClick={() => setTab("people")} data-testid="following-tab-people">
            People <span className="n">{people.length}</span>
          </button>
        </div>
        {loading ? (
          <div className="list">
            <Skeleton h={44} />
            <Skeleton h={44} />
          </div>
        ) : tab === "organizations" ? (
          orgs.length === 0 ? (
            <Empty title="You aren't following any companies yet" />
          ) : (
            <div className="list" data-testid="following-orgs-list">
              {orgs.map((o) => (
                <div className="li" key={o.id}>
                  <Link href={`/companies/${o.slug}`}>
                    <Avatar name={o.displayName} assetId={o.logoAssetId} size={40} square />
                  </Link>
                  <div className="t">
                    <b>{o.displayName}</b>
                    <small>{[o.industry, o.location].filter(Boolean).join(" · ")}</small>
                  </div>
                  <Button small kind="g" onClick={() => unfollowOrg(o.id)} data-testid={`following-unfollow-org-${o.id}`}>
                    Unfollow
                  </Button>
                </div>
              ))}
            </div>
          )
        ) : people.length === 0 ? (
          <Empty title="You aren't following anyone yet" />
        ) : (
          <div className="list" data-testid="following-people-list">
            {people.map((p) => (
              <div className="li" key={p.id}>
                <Link href={`/people/${p.username}`}>
                  <Avatar name={p.name} assetId={p.avatarAssetId} size={40} />
                </Link>
                <div className="t">
                  <b>{p.name}</b>
                  <small>{p.headline ?? p.primaryOrg?.displayName ?? ""}</small>
                </div>
                <Button small kind="g" onClick={() => unfollowPerson(p.id)} data-testid={`following-unfollow-person-${p.id}`}>
                  Unfollow
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
