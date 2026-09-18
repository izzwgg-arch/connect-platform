"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, mediaUrl, trackEvent } from "@/lib/api";
import { Avatar, Button, Chip, Empty, Icon, Skeleton, fmtDate, fmtMoney, timeAgo, useToast } from "@/components/ui";
import { FollowButton } from "@/components/graph/FollowButton";
import { SearchBox } from "@/components/search/SearchBox";
import "@/components/search/search.css";

type SearchType = "people" | "organizations" | "posts" | "jobs" | "listings" | "groups" | "events" | "rfqs" | "opportunities";
type TabType = "all" | SearchType;

const TABS: Array<{ key: TabType; label: string }> = [
  { key: "all", label: "All" },
  { key: "organizations", label: "Businesses" },
  { key: "people", label: "People" },
  { key: "posts", label: "Posts" },
  { key: "jobs", label: "Jobs" },
  { key: "listings", label: "Services" },
  { key: "groups", label: "Groups" },
  { key: "events", label: "Events" },
  { key: "rfqs", label: "RFQs" },
  { key: "opportunities", label: "Opportunities" },
];

const LOCATIONS = ["Brooklyn", "Boro Park", "Monsey", "Monroe", "Lakewood"];
const VERIFICATIONS: Array<{ key: string; label: string }> = [
  { key: "BUSINESS", label: "Business verified" },
  { key: "INSURANCE", label: "Insurance on file" },
  { key: "LICENSE", label: "License verified" },
];
const SIZES = ["1–10", "11–50", "51–200", "200+"];
const LANGUAGES = ["English", "Yiddish", "Hebrew", "Spanish"];

type Hit = { type: SearchType; id: string; rank: number; why: string; item: any };
type Interpretation = { service: string; customerType: string | null; location: string | null; distanceMiles: number | null; typeHint: string | null; explain: string };
type Counts = Record<SearchType, number>;
type SavedSearchRow = { id: string; query: string; filters: any; alerts: boolean; lastRunAt: string | null; createdAt: string };
type RecentRow = { id: string; query: string; createdAt: string };

function useFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const type = (params.get("type") as TabType) || "all";
  const distance = params.get("distance") || "";
  const location = params.get("location") || "";
  const verified = (params.get("verified") || "").split(",").filter(Boolean);
  const size = params.get("size") || "";
  const language = params.get("language") || "";

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (!v) next.delete(k);
        else next.set(k, v);
      }
      router.replace(`/search?${next.toString()}`);
    },
    [params, router],
  );

  return { q, type, distance, location, verified, size, language, set };
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchPageInner />
    </Suspense>
  );
}

function SearchPageInner() {
  const { me } = useAuth();
  const body = <SearchBody />;
  if (me) {
    return (
      <AppShell title="Search" cols="">
        <div className="search-layout">{body}</div>
      </AppShell>
    );
  }
  return (
    <div className="search-public">
      <header className="search-public-top">
        <Link href="/" className="logo-mark">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <Link href="/login" className="btn s">
          Sign in
        </Link>
      </header>
      <div className="content narrow">
        <div className="search-layout">{body}</div>
      </div>
    </div>
  );
}

function SearchBody() {
  const { me } = useAuth();
  const toast = useToast();
  const f = useFilters();
  const [interpretation, setInterpretation] = useState<Interpretation | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [results, setResults] = useState<Hit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saved, setSaved] = useState<SavedSearchRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (f.q) p.set("q", f.q);
    p.set("type", f.type);
    if (f.distance) p.set("distance", f.distance);
    if (f.location) p.set("location", f.location);
    if (f.verified.length) p.set("verified", f.verified.join(","));
    if (f.size) p.set("size", f.size);
    if (f.language) p.set("language", f.language);
    return p.toString();
  }, [f.q, f.type, f.distance, f.location, f.verified, f.size, f.language]);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const r = await api<{ interpretation: Interpretation; counts: Counts; results: Hit[]; nextCursor: string | null }>(`/search?${queryString}`);
      if (id !== reqId.current) return;
      setInterpretation(r.interpretation);
      setCounts(r.counts);
      setResults(r.results);
      setCursor(r.nextCursor);
    } catch (e: any) {
      toast(e?.message ?? "Search failed.", { kind: "err" });
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [queryString, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSavedAndRecent = useCallback(async () => {
    if (!me) return;
    try {
      const [s, r] = await Promise.all([api<{ items: SavedSearchRow[] }>("/search/saved"), api<{ items: RecentRow[] }>("/search/recent")]);
      setSaved(s.items);
      setRecent(r.items);
    } catch {
      /* best-effort sidebar */
    }
  }, [me]);

  useEffect(() => {
    void loadSavedAndRecent();
  }, [loadSavedAndRecent, f.q]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ results: Hit[]; nextCursor: string | null }>(`/search?${queryString}&cursor=${encodeURIComponent(cursor)}`);
      setResults((cur) => [...cur, ...r.results]);
      setCursor(r.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loadingMore, queryString]);

  function submitQuery(q: string) {
    f.set({ q });
  }

  function toggleVerified(key: string) {
    const has = f.verified.includes(key);
    const next = has ? f.verified.filter((k) => k !== key) : [...f.verified, key];
    f.set({ verified: next.join(",") || null });
  }

  async function saveThisSearch() {
    if (!f.q.trim()) {
      toast("Type something to search first.", { kind: "err" });
      return;
    }
    try {
      await api("/search/saved", { method: "POST", body: { query: f.q, filters: { type: f.type, distance: f.distance, location: f.location, verified: f.verified, size: f.size, language: f.language } } });
      toast("Search saved.");
      void loadSavedAndRecent();
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that search.", { kind: "err" });
    }
  }

  async function toggleAlerts(row: SavedSearchRow) {
    try {
      await api(`/search/saved/${row.id}`, { method: "PATCH", body: { alerts: !row.alerts } });
      setSaved((s) => s.map((x) => (x.id === row.id ? { ...x, alerts: !x.alerts } : x)));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't update alerts.", { kind: "err" });
    }
  }

  async function deleteSaved(id: string) {
    try {
      await api(`/search/saved/${id}`, { method: "DELETE" });
      setSaved((s) => s.filter((x) => x.id !== id));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't remove that.", { kind: "err" });
    }
  }

  async function clearRecent() {
    try {
      await api("/search/recent", { method: "DELETE" });
      setRecent([]);
    } catch {
      /* non-critical */
    }
  }

  function click(hit: Hit, position: number) {
    trackEvent("search_result_click", { objectType: hit.type, objectId: hit.id, position });
    void api("/search/click", { method: "POST", body: { type: hit.type, id: hit.id, position, q: f.q } }).catch(() => undefined);
  }

  return (
    <>
      <div className="col search-facets">
        <div className="card">
          <span className="lbl">Filters</span>
          <FacetGroup title="Type">
            {TABS.filter((t) => t.key !== "all").map((t) => (
              <Chip key={t.key} kind={f.type === t.key ? "sel" : ""} onClick={() => f.set({ type: t.key === f.type ? "all" : t.key })} testId={`search-facet-type-${t.key}`}>
                {t.label}
              </Chip>
            ))}
          </FacetGroup>
          {me ? (
            <FacetGroup title="Distance">
              {[
                ["network", "In my network"],
                ["second", "2nd degree"],
                ["anyone", "Anyone"],
              ].map(([key, label]) => (
                <Chip key={key} kind={f.distance === key ? "sel" : ""} onClick={() => f.set({ distance: f.distance === key ? null : key })} testId={`search-facet-distance-${key}`}>
                  {label}
                </Chip>
              ))}
            </FacetGroup>
          ) : null}
          <FacetGroup title="Location">
            {LOCATIONS.map((loc) => (
              <Chip key={loc} kind={f.location === loc ? "sel" : ""} onClick={() => f.set({ location: f.location === loc ? null : loc })} testId={`search-facet-location-${loc}`}>
                {loc}
              </Chip>
            ))}
          </FacetGroup>
          <FacetGroup title="Verification">
            {VERIFICATIONS.map((v) => (
              <Chip key={v.key} kind={f.verified.includes(v.key) ? "sel" : ""} onClick={() => toggleVerified(v.key)} testId={`search-facet-verified-${v.key}`}>
                {v.label}
              </Chip>
            ))}
          </FacetGroup>
          <FacetGroup title="Company size">
            {SIZES.map((s) => (
              <Chip key={s} kind={f.size === s ? "sel" : ""} onClick={() => f.set({ size: f.size === s ? null : s })} testId={`search-facet-size-${s}`}>
                {s}
              </Chip>
            ))}
          </FacetGroup>
          <FacetGroup title="Languages">
            {LANGUAGES.map((l) => (
              <Chip key={l} kind={f.language === l ? "sel" : ""} onClick={() => f.set({ language: f.language === l ? null : l })} testId={`search-facet-language-${l}`}>
                {l}
              </Chip>
            ))}
          </FacetGroup>
          {me ? (
            <Button wide small icon="save" onClick={() => void saveThisSearch()} className="search-save-btn" data-testid="search-save">
              Save this search
            </Button>
          ) : null}
        </div>
        {me ? (
          <div className="card">
            <div className="ct">Saved &amp; recent</div>
            {saved.length === 0 && recent.length === 0 ? (
              <Empty title="Nothing yet" text="Searches you save or run will show up here." />
            ) : (
              <div className="list sm" data-testid="search-saved-recent">
                {saved.map((s) => (
                  <div className="li" key={s.id}>
                    <Icon name="save" />
                    <button type="button" className="t search-recent-item" onClick={() => f.set({ q: s.query })} data-testid={`search-saved-open-${s.id}`}>
                      <b>{s.query}</b>
                      <small>{s.alerts ? "Alerts on" : "Alerts off"}</small>
                    </button>
                    <button type="button" className="ib" aria-label={s.alerts ? "Turn off alerts" : "Turn on alerts"} onClick={() => void toggleAlerts(s)} data-testid={`search-saved-alerts-${s.id}`}>
                      <Icon name="bell" />
                    </button>
                    <button type="button" className="ib" aria-label="Delete saved search" onClick={() => void deleteSaved(s.id)} data-testid={`search-saved-delete-${s.id}`}>
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
                {recent.map((r) => (
                  <div className="li" key={r.id}>
                    <Icon name="clock" />
                    <button type="button" className="t search-recent-item" onClick={() => f.set({ q: r.query })} data-testid={`search-recent-open-${r.id}`}>
                      <b>{r.query}</b>
                    </button>
                  </div>
                ))}
                {recent.length > 0 ? (
                  <Button small kind="g" onClick={() => void clearRecent()} data-testid="search-recent-clear">
                    Clear recent
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="col search-results">
        <div className="card hair">
          <SearchBox defaultValue={f.q} onSubmit={submitQuery} testId="search-main" placeholder="Search people, businesses, jobs, RFQs…" />
          {f.q.trim().split(/\s+/).length >= 3 && interpretation ? (
            <p className="sm dim search-interpretation" data-testid="search-interpretation">
              Understood as: {interpretation.explain}
              {interpretation.distanceMiles ? ` · within ${interpretation.distanceMiles} mi` : ""}
            </p>
          ) : null}
        </div>

        <div className="tabs" data-testid="search-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={f.type === t.key ? "on" : ""} onClick={() => f.set({ type: t.key === "all" ? null : t.key })} data-testid={`search-tab-${t.key}`}>
              {t.label} {counts ? <span className="n">{t.key === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[t.key as SearchType]}</span> : null}
            </button>
          ))}
        </div>

        {loading && results.length === 0 ? (
          <>
            <Skeleton h={90} />
            <Skeleton h={90} />
            <Skeleton h={90} />
          </>
        ) : results.length === 0 ? (
          <Empty title="No results" text={f.q ? "Try fewer words, or search a specific type from the tabs above." : "Type something to search people, businesses, jobs and more."} action={<Button small onClick={() => f.set({ type: null, distance: null, location: null, verified: null, size: null, language: null })}>Clear filters</Button>} />
        ) : (
          <div className="list" data-testid="search-results">
            {results.map((hit, i) => (
              <ResultCard key={`${hit.type}:${hit.id}`} hit={hit} onOpen={() => click(hit, i)} />
            ))}
          </div>
        )}
        <div ref={sentinelRef} />
        {loadingMore ? <Skeleton h={60} /> : null}
      </div>
    </>
  );
}

function FacetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="search-facet-group">
      <b className="sm">{title}</b>
      <div className="pill-row">{children}</div>
    </div>
  );
}

function ResultCard({ hit, onOpen }: { hit: Hit; onOpen: () => void }) {
  switch (hit.type) {
    case "people":
      return <PersonResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "organizations":
      return <OrgResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "posts":
      return <PostResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "jobs":
      return <JobResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "listings":
      return <ListingResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "groups":
      return <GroupResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "events":
      return <EventResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "rfqs":
      return <RfqResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    case "opportunities":
      return <OpportunityResult item={hit.item} why={hit.why} onOpen={onOpen} />;
    default:
      return null;
  }
}

function PersonResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-people-${item.id}`}>
      <div className="li">
        <Link href={`/people/${item.username}`} onClick={onOpen}>
          <Avatar name={item.name} assetId={item.avatarAssetId} size={48} />
        </Link>
        <div className="t">
          <Link href={`/people/${item.username}`} onClick={onOpen}>
            <b style={{ fontSize: 15 }}>{item.name}</b>
          </Link>
          <small>{[item.headline, item.primaryOrg?.displayName, item.location].filter(Boolean).join(" · ")}</small>
          {item.verified?.length ? (
            <div className="pill-row" style={{ margin: "6px 0" }}>
              {item.verified.map((v: string) => (
                <Chip key={v} kind="ok" icon="check">
                  {v}
                </Chip>
              ))}
            </div>
          ) : null}
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
      </div>
    </div>
  );
}

function OrgResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-organizations-${item.id}`}>
      <div className="li">
        <Link href={`/companies/${item.slug}`} onClick={onOpen}>
          <Avatar name={item.displayName} assetId={item.logoAssetId} size={48} square />
        </Link>
        <div className="t">
          <Link href={`/companies/${item.slug}`} onClick={onOpen}>
            <b style={{ fontSize: 15 }}>{item.displayName}</b>
          </Link>
          <small>{[item.location, item.industry, item.size].filter(Boolean).join(" · ")}</small>
          {item.verified?.length ? (
            <div className="pill-row" style={{ margin: "6px 0" }}>
              {item.verified.map((v: string) => (
                <Chip key={v} kind="ok" icon="check">
                  {v}
                </Chip>
              ))}
            </div>
          ) : null}
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <div className="search-result-actions">
          <Button kind="p" small href={`/rfq/new?vendor=${item.id}`} data-testid={`search-result-quote-${item.id}`}>
            Request quote
          </Button>
          <FollowButton targetId={item.id} kind="organization" following={false} testId={`search-follow-${item.id}`} />
        </div>
      </div>
    </div>
  );
}

function PostResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-posts-${item.id}`}>
      <div className="li">
        <Avatar name={item.author?.name ?? "Deleted member"} assetId={item.author?.avatarAssetId} size={40} />
        <div className="t">
          <b>{item.author?.name ?? "Deleted member"}</b>
          <small>{timeAgo(item.createdAt)}</small>
          <p className="sm" style={{ margin: "6px 0" }}>
            {(item.body ?? "").slice(0, 220)}
            {item.body && item.body.length > 220 ? "…" : ""}
          </p>
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <Link href={`/posts/${item.id}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View post
        </Link>
      </div>
    </div>
  );
}

function JobResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  const salary = item.salaryMin || item.salaryMax ? `${fmtMoney(item.salaryMin)}${item.salaryMax ? `–${fmtMoney(item.salaryMax)}` : ""}` : null;
  return (
    <div className="card" data-testid={`search-result-jobs-${item.id}`}>
      <div className="li">
        <Avatar name={item.orgName ?? "Company"} assetId={item.orgLogoAssetId} size={44} square />
        <div className="t">
          <b style={{ fontSize: 14.5 }}>{item.title}</b>
          <small>{[item.orgName, item.location, item.employmentType, salary].filter(Boolean).join(" · ")}</small>
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <Link href={`/jobs/${item.id}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View job
        </Link>
      </div>
    </div>
  );
}

function ListingResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  const price = item.priceMin || item.priceMax ? `${fmtMoney(item.priceMin)}${item.priceMax ? `–${fmtMoney(item.priceMax)}` : ""}${item.priceUnit ? ` /${item.priceUnit}` : ""}` : "Ask for pricing";
  return (
    <div className="card" data-testid={`search-result-listings-${item.id}`}>
      <div className="li">
        <div className="t">
          <b style={{ fontSize: 14.5 }}>{item.title}</b>
          <small>{[item.sellerName, price].filter(Boolean).join(" · ")}</small>
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <Link href={`/marketplace/${item.id}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View listing
        </Link>
      </div>
    </div>
  );
}

function GroupResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-groups-${item.id}`}>
      <div className="li">
        <Icon name="group" />
        <div className="t">
          <b>{item.name}</b>
          <small>{item.isPrivate ? "Private group" : [item.category, item.memberCount != null ? `${item.memberCount} members` : null].filter(Boolean).join(" · ")}</small>
          {item.description ? <small>{item.description}</small> : null}
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        {item.isPrivate ? <Chip kind="warn">Private</Chip> : null}
        <Link href={`/groups/${item.slug}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View
        </Link>
      </div>
    </div>
  );
}

function EventResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-events-${item.id}`}>
      <div className="li">
        <Icon name="cal" />
        <div className="t">
          <b>{item.title}</b>
          <small>{[fmtDate(item.startsAt), item.venue, item.orgName].filter(Boolean).join(" · ")}</small>
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <Link href={`/events/${item.slug}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View
        </Link>
      </div>
    </div>
  );
}

function RfqResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-rfqs-${item.id}`}>
      <div className="li">
        <Icon name="quote" />
        <div className="t">
          <b>RFQ · {item.title}</b>
          <small>{[item.location, item.deadline ? `closes ${fmtDate(item.deadline)}` : null, `${item.quoteCount} quotes`].filter(Boolean).join(" · ")}</small>
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <Link href={`/rfq/${item.id}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View
        </Link>
      </div>
    </div>
  );
}

function OpportunityResult({ item, why, onOpen }: { item: any; why: string; onOpen: () => void }) {
  return (
    <div className="card" data-testid={`search-result-opportunities-${item.id}`}>
      <div className="li">
        <Icon name="spark" />
        <div className="t">
          <b>{item.typeName ?? "Opportunity"} · {item.title}</b>
          <small>{item.location ?? ""}</small>
          <div className="why">
            <Icon name="spark" />
            {why}
          </div>
        </div>
        <Link href={`/opportunities/${item.id}`} className="btn s" onClick={onOpen} data-testid={`search-result-open-${item.id}`}>
          View
        </Link>
      </div>
    </div>
  );
}
