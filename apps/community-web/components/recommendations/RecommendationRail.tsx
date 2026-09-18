"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, trackEvent } from "@/lib/api";
import { Avatar, Button, Dialog, Empty, Skeleton, useToast } from "@/components/ui";
import "./recommendations.css";

export type RecoModel = "organizations" | "customers" | "jobs" | "groups" | "events" | "vendors" | "intros";

type Props = {
  model: RecoModel;
  title?: string;
  emptyText?: string;
  limit?: number;
  /** Required for model="vendors" — the RFQ to suggest vendors for. Renders nothing until set. */
  vendorsRfqId?: string;
  onCountChange?: (count: number) => void;
};

type Item = {
  key: string;
  recommendationId: string;
  reason: string;
  name: string;
  subtitle: string | null;
  href: string;
  avatarAssetId: string | null;
  square: boolean;
  actionLabel: string;
  actionDone: boolean;
};

const ENDPOINT: Record<RecoModel, string> = {
  organizations: "/recommendations/organizations",
  customers: "/recommendations/customers",
  jobs: "/recommendations/jobs",
  groups: "/recommendations/groups",
  events: "/recommendations/events",
  vendors: "/recommendations/vendors",
  intros: "/recommendations/intros",
};

function normalize(model: RecoModel, body: any): Item[] {
  switch (model) {
    case "organizations":
      return (body.organizations ?? []).map((o: any) => ({
        key: o.id,
        recommendationId: o.recommendationId,
        reason: o.reason,
        name: o.displayName,
        subtitle: [o.industry, o.location].filter(Boolean).join(" · ") || null,
        href: `/companies/${o.slug}`,
        avatarAssetId: o.logoAssetId,
        square: true,
        actionLabel: "Follow",
        actionDone: false,
      }));
    case "customers":
      return (body.customers ?? []).map((c: any) => {
        const isPerson = c.type === "person";
        const obj = isPerson ? c.person : c.organization;
        return {
          key: obj.id,
          recommendationId: c.recommendationId,
          reason: c.reason,
          name: isPerson ? obj.name : obj.displayName,
          subtitle: isPerson ? obj.headline : obj.industry,
          href: isPerson ? `/people/${obj.username}` : `/companies/${obj.slug}`,
          avatarAssetId: isPerson ? obj.avatarAssetId : obj.logoAssetId,
          square: !isPerson,
          actionLabel: isPerson ? "View profile" : "View company",
          actionDone: false,
        };
      });
    case "jobs":
      return (body.jobs ?? []).map((j: any) => ({
        key: j.id,
        recommendationId: j.recommendationId,
        reason: j.reason,
        name: j.title,
        subtitle: [j.organization?.displayName, j.location].filter(Boolean).join(" · ") || null,
        href: `/jobs/${j.id}`,
        avatarAssetId: j.organization?.logoAssetId ?? null,
        square: true,
        actionLabel: "View job",
        actionDone: false,
      }));
    case "intros":
      return (body.people ?? []).map((p: any) => ({
        key: p.id,
        recommendationId: p.recommendationId,
        reason: p.reason,
        name: p.name,
        subtitle: [p.headline, p.primaryOrg?.displayName].filter(Boolean).join(" · ") || null,
        href: `/people/${p.username}`,
        avatarAssetId: p.avatarAssetId,
        square: false,
        actionLabel: "Ask for an intro",
        actionDone: false,
      }));
    case "groups":
      return (body.groups ?? []).map((g: any) => ({
        key: g.id,
        recommendationId: g.recommendationId,
        reason: g.reason,
        name: g.name,
        subtitle: g.category ?? `${g.memberCount ?? 0} members`,
        href: `/groups/${g.slug}`,
        avatarAssetId: g.logoAssetId,
        square: true,
        actionLabel: "Join",
        actionDone: false,
      }));
    case "events":
      return (body.events ?? []).map((e: any) => ({
        key: e.id,
        recommendationId: e.recommendationId,
        reason: e.reason,
        name: e.title,
        subtitle: e.venue ?? e.mode,
        href: `/events/${e.slug}`,
        avatarAssetId: e.coverAssetId,
        square: true,
        actionLabel: "RSVP",
        actionDone: false,
      }));
    case "vendors":
      return (body.vendors ?? []).map((v: any) => ({
        key: v.id,
        recommendationId: v.recommendationId,
        reason: v.reason,
        name: v.displayName,
        subtitle: v.industry,
        href: `/companies/${v.slug}`,
        avatarAssetId: v.logoAssetId,
        square: true,
        actionLabel: "Follow",
        actionDone: false,
      }));
    default:
      return [];
  }
}

/**
 * The one renderer for every recommendation surface (brief: "For you" hub +
 * the feed rail + the RFQ vendor picker all use this). Every item carries
 * the reason it's there, a "Why?" that reads the real evidence, a dismiss
 * that excludes it for 90 days, and a primary action that actually does
 * something against the api (never a placeholder).
 */
export function RecommendationRail({ model, emptyText, limit, vendorsRfqId, onCountChange }: Props) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [explainFor, setExplainFor] = useState<Item | null>(null);
  const [explanation, setExplanation] = useState<{ reason: string; evidence: Record<string, unknown> } | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);

  const load = useCallback(async () => {
    if (model === "vendors" && !vendorsRfqId) {
      setItems([]);
      setLoading(false);
      onCountChange?.(0);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (limit) qs.set("limit", String(limit));
      if (model === "vendors" && vendorsRfqId) qs.set("rfqId", vendorsRfqId);
      const path = `${ENDPOINT[model]}${qs.toString() ? `?${qs}` : ""}`;
      const body = await api<any>(path);
      const normalized = normalize(model, body);
      setItems(normalized);
      onCountChange?.(normalized.length);
      for (let i = 0; i < normalized.length; i++) {
        trackEvent("post_impression", { objectType: model, objectId: normalized[i].key, surface: "recommendations", position: i, recommendationId: normalized[i].recommendationId });
      }
    } catch {
      setItems([]);
      onCountChange?.(0);
    } finally {
      setLoading(false);
    }
  }, [model, limit, vendorsRfqId, onCountChange]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function dismiss(item: Item) {
    setItems((s) => s.filter((x) => x.key !== item.key));
    try {
      await api(`/recommendations/${item.recommendationId}/dismiss`, { method: "POST" });
    } catch {
      /* best-effort; the card is already gone from the viewer's session */
    }
  }

  async function act(item: Item) {
    setBusyKey(item.key);
    try {
      if (model === "organizations" || model === "vendors") {
        await api(`/organizations/${item.key}/follow`, { method: "POST" });
        await api(`/recommendations/${item.recommendationId}/outcome`, { method: "POST", body: { outcome: "converted" } });
        toast("Following.");
        setItems((s) => s.map((x) => (x.key === item.key ? { ...x, actionDone: true } : x)));
      } else if (model === "groups") {
        await api(`/groups/${item.key}/join`, { method: "POST" });
        await api(`/recommendations/${item.recommendationId}/outcome`, { method: "POST", body: { outcome: "converted" } });
        toast("Joined.");
        setItems((s) => s.map((x) => (x.key === item.key ? { ...x, actionDone: true } : x)));
      } else if (model === "events") {
        await api(`/events/${item.key}/rsvp`, { method: "POST", body: { status: "GOING" } });
        await api(`/recommendations/${item.recommendationId}/outcome`, { method: "POST", body: { outcome: "converted" } });
        toast("You're going.");
        setItems((s) => s.map((x) => (x.key === item.key ? { ...x, actionDone: true } : x)));
      } else {
        await api(`/recommendations/${item.recommendationId}/outcome`, { method: "POST", body: { outcome: "clicked" } });
        window.location.href = item.href;
      }
    } catch (e: any) {
      toast(e?.message ?? "Couldn't do that.", { kind: "err" });
    } finally {
      setBusyKey(null);
    }
  }

  async function explain(item: Item) {
    setExplainFor(item);
    setExplainLoading(true);
    setExplanation(null);
    try {
      const r = await api<{ reason: string; evidence: Record<string, unknown> }>(`/recommendations/explain/${item.recommendationId}`);
      setExplanation(r);
    } catch {
      setExplanation({ reason: item.reason, evidence: {} });
    } finally {
      setExplainLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="reco-rail" data-testid={`reco-${model}-loading`}>
        <Skeleton h={64} />
        <Skeleton h={64} />
      </div>
    );
  }
  if (!items.length) {
    return emptyText ? <Empty title={emptyText} /> : null;
  }

  return (
    <>
      <div className="list reco-rail" data-testid={`reco-${model}-list`}>
        {items.map((it) => (
          <div className="li reco-item" key={it.key}>
            <button type="button" className="ib reco-dismiss" aria-label={`Dismiss ${it.name}`} onClick={() => dismiss(it)} data-testid={`reco-${model}-dismiss-${it.key}`}>
              ×
            </button>
            <Link href={it.href}>
              <Avatar name={it.name} assetId={it.avatarAssetId} size={44} square={it.square} />
            </Link>
            <div className="t">
              <Link href={it.href}>
                <b>{it.name}</b>
              </Link>
              {it.subtitle ? <small>{it.subtitle}</small> : null}
              <button type="button" className="reco-why" onClick={() => explain(it)} data-testid={`reco-${model}-why-${it.key}`}>
                {it.reason} · Why?
              </button>
            </div>
            <Button small loading={busyKey === it.key} onClick={() => act(it)} data-testid={`reco-${model}-action-${it.key}`}>
              {it.actionDone ? "Done" : it.actionLabel}
            </Button>
          </div>
        ))}
      </div>
      <Dialog open={!!explainFor} onClose={() => setExplainFor(null)} title={`Why "${explainFor?.name ?? ""}"?`}>
        {explainLoading ? (
          <Skeleton h={60} />
        ) : (
          <div className="reco-evidence">
            <p>{explanation?.reason}</p>
            <ul>
              {Object.entries(explanation?.evidence ?? {}).map(([k, v]) => (
                <li key={k}>
                  <b>{k}:</b> {Array.isArray(v) ? v.join(", ") || "—" : String(v)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );
}
