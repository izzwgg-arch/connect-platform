"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, API_URL, getAccessToken } from "@/lib/api";
import { Chip, Empty, Skeleton } from "@/components/ui";
import { LineChart } from "@/components/analytics/LineChart";

type Analytics = {
  organization: { id: string; displayName: string };
  range: number;
  tiles: { pageViews: number; followers: number; newFollowers: number; postReach: number; rfqsReceived: number; quotesSent: number; quoteWinRate: number; responseTimeHours: number | null };
  deltas: { pageViews: number | null; newFollowers: number | null; rfqsReceived: number | null; quotesSent: number | null; quoteWinRatePts: number };
  series: Array<{ day: string; count: number }>;
  sources: Array<{ surface: string; count: number; pct: number }>;
  topPosts: Array<{ id: string; title: string; impressions: number; reactions: number; comments: number; saves: number }>;
};

const RANGES = [
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "Year" },
] as const;

function deltaLabel(d: number | null): string {
  if (d == null) return "new";
  if (d === 0) return "—";
  return `${d > 0 ? "+" : ""}${d}%`;
}

function Body() {
  const { me } = useAuth();
  const orgs = (me?.memberships ?? []).map((m) => m.organization);
  const [orgId, setOrgId] = useState<string>(orgs[0]?.id ?? "");
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("30");
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    if (!orgId) return;
    setLoading(true);
    setForbidden(false);
    api<Analytics>(`/organizations/${orgId}/analytics?range=${range}`)
      .then(setData)
      .catch((err) => {
        if (err?.status === 403) setForbidden(true);
      })
      .finally(() => setLoading(false));
  }, [orgId, range]);

  useEffect(() => {
    load();
  }, [load]);

  function exportCsv() {
    const token = getAccessToken();
    const url = `${API_URL}/organizations/${orgId}/analytics/export.csv?range=${range}${token ? `&access_token=${encodeURIComponent(token)}` : ""}`;
    window.open(url, "_blank");
  }

  if (!orgs.length) return <Empty title="No company yet" text="Analytics show up once you're part of a company page." />;

  return (
    <div className="col" style={{ gridColumn: "1 / -1" }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row">
          {orgs.length > 1 ? (
            <select className="in" value={orgId} onChange={(e) => setOrgId(e.target.value)} data-testid="analytics-org-select">
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </select>
          ) : (
            <h2 style={{ fontSize: 18 }}>{orgs[0].displayName} · Analytics</h2>
          )}
        </div>
        <div className="row">
          {RANGES.map((r) => (
            <Chip key={r.key} kind={range === r.key ? "sel" : ""} onClick={() => setRange(r.key)} testId={`analytics-range-${r.key}`}>
              {r.label}
            </Chip>
          ))}
          <button className="btn g s" onClick={exportCsv} data-testid="analytics-export">
            Export
          </button>
        </div>
      </div>

      {forbidden ? (
        <Empty title="No access" text="You need the Analytics permission for this company." />
      ) : loading || !data ? (
        <Skeleton h={300} />
      ) : (
        <>
          <div className="grid3">
            <Tile label="Page views" value={data.tiles.pageViews} delta={deltaLabel(data.deltas.pageViews)} />
            <Tile label="New followers" value={data.tiles.newFollowers} delta={deltaLabel(data.deltas.newFollowers)} />
            <Tile label="Post reach" value={data.tiles.postReach} />
            <Tile label="RFQs received" value={data.tiles.rfqsReceived} delta={deltaLabel(data.deltas.rfqsReceived)} />
            <Tile label="Quotes sent" value={data.tiles.quotesSent} delta={deltaLabel(data.deltas.quotesSent)} />
            <Tile label="Quote win rate" value={`${data.tiles.quoteWinRate}%`} delta={data.deltas.quoteWinRatePts ? `${data.deltas.quoteWinRatePts > 0 ? "+" : ""}${data.deltas.quoteWinRatePts} pts` : "—"} />
            <Tile label="Response time" value={data.tiles.responseTimeHours != null ? `~${Math.round(data.tiles.responseTimeHours)}h` : "—"} />
          </div>

          <div className="grid2" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
            <div className="card">
              <div className="ct">Page views · daily</div>
              <LineChart series={data.series} />
            </div>
            <div className="card">
              <div className="ct">Where visitors came from</div>
              {data.sources.length ? (
                data.sources.map((s) => (
                  <div key={s.surface} style={{ marginBottom: 8 }}>
                    <div className="row sm" style={{ justifyContent: "space-between" }}>
                      <span>{s.surface}</span>
                      <b className="mono">{s.pct}%</b>
                    </div>
                    <div className="prog">
                      <i style={{ width: `${s.pct}%` }} />
                    </div>
                  </div>
                ))
              ) : (
                <p className="sm dim">No visits yet this period.</p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="ct">Top posts</div>
            {data.topPosts.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Post</th>
                    <th className="num">Impressions</th>
                    <th className="num">Reactions</th>
                    <th className="num">Comments</th>
                    <th className="num">Saves</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topPosts.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <b>{p.title}</b>
                      </td>
                      <td className="num mono">{p.impressions}</td>
                      <td className="num mono">{p.reactions}</td>
                      <td className="num mono">{p.comments}</td>
                      <td className="num mono">{p.saves}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="sm dim">No posts yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, delta }: { label: string; value: number | string; delta?: string }) {
  return (
    <div className="card tight stat">
      <small>{label}</small>
      <b>{value}</b>
      {delta ? <span className={`d ${delta.startsWith("-") ? "n" : ""}`}>{delta}</span> : null}
    </div>
  );
}

export default function CompanyAnalyticsPage() {
  return (
    <RequireAuth>
      <AppShell title="Analytics">
        <Body />
      </AppShell>
    </RequireAuth>
  );
}
