"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, mediaUrl, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Icon, Skeleton, VChip, timeAgo, useToast } from "@/components/ui";
import "@/components/groups/groups.css";

type PersonCard = { id: string; username: string; name: string; avatarAssetId: string | null; headline: string | null };
type Membership = { role: "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER"; state: "ACTIVE" | "PENDING" | "BANNED" | "LEFT" } | null;

type GroupFull = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  isPrivate: boolean;
  requiresApproval: boolean;
  coverAssetId: string | null;
  logoAssetId: string | null;
  memberCount: number;
  chatThreadId: string | null;
};

type PublicGroupRes =
  | { preview: true; group: { id: string; slug: string; name: string; description: string | null; isPrivate: boolean; memberCount: number }; myMembership: Membership }
  | {
      preview: false;
      group: GroupFull;
      rules: string | null;
      pinnedPostIds: string[];
      admins: PersonCard[];
      counts: { members: number; posts: number; files: number; events: number };
      myMembership: Membership;
    };

const TABS = [
  ["feed", "Feed"],
  ["chat", "Chat"],
  ["files", "Files"],
  ["events", "Events"],
  ["jobs", "Jobs"],
  ["listings", "Listings"],
  ["members", "Members"],
  ["rules", "Rules"],
] as const;
type TabKey = (typeof TABS)[number][0];

function isAdmin(m: Membership) {
  return !!m && m.state === "ACTIVE" && (m.role === "OWNER" || m.role === "ADMIN");
}
function isActive(m: Membership) {
  return !!m && m.state === "ACTIVE";
}

/* ───────────────────────────── Feed tab ───────────────────────────── */
type PostDto = {
  id: string;
  body: string | null;
  createdAt: string;
  author: PersonCard | null;
  media: Array<{ id: string; kind: string; urls: { medium: string } }>;
  counts: { reactions: number; comments: number };
  myReaction: string | null;
};

function FeedTab({ groupId, canPost, isAdminUser, pinnedPostIds }: { groupId: string; canPost: boolean; isAdminUser: boolean; pinnedPostIds: string[] }) {
  const toast = useToast();
  const [items, setItems] = useState<PostDto[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ items: PostDto[] }>(`/groups/${groupId}/posts`).then((r) => setItems(r.items));
  }, [groupId]);
  useEffect(load, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/posts`, { method: "POST", body: { body: body.trim() }, idempotencyKey: newIdempotencyKey() });
      setBody("");
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't post.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function react(id: string, mine: string | null) {
    setItems((cur) => cur?.map((p) => (p.id === id ? { ...p, myReaction: mine ? null : "LIKE", counts: { ...p.counts, reactions: p.counts.reactions + (mine ? -1 : 1) } } : p)) ?? cur);
    try {
      if (mine) await api(`/posts/${id}/react`, { method: "DELETE" });
      else await api(`/posts/${id}/react`, { method: "POST", body: { kind: "LIKE" } });
    } catch {
      load();
    }
  }

  async function togglePin(id: string) {
    try {
      await api(`/groups/${groupId}/posts/${id}/pin`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't pin that post.", { kind: "err" });
    }
  }

  const pinned = items?.filter((p) => pinnedPostIds.includes(p.id)) ?? [];
  const rest = items?.filter((p) => !pinnedPostIds.includes(p.id)) ?? [];

  return (
    <div className="col" style={{ gap: 12 }}>
      {canPost ? (
        <form className="card" onSubmit={submit}>
          <textarea className="in" placeholder="Share something with the group…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={6000} data-testid="group-feed-composer" />
          <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <Button kind="p" type="submit" small loading={busy} disabled={!body.trim()} data-testid="group-feed-post">
              Post
            </Button>
          </div>
        </form>
      ) : null}
      {items === null ? (
        <div className="card"><Skeleton h={80} /></div>
      ) : items.length === 0 ? (
        <div className="card"><Empty title="No posts yet" text={canPost ? "Be the first to post." : "Nothing here yet."} /></div>
      ) : (
        <>
          {pinned.map((p) => (
            <PostCard key={p.id} p={p} isAdminUser={isAdminUser} pinned onPin={togglePin} onReact={react} />
          ))}
          {rest.map((p) => (
            <PostCard key={p.id} p={p} isAdminUser={isAdminUser} pinned={false} onPin={togglePin} onReact={react} />
          ))}
        </>
      )}
    </div>
  );
}

function PostCard({ p, isAdminUser, pinned, onPin, onReact }: { p: PostDto; isAdminUser: boolean; pinned: boolean; onPin: (id: string) => void; onReact: (id: string, mine: string | null) => void }) {
  return (
    <div className={`card ${pinned ? "group-pinned" : ""}`} data-testid={`group-post-${p.id}`}>
      {pinned ? (
        <div className="row sm dim" style={{ marginBottom: 6 }}>
          <Icon name="pin" /> Pinned
        </div>
      ) : null}
      <div className="row">
        <Avatar name={p.author?.name ?? "Member"} assetId={p.author?.avatarAssetId} size={36} />
        <div className="t">
          <b>{p.author?.name ?? "Member"}</b>
          <small>{timeAgo(p.createdAt)}</small>
        </div>
        {isAdminUser ? (
          <button type="button" className="ib" aria-label={pinned ? "Unpin post" : "Pin post"} onClick={() => onPin(p.id)} data-testid={`group-post-pin-${p.id}`}>
            <Icon name="pin" />
          </button>
        ) : null}
      </div>
      {p.body ? <p style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{p.body}</p> : null}
      {p.media.length ? (
        <div className="grid2" style={{ marginTop: 10 }}>
          {p.media.map((m) => (
            <img key={m.id} src={m.urls.medium} alt="" style={{ width: "100%", borderRadius: 8 }} />
          ))}
        </div>
      ) : null}
      <div className="row sm dim" style={{ marginTop: 10 }}>
        <button type="button" className={`chip ${p.myReaction ? "ac" : ""}`} onClick={() => onReact(p.id, p.myReaction)} data-testid={`group-post-like-${p.id}`}>
          <Icon name="like" /> {p.counts.reactions}
        </button>
        <span className="chip">
          <Icon name="chat" /> {p.counts.comments}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────────── Files tab ───────────────────────────── */
type FileDto = { id: string; assetId: string; title: string; uploader: PersonCard | null; createdAt: string };

function FilesTab({ groupId, canUpload, isAdminUser, myId }: { groupId: string; canUpload: boolean; isAdminUser: boolean; myId: string | null }) {
  const toast = useToast();
  const [items, setItems] = useState<FileDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    api<{ items: FileDto[] }>(`/groups/${groupId}/files`).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [groupId]);
  useEffect(load, [load]);

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("title", file.name);
      await api(`/groups/${groupId}/files`, { method: "POST", form });
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't upload that file.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/groups/${groupId}/files/${id}`, { method: "DELETE" });
      setItems((cur) => cur?.filter((f) => f.id !== id) ?? cur);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't delete that file.", { kind: "err" });
    }
  }

  return (
    <div className="card">
      {canUpload ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            ref={inputRef}
            type="file"
            hidden
            data-testid="group-files-input"
            onChange={(e) => {
              if (e.target.files?.[0]) void upload(e.target.files[0]);
              e.target.value = "";
            }}
          />
          <Button kind="p" icon="up" small loading={busy} onClick={() => inputRef.current?.click()} data-testid="group-files-upload">
            Upload a file
          </Button>
        </div>
      ) : null}
      {items === null ? (
        <Skeleton h={60} />
      ) : items.length === 0 ? (
        <Empty title="No files shared yet" />
      ) : (
        <div className="list sm">
          {items.map((f) => (
            <div className="group-file-row" key={f.id} data-testid={`group-file-${f.id}`}>
              <Icon name="doc" />
              <div className="t">
                <b>{f.title}</b>
                <small>
                  {f.uploader?.name ?? "Member"} · {timeAgo(f.createdAt)}
                </small>
              </div>
              <a className="btn s" href={mediaUrl(f.assetId, "original") ?? "#"} target="_blank" rel="noreferrer" data-testid={`group-file-download-${f.id}`}>
                Download
              </a>
              {(f.uploader?.id === myId || isAdminUser) && (
                <button type="button" className="ib" aria-label="Delete file" onClick={() => remove(f.id)} data-testid={`group-file-delete-${f.id}`}>
                  <Icon name="trash" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Members tab ───────────────────────────── */
type MemberDto = { person: PersonCard | null; role: string; state: string; joinedAt: string };

function MembersTab({ groupId, isAdminUser }: { groupId: string; isAdminUser: boolean }) {
  const toast = useToast();
  const [active, setActive] = useState<MemberDto[] | null>(null);
  const [pending, setPending] = useState<MemberDto[] | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(() => {
    api<{ items: MemberDto[] }>(`/groups/${groupId}/members?state=ACTIVE`).then((r) => setActive(r.items));
    if (isAdminUser) api<{ items: MemberDto[] }>(`/groups/${groupId}/members?state=PENDING`).then((r) => setPending(r.items));
  }, [groupId, isAdminUser]);
  useEffect(load, [load]);

  async function act(personId: string, patch: { role?: string; state?: string }) {
    try {
      await api(`/groups/${groupId}/members/${personId}`, { method: "PATCH", body: patch });
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't update that member.", { kind: "err" });
    }
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {isAdminUser ? (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button kind="p" icon="plus" small onClick={() => setInviteOpen(true)} data-testid="group-members-invite">
            Invite connections
          </Button>
        </div>
      ) : null}
      {isAdminUser && pending && pending.length > 0 ? (
        <div className="card">
          <div className="ct">Pending requests <span className="more">{pending.length}</span></div>
          <div className="list sm">
            {pending.map((m) => (
              <div className="li" key={m.person?.id} data-testid={`group-pending-${m.person?.id}`}>
                <Avatar name={m.person?.name ?? "?"} assetId={m.person?.avatarAssetId} size={32} />
                <div className="t">
                  <b>{m.person?.name}</b>
                </div>
                <div className="row">
                  <Button small onClick={() => m.person && act(m.person.id, { state: "ACTIVE" })} data-testid={`group-approve-${m.person?.id}`}>
                    Approve
                  </Button>
                  <Button small kind="g" onClick={() => m.person && act(m.person.id, { state: "BANNED" })} data-testid={`group-deny-${m.person?.id}`}>
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="card">
        <div className="ct">Members</div>
        {active === null ? (
          <Skeleton h={60} />
        ) : (
          <div className="list sm">
            {active.map((m) => (
              <div className="li" key={m.person?.id} data-testid={`group-member-${m.person?.id}`}>
                <Avatar name={m.person?.name ?? "?"} assetId={m.person?.avatarAssetId} size={32} />
                <div className="t">
                  <Link href={`/people/${m.person?.username}`}>
                    <b>{m.person?.name}</b>
                  </Link>
                  <small>{m.person?.headline}</small>
                </div>
                <Chip kind={m.role === "OWNER" ? "ac" : ""}>{m.role}</Chip>
                {isAdminUser && m.role !== "OWNER" ? (
                  <div className="row">
                    {m.role === "MEMBER" ? (
                      <Button small kind="g" onClick={() => m.person && act(m.person.id, { role: "ADMIN" })} data-testid={`group-promote-${m.person?.id}`}>
                        Make admin
                      </Button>
                    ) : (
                      <Button small kind="g" onClick={() => m.person && act(m.person.id, { role: "MEMBER" })} data-testid={`group-demote-${m.person?.id}`}>
                        Remove admin
                      </Button>
                    )}
                    <Button small kind="g" onClick={() => m.person && act(m.person.id, { state: "BANNED" })} data-testid={`group-ban-${m.person?.id}`}>
                      Remove
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
      <InviteDialog groupId={groupId} open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  );
}

function InviteDialog({ groupId, open, onClose }: { groupId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [connections, setConnections] = useState<PersonCard[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api<{ items: Array<{ person: PersonCard }> }>("/connections?limit=100")
      .then((r) => setConnections(r.items.map((i) => i.person)))
      .catch(() => setConnections([]));
  }, [open]);

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!picked.size) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/invites`, { method: "POST", body: { personIds: [...picked] }, idempotencyKey: newIdempotencyKey() });
      toast("Invitations sent.");
      setPicked(new Set());
      onClose();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send invites.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Invite connections">
      {connections === null ? (
        <Skeleton h={80} />
      ) : connections.length === 0 ? (
        <Empty title="No connections to invite yet" />
      ) : (
        <div className="list sm" style={{ maxHeight: 320, overflow: "auto" }}>
          {connections.map((c) => (
            <label className="li" key={c.id} style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} data-testid={`group-invite-pick-${c.id}`} />
              <Avatar name={c.name} assetId={c.avatarAssetId} size={30} />
              <div className="t">
                <b>{c.name}</b>
              </div>
            </label>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <Button kind="g" onClick={onClose}>Cancel</Button>
        <Button kind="p" loading={busy} disabled={!picked.size} onClick={submit} data-testid="group-invite-send">
          Send invites
        </Button>
      </div>
    </Dialog>
  );
}

/* ───────────────────────────── Rules tab ───────────────────────────── */
function RulesTab({ groupId, rules, isAdminUser, onSaved }: { groupId: string; rules: string | null; isAdminUser: boolean; onSaved: (r: string) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rules ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/groups/${groupId}`, { method: "PATCH", body: { rules: text } });
      onSaved(text);
      setEditing(false);
      toast("Rules updated.");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't save the rules.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card group-rules-edit">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="ct">Group rules</div>
        {isAdminUser && !editing ? (
          <Button small kind="g" icon="edit" onClick={() => setEditing(true)} data-testid="group-rules-edit">
            Edit
          </Button>
        ) : null}
      </div>
      {editing ? (
        <>
          <textarea className="in" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} data-testid="group-rules-textarea" />
          <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <Button kind="g" small onClick={() => setEditing(false)}>Cancel</Button>
            <Button kind="p" small loading={busy} onClick={save} data-testid="group-rules-save">Save</Button>
          </div>
        </>
      ) : rules ? (
        <p style={{ whiteSpace: "pre-wrap" }}>{rules}</p>
      ) : (
        <Empty title="No rules set yet" />
      )}
    </div>
  );
}

/* ───────────────────────────── Events / Jobs / Listings tabs ───────────────────────────── */
type EventRow = { id: string; slug: string; title: string; startsAt: string; venue: string | null; mode: string };

function EventsTab({ groupId, isAdminUser }: { groupId: string; isAdminUser: boolean }) {
  const [items, setItems] = useState<EventRow[] | null>(null);
  useEffect(() => {
    api<{ items: EventRow[] }>(`/groups/${groupId}/events`).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [groupId]);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div className="ct">Group events</div>
        {isAdminUser ? (
          <Button small kind="p" icon="plus" href={`/events/new?groupId=${groupId}`} data-testid="group-events-create">
            Create event
          </Button>
        ) : null}
      </div>
      {items === null ? <Skeleton h={60} /> : items.length === 0 ? <Empty title="No events yet" /> : (
        <div className="list sm">
          {items.map((e) => (
            <Link className="li" href={`/events/${e.slug}`} key={e.id} data-testid={`group-event-${e.id}`}>
              <Icon name="cal" />
              <div className="t">
                <b>{e.title}</b>
                <small>{new Date(e.startsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{e.venue ? ` · ${e.venue}` : ""}</small>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemsListTab({ url, empty, hrefBase }: { url: string; empty: string; hrefBase: (id: string) => string }) {
  const [items, setItems] = useState<Array<{ id: string; title: string }> | null>(null);
  useEffect(() => {
    api<{ items: Array<{ id: string; title: string }> }>(url).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [url]);
  return (
    <div className="card">
      {items === null ? <Skeleton h={60} /> : items.length === 0 ? <Empty title={empty} /> : (
        <div className="list sm">
          {items.map((it) => (
            <Link className="li" href={hrefBase(it.id)} key={it.id}>
              <div className="t">
                <b>{it.title}</b>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Page ───────────────────────────── */
export default function GroupDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [res, setRes] = useState<PublicGroupRes | null>(null);
  const [notFound404, setNotFound404] = useState(false);
  const [tab, setTab] = useState<TabKey>("feed");
  const [joinBusy, setJoinBusy] = useState(false);

  const load = useCallback(() => {
    api<PublicGroupRes>(`/public/groups/${slug}`)
      .then(setRes)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound404(true);
      });
  }, [slug]);
  useEffect(() => {
    setRes(null);
    setNotFound404(false);
    load();
  }, [load]);

  async function join() {
    if (!res) return;
    if (!me) {
      router.push(`/login?next=${encodeURIComponent(`/groups/${slug}`)}`);
      return;
    }
    setJoinBusy(true);
    try {
      const r = await api<{ membership: Membership }>(`/groups/${res.group.id}/join`, { method: "POST" });
      toast(r.membership?.state === "PENDING" ? "Request sent — waiting on an admin." : "You joined the group.");
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't join.", { kind: "err" });
    } finally {
      setJoinBusy(false);
    }
  }

  async function leave() {
    if (!res || res.preview) return;
    try {
      await api(`/groups/${res.group.id}/leave`, { method: "POST" });
      toast("You left the group.");
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't leave.", { kind: "err" });
    }
  }

  async function openChat() {
    if (!res || res.preview) return;
    try {
      const r = await api<{ threadId: string }>(`/groups/${res.group.id}/chat`);
      router.push(`/messages/${r.threadId}`);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't open the chat.", { kind: "err" });
    }
  }

  if (notFound404) {
    const body = <div className="col" style={{ gridColumn: "1/-1" }}><Empty title="That group doesn't exist" action={<Button href="/groups">Back to groups</Button>} /></div>;
    return me ? <AppShell title="Group not found">{body}</AppShell> : <div className="content">{body}</div>;
  }

  if (!res) {
    const body = <div className="col" style={{ gridColumn: "1/-1" }}><Skeleton h={200} /></div>;
    return me ? <AppShell title="Group">{body}</AppShell> : <div className="content">{body}</div>;
  }

  const m = res.myMembership;
  const admin = isAdmin(m);
  const active = isActive(m);

  const header = (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="cover">{!res.preview && res.group.coverAssetId ? <img src={mediaUrl(res.group.coverAssetId, "medium") ?? undefined} alt="" /> : null}</div>
      <div style={{ padding: "0 20px 14px", display: "grid", gap: 10 }}>
        <div className="group-cover-wrap row group-hero-actions">
          <Avatar name={res.group.name} assetId={!res.preview ? res.group.logoAssetId : null} size={64} square />
          <span style={{ flex: 1 }} />
          {active ? (
            <Chip kind="ok" icon="check">Joined</Chip>
          ) : m?.state === "PENDING" ? (
            <Chip kind="warn">Pending approval</Chip>
          ) : (
            <Button kind="p" loading={joinBusy} onClick={join} data-testid="group-join">
              {res.group.isPrivate && !m ? "Request access" : "Join"}
            </Button>
          )}
          {active ? (
            <Button kind="g" small onClick={leave} data-testid="group-leave">
              Leave
            </Button>
          ) : null}
        </div>
        <h1 style={{ fontSize: 20 }}>{res.group.name}</h1>
        <p className="dim sm">
          {res.group.isPrivate ? "Private group" : "Public group"} · {res.group.memberCount.toLocaleString()} members
          {!res.preview ? ` · ${res.counts.posts} posts` : ""}
        </p>
        {!res.preview && res.admins.length ? (
          <p className="sm dim">Admins: {res.admins.map((a) => a.name).join(", ")}</p>
        ) : null}
        {!res.preview && active ? (
          <div className="tabs">
            {TABS.map(([key, label]) => (
              <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)} data-testid={`group-tab-${key}`}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (res.preview) {
    const body = (
      <div className="col" style={{ gridColumn: "1/-1" }}>
        {header}
        <div className="card">
          <p>{res.group.description || "This is a private group. Join to see its posts, files and members."}</p>
        </div>
      </div>
    );
    return me ? <AppShell title={res.group.name}>{body}</AppShell> : <div className="content">{body}</div>;
  }

  if (!active) {
    return (
      <AppShell title={res.group.name}>
        <div className="col" style={{ gridColumn: "1/-1" }}>
          {header}
          <div className="card">
            <p>{res.group.description || "Join this group to see its feed, chat, files and members."}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  const content =
    tab === "feed" ? (
      <FeedTab groupId={res.group.id} canPost={active} isAdminUser={admin} pinnedPostIds={res.pinnedPostIds} />
    ) : tab === "chat" ? (
      <div className="card">
        <div className="ct">Group chat</div>
        <p className="sm dim" style={{ marginBottom: 10 }}>Open this group's shared conversation.</p>
        <Button kind="p" icon="chat" onClick={openChat} data-testid="group-chat-open">
          Open chat
        </Button>
      </div>
    ) : tab === "files" ? (
      <FilesTab groupId={res.group.id} canUpload={active} isAdminUser={admin} myId={me?.person.id ?? null} />
    ) : tab === "events" ? (
      <EventsTab groupId={res.group.id} isAdminUser={admin} />
    ) : tab === "jobs" ? (
      <ItemsListTab url={`/groups/${res.group.id}/jobs`} empty="No jobs from members right now." hrefBase={(id) => `/jobs/${id}`} />
    ) : tab === "listings" ? (
      <ItemsListTab url={`/groups/${res.group.id}/listings`} empty="No listings from members right now." hrefBase={(id) => `/marketplace/${id}`} />
    ) : tab === "members" ? (
      <MembersTab groupId={res.group.id} isAdminUser={admin} />
    ) : (
      <RulesTab groupId={res.group.id} rules={res.rules} isAdminUser={admin} onSaved={(r) => setRes((cur) => (cur && !cur.preview ? { ...cur, rules: r } : cur))} />
    );

  return (
    <AppShell title={res.group.name}>
      <div className="col" style={{ gridColumn: "1/-1", gap: 12 }}>
        {header}
        {content}
      </div>
    </AppShell>
  );
}
