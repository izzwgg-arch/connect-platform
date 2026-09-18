"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Chip, Empty, Field, Skeleton } from "@/components/ui";

type UserRow = { id: string; username: string; name: string; email: string | null; avatarAssetId: string | null; status: string; staffRole: string | null; verified: string[]; createdAt: string };

const STATUS_KIND: Record<string, "" | "ok" | "warn" | "bad"> = { ACTIVE: "ok", SUSPENDED: "warn", BANNED: "bad", DEACTIVATED: "", PENDING_DELETION: "" };

export default function AdminUsersPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<UserRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((reset: boolean, nextCursor?: string | null) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (status) qs.set("status", status);
    if (!reset && nextCursor) qs.set("cursor", nextCursor);
    api<{ items: UserRow[]; nextCursor: string | null }>(`/admin/users?${qs.toString()}`)
      .then((r) => {
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setCursor(r.nextCursor);
      })
      .finally(() => setLoading(false));
  }, [q, status]);

  useEffect(() => {
    const t = setTimeout(() => load(true), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  return (
    <div className="col">
      <h1>Users</h1>
      <p className="sub">Every registered person. Status changes and staff roles are ADMIN-only and audited.</p>
      <div className="row">
        <Field label="Search" htmlFor="admin-users-q">
          <input id="admin-users-q" className="in" placeholder="Name, username or email" value={q} onChange={(e) => setQ(e.target.value)} data-testid="admin-users-search" />
        </Field>
        <Field label="Status" htmlFor="admin-users-status">
          <select id="admin-users-status" className="in" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="admin-users-status">
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="BANNED">Banned</option>
            <option value="DEACTIVATED">Deactivated</option>
          </select>
        </Field>
      </div>
      <div className="card">
        {loading && !items.length ? (
          <Skeleton h={200} />
        ) : !items.length ? (
          <Empty title="No matches" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Person</th>
                <th>Email</th>
                <th>Status</th>
                <th>Staff</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} data-testid={`admin-users-row-${u.id}`}>
                  <td>
                    <Link href={`/admin/users/${u.id}`} className="row sm">
                      <Avatar name={u.name} assetId={u.avatarAssetId} size={26} />
                      <b>{u.name}</b>
                      <small className="dim">@{u.username}</small>
                    </Link>
                  </td>
                  <td className="dim">{u.email || "—"}</td>
                  <td>
                    <Chip kind={STATUS_KIND[u.status] ?? ""}>{u.status.toLowerCase()}</Chip>
                  </td>
                  <td>{u.staffRole ? <Chip kind="ac">{u.staffRole}</Chip> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor ? (
          <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn s" onClick={() => load(false, cursor)} data-testid="admin-users-load-more">
              Load more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
