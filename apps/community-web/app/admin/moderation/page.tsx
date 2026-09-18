"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Chip, Empty, Skeleton, timeAgo } from "@/components/ui";

type CaseItem = {
  id: string;
  targetType: string;
  targetId: string;
  target: { title: string; href: string | null };
  subject: { id: string; name?: string; displayName?: string; avatarAssetId?: string | null; logoAssetId?: string | null } | null;
  subjectKind: "person" | "organization" | null;
  reason: string;
  reportCount: number;
  severity: "high" | "medium" | "low";
  status: string;
  createdAt: string;
};

const STATUS_TABS = [
  { key: "", label: "Open queue" },
  { key: "ACTIONED", label: "Actioned" },
  { key: "DISMISSED", label: "Dismissed" },
  { key: "APPEALED", label: "Appealed" },
] as const;

const SEV_COLOR: Record<string, string> = { high: "var(--danger)", medium: "var(--warning)", low: "var(--border)" };

export default function ModerationQueuePage() {
  const [status, setStatus] = useState<string>("");
  const [items, setItems] = useState<CaseItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback((reset: boolean) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (!reset && cursor) qs.set("cursor", cursor);
    api<{ items: CaseItem[]; nextCursor: string | null; statusCounts: Record<string, number> }>(`/admin/moderation/cases?${qs.toString()}`)
      .then((r) => {
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setCursor(r.nextCursor);
        setCounts(r.statusCounts);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const subjectLabel = (c: CaseItem) => c.subject?.name || c.subject?.displayName || "(unknown)";

  return (
    <div className="col">
      <h1>Moderation queue</h1>
      <p className="sub">Reports open a case here; nothing gets actioned automatically except the anti-spam sweep, which only ever opens a case for a human to decide.</p>

      <div className="row" style={{ flexWrap: "wrap" }}>
        {STATUS_TABS.map((t) => (
          <Chip key={t.key} kind={status === t.key ? "sel" : ""} onClick={() => setStatus(t.key)} testId={`moderation-tab-${t.key || "open"}`}>
            {t.label}
            {t.key === "" ? ` · ${(counts.OPEN ?? 0) + (counts.IN_REVIEW ?? 0)}` : counts[t.key] ? ` · ${counts[t.key]}` : ""}
          </Chip>
        ))}
      </div>

      <div className="card">
        {loading && !items.length ? (
          <Skeleton h={200} />
        ) : !items.length ? (
          <Empty title="Nothing here" text="No cases match this filter." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th></th>
                <th>Report</th>
                <th>Subject</th>
                <th>Reports</th>
                <th>Age</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} data-testid={`moderation-row-${c.id}`}>
                  <td>
                    <span className="sev-stripe" style={{ background: SEV_COLOR[c.severity] }} />
                  </td>
                  <td>
                    <Link href={`/admin/moderation/${c.id}`}>
                      <b>{c.reason.replace(/_/g, " ").toLowerCase()}</b>
                    </Link>
                    <br />
                    <small className="dim">{c.target.title}</small>
                  </td>
                  <td className="dim">
                    <div className="row sm">
                      {c.subject ? <Avatar name={subjectLabel(c)} assetId={c.subject.avatarAssetId ?? c.subject.logoAssetId ?? null} size={20} /> : null}
                      {subjectLabel(c)}
                    </div>
                  </td>
                  <td className="mono dim">{c.reportCount}</td>
                  <td className="mono dim">{timeAgo(c.createdAt)}</td>
                  <td>
                    <Chip kind={c.status === "OPEN" || c.status === "IN_REVIEW" ? "warn" : c.status === "ACTIONED" ? "ok" : c.status === "APPEALED" ? "ac" : ""}>{c.status.toLowerCase()}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor ? (
          <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn s" onClick={() => load(false)} data-testid="moderation-load-more">
              Load more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
