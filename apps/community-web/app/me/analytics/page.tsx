"use client";

import { useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui";
import { LineChart } from "@/components/analytics/LineChart";

type MeAnalytics = { profileViews: { total: number; series: Array<{ day: string; count: number }> }; searchAppearances: number; postImpressions: number };

function Body() {
  const [data, setData] = useState<MeAnalytics | null>(null);

  useEffect(() => {
    api<MeAnalytics>("/me/analytics").then(setData);
  }, []);

  if (!data) return <Skeleton h={250} />;

  return (
    <div className="col" style={{ gridColumn: "1 / -1" }}>
      <div className="grid3">
        <div className="card tight stat">
          <small>Profile views (30d)</small>
          <b>{data.profileViews.total}</b>
        </div>
        <div className="card tight stat">
          <small>Search appearances (30d)</small>
          <b>{data.searchAppearances}</b>
        </div>
        <div className="card tight stat">
          <small>Post impressions (all time)</small>
          <b>{data.postImpressions}</b>
        </div>
      </div>
      <div className="card">
        <div className="ct">Profile views · daily</div>
        <LineChart series={data.profileViews.series} />
      </div>
    </div>
  );
}

export default function MyAnalyticsPage() {
  return (
    <RequireAuth>
      <AppShell title="Your analytics">
        <Body />
      </AppShell>
    </RequireAuth>
  );
}
