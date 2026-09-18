"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui";

type Health = { last24h: Array<{ kind: string; sent: number; emailed: number; pushed: number }>; pendingPush: number; staleDeviceTokens: number };

export default function AdminNotificationsHealthPage() {
  const [data, setData] = useState<Health | null>(null);

  useEffect(() => {
    api<Health>("/admin/notifications/health").then(setData);
  }, []);

  if (!data) return <Skeleton h={300} />;

  return (
    <div className="col">
      <h1>Notifications health</h1>
      <p className="sub">What actually got sent, emailed and pushed in the last 24 hours, by notification class.</p>
      <div className="grid3">
        <div className="card tight stat">
          <small>Pending push</small>
          <b>{data.pendingPush}</b>
        </div>
        <div className="card tight stat">
          <small>Stale device tokens (90d+)</small>
          <b>{data.staleDeviceTokens}</b>
        </div>
      </div>
      <div className="card">
        <div className="ct">Last 24 hours by class</div>
        {data.last24h.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Class</th>
                <th className="num">Sent</th>
                <th className="num">Emailed</th>
                <th className="num">Pushed</th>
              </tr>
            </thead>
            <tbody>
              {data.last24h.map((r) => (
                <tr key={r.kind}>
                  <td className="mono">{r.kind}</td>
                  <td className="num mono">{r.sent}</td>
                  <td className="num mono">{r.emailed}</td>
                  <td className="num mono">{r.pushed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sm dim">Nothing sent in the last 24 hours.</p>
        )}
      </div>
    </div>
  );
}
