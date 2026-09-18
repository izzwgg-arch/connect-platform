"use client";

import { useMemo, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { RecommendationRail, type RecoModel } from "@/components/recommendations/RecommendationRail";
import "@/components/recommendations/recommendations.css";

const SECTIONS: Array<{ model: RecoModel; title: string }> = [
  { model: "organizations", title: "Businesses you may need" },
  { model: "customers", title: "Customers you may want" },
  { model: "jobs", title: "Jobs you may like" },
  { model: "groups", title: "Groups for you" },
  { model: "events", title: "Events for you" },
  { model: "intros", title: "Introductions worth asking for" },
];

export default function RecommendationsPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const [counts, setCounts] = useState<Partial<Record<RecoModel, number>>>({});
  const allLoadedAndEmpty = useMemo(
    () => SECTIONS.every((s) => counts[s.model] === 0),
    [counts],
  );

  return (
    <AppShell title="For you">
      <div data-testid="recommendations-page">
        {SECTIONS.map((s) => (
          <div
            className="card reco-section"
            key={s.model}
            style={counts[s.model] === 0 ? { display: "none" } : undefined}
            data-testid={`recommendations-section-${s.model}`}
          >
            <div className="ct">{s.title}</div>
            <RecommendationRail model={s.model} onCountChange={(n) => setCounts((c) => ({ ...c, [s.model]: n }))} />
          </div>
        ))}
        {allLoadedAndEmpty ? (
          <div className="card" data-testid="recommendations-empty">
            <p className="dim">
              Nothing to recommend yet — connect with a few people, follow some companies, and fill in your industry and objectives on your profile, and this page fills in.
            </p>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
