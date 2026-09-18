"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Button, Empty, Skeleton, useToast } from "@/components/ui";
import type { OrgCard, PersonCard } from "@/components/graph/types";

type BlockedRow = { person: PersonCard; createdAt: string };

export default function BlockedSettingsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState<BlockedRow[]>([]);
  const [mutedPeople, setMutedPeople] = useState<PersonCard[]>([]);
  const [mutedOrgs, setMutedOrgs] = useState<OrgCard[]>([]);

  useEffect(() => {
    setLoading(true);
    Promise.all([api<{ items: BlockedRow[] }>("/me/blocked"), api<{ people: PersonCard[]; organizations: OrgCard[] }>("/me/muted")])
      .then(([b, m]) => {
        setBlocked(b.items);
        setMutedPeople(m.people);
        setMutedOrgs(m.organizations);
      })
      .catch((e) => toast(e?.message ?? "Couldn't load this.", { kind: "err" }))
      .finally(() => setLoading(false));
  }, [toast]);

  async function unblock(id: string) {
    setBlocked((s) => s.filter((b) => b.person.id !== id));
    try {
      await api(`/people/${id}/block`, { method: "DELETE" });
      toast("Unblocked.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't unblock.", { kind: "err" });
    }
  }
  async function unmutePerson(id: string) {
    setMutedPeople((s) => s.filter((p) => p.id !== id));
    await api(`/people/${id}/mute`, { method: "DELETE" }).catch(() => undefined);
  }
  async function unmuteOrg(id: string) {
    setMutedOrgs((s) => s.filter((o) => o.id !== id));
    await api(`/organizations/${id}/mute`, { method: "DELETE" }).catch(() => undefined);
  }

  if (loading) {
    return (
      <div className="card">
        <Skeleton h={20} w={140} />
        <div className="list" style={{ marginTop: 12 }}>
          <Skeleton h={44} />
          <Skeleton h={44} />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="ct">Blocked ({blocked.length})</div>
        {blocked.length === 0 ? (
          <Empty title="You haven't blocked anyone" />
        ) : (
          <div className="list" data-testid="blocked-list">
            {blocked.map((b) => (
              <div className="li" key={b.person.id}>
                <Avatar name={b.person.name} assetId={b.person.avatarAssetId} size={36} />
                <div className="t">
                  <b>{b.person.name}</b>
                  <small>{b.person.headline ?? ""}</small>
                </div>
                <Button small kind="g" onClick={() => unblock(b.person.id)} data-testid={`unblock-${b.person.id}`}>
                  Unblock
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="ct">Muted people ({mutedPeople.length})</div>
        {mutedPeople.length === 0 ? (
          <Empty title="No muted people" />
        ) : (
          <div className="list" data-testid="muted-people-list">
            {mutedPeople.map((p) => (
              <div className="li" key={p.id}>
                <Avatar name={p.name} assetId={p.avatarAssetId} size={36} />
                <div className="t">
                  <b>{p.name}</b>
                </div>
                <Button small kind="g" onClick={() => unmutePerson(p.id)} data-testid={`unmute-person-${p.id}`}>
                  Unmute
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="ct">Muted companies ({mutedOrgs.length})</div>
        {mutedOrgs.length === 0 ? (
          <Empty title="No muted companies" />
        ) : (
          <div className="list" data-testid="muted-orgs-list">
            {mutedOrgs.map((o) => (
              <div className="li" key={o.id}>
                <Avatar name={o.displayName} assetId={o.logoAssetId} size={36} square />
                <div className="t">
                  <b>{o.displayName}</b>
                </div>
                <Button small kind="g" onClick={() => unmuteOrg(o.id)} data-testid={`unmute-org-${o.id}`}>
                  Unmute
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
