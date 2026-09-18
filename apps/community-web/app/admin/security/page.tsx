"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Chip, Skeleton, fmtDate } from "@/components/ui";

type Alerts = { last24h: Record<string, number>; spikeIps: Array<{ ip: string; count: number }>; sample: Array<{ id: string; action: string; ip: string | null; createdAt: string }> };

export default function AdminSecurityPage() {
  const [data, setData] = useState<Alerts | null>(null);

  useEffect(() => {
    api<Alerts>("/admin/security/alerts").then(setData);
  }, []);

  if (!data) return <Skeleton h={300} />;

  return (
    <div className="col">
      <h1>Security</h1>
      <p className="sub">Login failures, password resets and changes in the last 24 hours. An IP with 5+ events is flagged.</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {Object.entries(data.last24h).length ? (
          Object.entries(data.last24h).map(([k, v]) => (
            <span className="chip" key={k}>
              {k} · {v}
            </span>
          ))
        ) : (
          <span className="dim sm">Nothing in the last 24 hours.</span>
        )}
      </div>
      {data.spikeIps.length ? (
        <div className="card">
          <div className="ct">Flagged IPs</div>
          <div className="list sm">
            {data.spikeIps.map((s) => (
              <div className="li" key={s.ip}>
                <div className="t">
                  <b className="mono">{s.ip}</b>
                  <small>{s.count} events</small>
                </div>
                <Chip kind="warn">watch</Chip>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="card">
        <div className="ct">Recent events</div>
        <div className="list sm">
          {data.sample.map((r) => (
            <div className="li" key={r.id}>
              <div className="t">
                <b>{r.action}</b>
                <small className="dim">
                  {r.ip || "no ip"} · {fmtDate(r.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </small>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
