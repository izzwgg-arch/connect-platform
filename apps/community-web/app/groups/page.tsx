"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Field, Skeleton, useToast } from "@/components/ui";
import "@/components/groups/groups.css";

type GroupItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  isPrivate: boolean;
  requiresApproval: boolean;
  logoAssetId: string | null;
  memberCount: number;
  myMembership: { role: string; state: string } | null;
};

function CreateGroupDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (g: GroupItem) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError("Give the group a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ group: GroupItem }>("/groups", { method: "POST", body: { name: name.trim(), description: description || undefined, category: category || undefined, isPrivate, requiresApproval } });
      toast(`${res.group.name} is live.`);
      onCreated({ ...res.group, myMembership: { role: "OWNER", state: "ACTIVE" } });
      setName("");
      setDescription("");
      setCategory("");
      setIsPrivate(false);
      setRequiresApproval(false);
      onClose();
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't create the group.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create a group">
      <form onSubmit={submit} className="col" style={{ gap: 10 }}>
        <Field label="Group name" htmlFor="grp-name">
          <input id="grp-name" className="in" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required data-testid="groups-new-name" />
        </Field>
        <Field label="Description" htmlFor="grp-desc">
          <textarea id="grp-desc" className="in" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} data-testid="groups-new-description" />
        </Field>
        <Field label="Category" htmlFor="grp-cat" help="e.g. Real Estate, Construction, Wholesale">
          <input id="grp-cat" className="in" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} data-testid="groups-new-category" />
        </Field>
        <label className="li" style={{ alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} data-testid="groups-new-private" />
          <div className="t">
            <b style={{ fontWeight: 500 }}>Private group</b>
            <small>Only members can see posts, files and the member list.</small>
          </div>
        </label>
        <label className="li" style={{ alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} data-testid="groups-new-approval" />
          <div className="t">
            <b style={{ fontWeight: 500 }}>Require admin approval to join</b>
            <small>New members wait for an admin to accept them.</small>
          </div>
        </label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button kind="g" type="button" onClick={onClose}>Cancel</Button>
          <Button kind="p" type="submit" loading={busy} data-testid="groups-new-submit">Create group</Button>
        </div>
      </form>
    </Dialog>
  );
}

function GroupRow({ g, onJoinChange }: { g: GroupItem; onJoinChange: (id: string, m: GroupItem["myMembership"]) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const state = g.myMembership?.state ?? null;

  async function join() {
    setBusy(true);
    try {
      const res = await api<{ membership: { role: string; state: string } }>(`/groups/${g.id}/join`, { method: "POST" });
      onJoinChange(g.id, res.membership);
      toast(res.membership.state === "PENDING" ? "Request sent — waiting on an admin." : `You joined ${g.name}.`);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't join that group.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="li" data-testid={`groups-row-${g.slug}`}>
      <Avatar name={g.name} assetId={g.logoAssetId} size={38} square />
      <div className="t">
        <Link href={`/groups/${g.slug}`}>
          <b>{g.name}</b>
        </Link>
        <small>
          {g.memberCount.toLocaleString()} members · {g.isPrivate ? "private" : "public"}
        </small>
      </div>
      {state === "ACTIVE" ? (
        <Chip kind="ok">Joined</Chip>
      ) : state === "PENDING" ? (
        <Chip kind="warn">Pending</Chip>
      ) : (
        <Button small loading={busy} onClick={join} data-testid={`groups-join-${g.slug}`}>
          Join
        </Button>
      )}
    </div>
  );
}

function GroupsBody() {
  const toast = useToast();
  const [mine, setMine] = useState<GroupItem[] | null>(null);
  const [discover, setDiscover] = useState<GroupItem[] | null>(null);
  const [categories, setCategories] = useState<Array<{ category: string; count: number }>>([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const loadMine = useCallback(() => {
    api<{ items: GroupItem[] }>("/me/groups").then((r) => setMine(r.items));
  }, []);
  const loadDiscover = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (category) params.set("category", category);
    api<{ items: GroupItem[] }>(`/groups?${params.toString()}`).then((r) => setDiscover(r.items));
  }, [q, category]);

  useEffect(() => {
    loadMine();
    api<{ categories: Array<{ category: string; count: number }> }>("/groups/categories").then((r) => setCategories(r.categories));
  }, [loadMine]);
  useEffect(() => {
    const t = setTimeout(loadDiscover, 200);
    return () => clearTimeout(t);
  }, [loadDiscover]);

  function patchMembership(list: GroupItem[] | null, id: string, m: GroupItem["myMembership"]) {
    return list ? list.map((g) => (g.id === id ? { ...g, myMembership: m } : g)) : list;
  }
  function onJoinChange(id: string, m: GroupItem["myMembership"]) {
    setDiscover((d) => patchMembership(d, id, m));
    if (m?.state === "ACTIVE") loadMine();
  }

  return (
    <>
      <div className="col">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <h2 style={{ fontSize: 18 }}>
              Your groups {mine ? <span className="more">{mine.length}</span> : null}
            </h2>
          </div>
          {mine === null ? (
            <Skeleton h={60} />
          ) : mine.length === 0 ? (
            <Empty title="You haven't joined a group yet" text="Discover one below, or start your own." />
          ) : (
            <div className="list sm">
              {mine.map((g) => (
                <GroupRow key={g.id} g={g} onJoinChange={onJoinChange} />
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="in" placeholder="Search groups…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} data-testid="groups-search" />
          </div>
          {categories.length ? (
            <div className="group-category-chips">
              <Chip kind={category === null ? "sel" : ""} onClick={() => setCategory(null)} testId="groups-category-all">
                All
              </Chip>
              {categories.map((c) => (
                <Chip key={c.category} kind={category === c.category ? "sel" : ""} onClick={() => setCategory(c.category)} testId={`groups-category-${c.category}`}>
                  {c.category} <span className="n">{c.count}</span>
                </Chip>
              ))}
            </div>
          ) : null}
          <div className="ct">Discover</div>
          {discover === null ? (
            <Skeleton h={80} />
          ) : discover.length === 0 ? (
            <Empty title="No groups found" text="Try a different search or category." />
          ) : (
            <div className="list sm">
              {discover.map((g) => (
                <GroupRow key={g.id} g={g} onJoinChange={onJoinChange} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="col">
        <div className="card">
          <div className="ct">Start something</div>
          <p className="sm dim">Own group, own rules — feed, chat, files, events, jobs and listings included.</p>
          <div style={{ marginTop: 8 }}>
            <Button kind="p" wide icon="plus" onClick={() => setCreateOpen(true)} data-testid="groups-create">
              Create a group
            </Button>
          </div>
        </div>
      </div>
      <CreateGroupDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(g) => setMine((m) => (m ? [g, ...m] : [g]))}
      />
    </>
  );
}

export default function GroupsPage() {
  return (
    <RequireAuth>
      <AppShell cols="two" title="Groups">
        <GroupsBody />
      </AppShell>
    </RequireAuth>
  );
}
