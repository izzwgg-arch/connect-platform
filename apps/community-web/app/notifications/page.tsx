"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Empty, Icon, Menu, Skeleton, timeAgo, useToast } from "@/components/ui";
import "@/components/notifications/notifications.css";

type PersonCard = { id: string; username: string; name: string; avatarAssetId: string | null };
type NotifItem = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  count: number;
  readAt: string | null;
  createdAt: string;
  objectType: string | null;
  objectId: string | null;
  actor: PersonCard | null;
  group: "today" | "week" | "earlier";
};

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "decisions", label: "Needs a decision" },
  { key: "network", label: "Network" },
  { key: "rfq", label: "RFQs & quotes" },
  { key: "jobs", label: "Jobs" },
  { key: "posts", label: "Posts" },
  { key: "events", label: "Events" },
  { key: "security", label: "Security" },
];

const GROUP_LABEL: Record<NotifItem["group"], string> = { today: "Today", week: "This week", earlier: "Earlier" };

export default function NotificationsPage() {
  return (
    <RequireAuth>
      <AppShell cols="two" title="Notifications">
        <NotificationsBody />
        <div className="col">
          <QuietHoursCard />
          <ChannelsCard />
        </div>
      </AppShell>
    </RequireAuth>
  );
}

function NotificationsBody() {
  const { on, setCounts } = useAuth();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [items, setItems] = useState<NotifItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (f: string) => {
    setItems(null);
    setCursor(null);
    const r = await api<{ items: NotifItem[]; nextCursor: string | null }>(`/notifications?filter=${f}`);
    setItems(r.items);
    setCursor(r.nextCursor);
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Live inserts: prepend as soon as the event arrives; a de-dup on id keeps
  // a later scroll-load from double-inserting the same row.
  useEffect(
    () =>
      on("notification", (data: any) => {
        setItems((cur) => {
          if (!cur) return cur;
          if (cur.some((i) => i.id === data.id)) return cur;
          const row: NotifItem = { id: data.id, kind: data.kind, title: data.title, body: data.body ?? null, href: data.href ?? null, count: data.count ?? 1, readAt: null, createdAt: new Date().toISOString(), objectType: null, objectId: null, actor: null, group: "today" };
          return [row, ...cur];
        });
      }),
    [on],
  );

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: NotifItem[]; nextCursor: string | null }>(`/notifications?filter=${filter}&cursor=${encodeURIComponent(cursor)}`);
      setItems((cur) => {
        const seen = new Set((cur ?? []).map((i) => i.id));
        return [...(cur ?? []), ...r.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(r.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loadingMore, filter]);

  async function markAllRead() {
    setBusyAll(true);
    try {
      const r = await api<{ unread: number }>("/notifications/read", { method: "POST", body: { all: true } });
      setItems((cur) => cur?.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) ?? cur);
      setCounts({ notifications: r.unread });
      toast("All caught up.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusyAll(false);
    }
  }

  async function act(id: string, path: string, method: "POST" = "POST") {
    try {
      await api(path, { method });
      setItems((cur) => cur?.filter((i) => i.id !== id) ?? cur);
      toast("Done.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  async function del(id: string) {
    try {
      await api(`/notifications/${id}`, { method: "DELETE" });
      setItems((cur) => cur?.filter((i) => i.id !== id) ?? cur);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  const groups: NotifItem["group"][] = ["today", "week", "earlier"];

  return (
    <div className="col">
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ fontSize: 18 }}>Notifications</h2>
          <div className="row">
            <Button kind="g" small onClick={markAllRead} loading={busyAll} data-testid="notifications-markallread">
              Mark all read
            </Button>
            <Button kind="g" small icon="gear" href="/settings/notifications" data-testid="notifications-settings-link">
              Settings
            </Button>
          </div>
        </div>
        <div className="pill-row" style={{ marginBottom: 12 }}>
          {FILTERS.map((f) => (
            <Chip key={f.key} kind={filter === f.key ? "sel" : ""} onClick={() => setFilter(f.key)} title={f.label} testId={`notifications-filter-${f.key}`}>
              {f.label}
            </Chip>
          ))}
        </div>
        {items === null ? (
          <div className="list">
            <Skeleton h={56} />
            <Skeleton h={56} />
            <Skeleton h={56} />
          </div>
        ) : items.length === 0 ? (
          <Empty title="You're all caught up" text="Nothing here yet." />
        ) : (
          <>
            {groups.map((g) => {
              const rows = items.filter((i) => i.group === g);
              if (!rows.length) return null;
              return (
                <div key={g}>
                  <span className="lbl notif-group-label">{GROUP_LABEL[g]}</span>
                  <div className="list">
                    {rows.map((item) => (
                      <NotifRow key={item.id} item={item} onAct={act} onDelete={del} />
                    ))}
                  </div>
                </div>
              );
            })}
            <div ref={sentinelRef} className="notif-sentinel" />
            {loadingMore ? <Skeleton h={40} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function isDecision(kind: string) {
  return ["connection.request", "message.request", "rfq.quote", "rfq.invite", "intro.request", "group.request", "org.invite", "recommendation.new"].includes(kind);
}

function NotifRow({ item, onAct, onDelete }: { item: NotifItem; onAct: (id: string, path: string) => void; onDelete: (id: string) => void }) {
  const decision = isDecision(item.kind);
  return (
    <div className={`notif-row ${decision ? "decision" : ""} ${!item.readAt ? "unread" : ""}`} data-testid={`notifications-item-${item.id}`}>
      <Avatar name={item.actor?.name ?? item.title} assetId={item.actor?.avatarAssetId} size={40} />
      <div className="body">
        <p dangerouslySetInnerHTML={{ __html: item.count > 1 ? `${item.title}${item.body ? ` — ${item.body}` : ""} <b>(${item.count})</b>` : `${item.title}${item.body ? ` — ${item.body}` : ""}` }} />
        <time>{timeAgo(item.createdAt)}</time>
      </div>
      <div className="acts">
        {item.kind === "connection.request" && item.objectId ? (
          <>
            <Button kind="p" small onClick={() => onAct(item.id, `/connections/${item.objectId}/accept`)} data-testid={`notifications-accept-${item.id}`}>
              Accept
            </Button>
            <Button kind="g" small onClick={() => onAct(item.id, `/connections/${item.objectId}/ignore`)} data-testid={`notifications-ignore-${item.id}`}>
              Ignore
            </Button>
          </>
        ) : item.href ? (
          <Button kind="g" small href={item.href} data-testid={`notifications-view-${item.id}`}>
            View
          </Button>
        ) : null}
        <Menu label="More" testId={`notifications-menu-${item.id}`}>
          <button type="button" onClick={() => onDelete(item.id)} data-testid={`notifications-delete-${item.id}`}>
            <Icon name="trash" />
            Delete
          </button>
        </Menu>
      </div>
    </div>
  );
}

function QuietHoursCard() {
  const [quiet, setQuiet] = useState<{ enabled: boolean; from: string; to: string } | null>(null);
  useEffect(() => {
    api<{ quietHours: { enabled: boolean; from: string; to: string } }>("/me/notification-prefs").then((r) => setQuiet(r.quietHours)).catch(() => {});
  }, []);
  return (
    <div className="card">
      <div className="ct">Quiet hours</div>
      {quiet ? (
        <p className="sm dim">{quiet.enabled ? `Push is silent ${quiet.from}–${quiet.to}.` : "Quiet hours are off — push can arrive any time."}</p>
      ) : (
        <Skeleton h={16} />
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <Link href="/settings/notifications" className="btn w s" data-testid="notifications-edit-quiet-hours">
          Edit in Settings
        </Link>
      </div>
    </div>
  );
}

function ChannelsCard() {
  return (
    <div className="card">
      <div className="ct">Channels</div>
      <p className="sm dim">Set in-app, push, email and SMS per notification type.</p>
      <div className="row" style={{ marginTop: 8 }}>
        <Link href="/settings/notifications" className="btn w s" data-testid="notifications-edit-channels">
          Edit channels
        </Link>
      </div>
    </div>
  );
}
