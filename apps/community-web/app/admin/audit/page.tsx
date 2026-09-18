"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Empty, Skeleton, fmtDate } from "@/components/ui";

type AuditRow = { id: string; action: string; targetType: string; targetId: string | null; organizationId: string | null; createdAt: string; actor: { id: string; name: string; avatarAssetId: string | null } | null };

export default function AdminAuditPage() {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((reset: boolean, nextCursor?: string | null) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (!reset && nextCursor) qs.set("cursor", nextCursor);
    api<{ items: AuditRow[]; nextCursor: string | null }>(`/admin/audit?${qs.toString()}`)
      .then((r) => {
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setCursor(r.nextCursor);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(true);
  }, [load]);

  return (
    <div className="col">
      <h1>Audit log</h1>
      <p className="sub">Every account, role, moderation, verification and admin write, in order. Nothing here is ever edited or deleted.</p>
      <div className="card">
        {loading && !items.length ? (
          <Skeleton h={300} />
        ) : !items.length ? (
          <Empty title="Nothing logged yet" />
        ) : (
          <div className="list sm">
            {items.map((r) => (
              <div className="li" key={r.id}>
                {r.actor ? <Avatar name={r.actor.name} assetId={r.actor.avatarAssetId} size={26} /> : null}
                <div className="t">
                  <b>{r.action}</b>
                  <small>
                    {r.targetType}
                    {r.targetId ? ` · ${r.targetId}` : ""} {r.actor ? `· by ${r.actor.name}` : ""}
                  </small>
                  <small className="dim">{fmtDate(r.createdAt, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</small>
                </div>
              </div>
            ))}
          </div>
        )}
        {cursor ? (
          <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn s" onClick={() => load(false, cursor)} data-testid="admin-audit-load-more">
              Load more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
