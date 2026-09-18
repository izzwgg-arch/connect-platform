"use client";

import { Fragment, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui";

type Overview = {
  counts: {
    peopleByStatus: Record<string, number>;
    organizations: number;
    openCases: number;
    pendingVerifications: number;
    openRfqs: number;
    openJobs: number;
    upcomingEvents: number;
    groups: number;
    activeListings: number;
    reports24h: number;
    signups7d: number;
  };
  systemHealth: {
    dbMs: number;
    sockets: number;
    apiP50Ms: number;
    apiP95Ms: number;
    sampleSize: number;
    queues: { pendingPush: number; scheduledPosts: number; mailSent24h: number };
  };
  mobileVersions: Array<{ platform: string; appVersion: string }>;
};

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card tight stat" data-testid={`admin-overview-tile-${label.replace(/\s+/g, "-").toLowerCase()}`}>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

export default function AdminOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    api<Overview>("/admin/overview").then(setData);
  }, []);

  if (!data) return <Skeleton h={300} />;
  const c = data.counts;
  const sh = data.systemHealth;

  return (
    <div className="col">
      <h1>Overview</h1>
      <p className="sub">Platform-wide counts, straight from the live tables — nothing here is cached longer than the page load.</p>

      <div className="grid3">
        <Tile label="Open cases" value={c.openCases} />
        <Tile label="Pending verifications" value={c.pendingVerifications} />
        <Tile label="Organizations" value={c.organizations} />
        <Tile label="Signups (7d)" value={c.signups7d} />
        <Tile label="Reports (24h)" value={c.reports24h} />
        <Tile label="Open RFQs" value={c.openRfqs} />
        <Tile label="Open jobs" value={c.openJobs} />
        <Tile label="Upcoming events" value={c.upcomingEvents} />
        <Tile label="Active listings" value={c.activeListings} />
        <Tile label="Groups" value={c.groups} />
      </div>

      <div className="grid2">
        <div className="card">
          <div className="ct">People by status</div>
          <dl className="kv sm">
            {Object.entries(c.peopleByStatus).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd className="mono">{v}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
        <div className="card">
          <div className="ct">System health</div>
          <dl className="kv sm">
            <dt>Database</dt>
            <dd className="mono">{sh.dbMs} ms</dd>
            <dt>API p50 / p95</dt>
            <dd className="mono">
              {sh.apiP50Ms} ms / {sh.apiP95Ms} ms ({sh.sampleSize} samples)
            </dd>
            <dt>Realtime sockets</dt>
            <dd className="mono">{sh.sockets}</dd>
            <dt>Pending push</dt>
            <dd className="mono">{sh.queues.pendingPush}</dd>
            <dt>Scheduled posts</dt>
            <dd className="mono">{sh.queues.scheduledPosts}</dd>
            <dt>Mail sent (24h)</dt>
            <dd className="mono">{sh.queues.mailSent24h}</dd>
          </dl>
        </div>
      </div>

      {data.mobileVersions.length ? (
        <div className="card">
          <div className="ct">Mobile app versions seen (7d)</div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {data.mobileVersions.map((v, i) => (
              <span className="chip" key={i}>
                {v.platform} · {v.appVersion}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
