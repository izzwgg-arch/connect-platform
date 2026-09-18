"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Icon } from "@/components/ui";
import { api, ApiError, mediaUrl, newIdempotencyKey, trackEvent } from "@/lib/api";
import { Avatar, Button, Chip, Empty, Skeleton, VChip, fmtDate, fmtMoney } from "@/components/ui";
import "@/components/company/company.css";

type CompanyPublic = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string | null;
  logoAssetId: string | null;
  coverAssetId: string | null;
  description: string | null;
  industry: string | null;
  size: string | null;
  website: string | null;
  serviceArea: string[];
  hours: Partial<Record<string, [string, string] | "closed">> | null;
  acceptsRfqs: boolean;
  followerCount: number;
  loopcomLinked: boolean;
  contact: { phone: string | null; email: string | null; whatsapp: string | null };
  locations: Array<{ id: string; label: string; address1: string | null; city: string | null; region: string | null; postalCode: string | null; country: string; phone: string | null; isHeadquarters: boolean }>;
  catalog: Array<{ id: string; name: string; description: string | null; priceNote: string | null; assetId: string | null }>;
  verifications: Array<{ id: string; kind: string; note: string | null; expiresAt: string | null; since: string }>;
  people: Array<{ id: string; name: string; username: string; headline: string | null; avatarAssetId: string | null; verified: string[]; role: string; title: string | null }>;
  openJobsCount: number;
  openJobs: Array<{ id: string; title: string; location: string | null; employmentType: string }>;
  inYourNetwork: { count: number; people: Array<{ id: string; name: string; username: string }> };
  viewer: { following: boolean; membership: { role: string; permissions: string[]; affiliation: string } | null; canRequestQuote: boolean; canMessage: boolean; canCall: boolean };
};

const DAY_LABEL: Record<string, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const KIND_LABEL: Record<string, string> = { BUSINESS: "Business verified", DOMAIN: "Domain verified", INSURANCE: "Insurance on file", LICENSE: "License verified", LOOPCOM_CUSTOMER: "Loopcom customer" };

function hoursToday(hours: CompanyPublic["hours"]): string | null {
  if (!hours) return null;
  const key = DAYS[new Date().getDay()];
  const v = hours[key];
  if (!v) return null;
  return v === "closed" ? "Closed today" : `Open today ${v[0]}–${v[1]}`;
}

/** Fetches a tab's own domain endpoint; renders Empty instead of a dead tab if it isn't built yet. */
function LazyTab({ url, empty }: { url: string; empty: string }) {
  const [state, setState] = useState<"loading" | "ok" | "empty">("loading");
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api<any>(url)
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r) ? r : (r.items ?? r.posts ?? r.events ?? r.services ?? []);
        if (!list.length) setState("empty");
        else {
          setItems(list);
          setState("ok");
        }
      })
      .catch(() => !cancelled && setState("empty"));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (state === "loading") return <Skeleton h={80} />;
  if (state === "empty") return <Empty title={empty} />;
  return (
    <div className="list">
      {items.map((it, i) => (
        <div className="li" key={it.id ?? i}>
          <div className="t">
            <b>{it.title ?? it.name ?? "Item"}</b>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CompanyPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const [org, setOrg] = useState<CompanyPublic | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<"about" | "posts" | "services" | "catalog" | "jobs" | "people" | "trust" | "events">("about");
  const [followBusy, setFollowBusy] = useState(false);

  const load = useCallback(() => {
    api<CompanyPublic>(`/public/companies/${slug}`)
      .then(setOrg)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
      });
  }, [slug]);

  useEffect(() => {
    setOrg(null);
    setNotFound(false);
    load();
  }, [load]);

  const hq = useMemo(() => org?.locations.find((l) => l.isHeadquarters) ?? org?.locations[0] ?? null, [org]);
  const today = useMemo(() => hoursToday(org?.hours ?? null), [org]);

  async function toggleFollow() {
    if (!org) return;
    if (!me) {
      router.push(`/login?next=${encodeURIComponent(`/companies/${slug}`)}`);
      return;
    }
    setFollowBusy(true);
    try {
      if (org.viewer.following) {
        await api(`/organizations/${org.id}/follow`, { method: "DELETE" });
        setOrg({ ...org, followerCount: Math.max(0, org.followerCount - 1), viewer: { ...org.viewer, following: false } });
      } else {
        await api(`/organizations/${org.id}/follow`, { method: "POST", idempotencyKey: newIdempotencyKey() });
        setOrg({ ...org, followerCount: org.followerCount + 1, viewer: { ...org.viewer, following: true } });
        trackEvent("company_follow", { objectType: "Organization", objectId: org.id });
      }
    } catch (err) {
      // surfaced by the toast-less inline state — button just reverts.
    } finally {
      setFollowBusy(false);
    }
  }

  async function startMessage() {
    if (!org) return;
    const target = org.people[0];
    if (!target) return;
    if (!me) {
      router.push(`/login?next=${encodeURIComponent(`/companies/${slug}`)}`);
      return;
    }
    try {
      const thread = await api<{ id: string }>("/threads", { method: "POST", body: { personIds: [target.id] }, idempotencyKey: newIdempotencyKey() });
      router.push(`/messages/${thread.id}`);
    } catch {
      router.push("/messages");
    }
  }

  const content = (
    <div className="col">
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="cover">{org?.coverAssetId ? <img src={mediaUrl(org.coverAssetId, "medium") ?? undefined} alt="" /> : null}</div>
        <div style={{ padding: "0 20px 14px", display: "grid", gap: 12 }}>
          <div className="row" style={{ alignItems: "flex-end", marginTop: -34 }}>
            <Avatar name={org?.displayName ?? "…"} assetId={org?.logoAssetId} size={84} square />
            <span style={{ flex: 1 }} />
            {org ? (
              <div className="row">
                <Button kind={org.viewer.following ? "" : "p"} icon="plus" onClick={toggleFollow} loading={followBusy} data-testid="company-follow">
                  {org.viewer.following ? "Following" : "Follow"}
                </Button>
                {org.viewer.canRequestQuote ? (
                  <Button icon="quote" href={`/rfq/new?vendor=${org.id}`} data-testid="company-request-quote">
                    Request quote
                  </Button>
                ) : null}
                {org.viewer.canCall && org.contact.phone ? (
                  <Button icon="phone" href={`tel:${org.contact.phone}`} data-testid="company-call">
                    Call
                  </Button>
                ) : null}
                {org.contact.whatsapp ? (
                  <Button icon="wa" href={`https://wa.me/${org.contact.whatsapp.replace(/[^\d]/g, "")}`} data-testid="company-whatsapp">
                    WhatsApp
                  </Button>
                ) : null}
                {org.viewer.canMessage && org.people[0] ? (
                  <Button icon="msg" onClick={startMessage} data-testid="company-message">
                    Message
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>{org?.displayName ?? <Skeleton h={22} w={240} />}</h1>
            {org ? (
              <p className="dim">
                {[org.description?.split(".")[0], org.industry, org.size ? `${org.size} employees` : null].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            {org ? (
              <div className="row xs dim" style={{ marginTop: 4 }}>
                {hq ? (
                  <span>
                    <Icon name="pin" /> {[hq.address1, hq.city, hq.region, hq.postalCode].filter(Boolean).join(", ")}
                  </span>
                ) : null}
                <span>
                  <Icon name="people" /> {org.followerCount.toLocaleString()} followers
                </span>
                {org.website ? (
                  <a href={org.website} target="_blank" rel="noreferrer">
                    <Icon name="globe" /> {org.website.replace(/^https?:\/\//, "")}
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
          {org ? (
            <div className="pill-row">
              {org.verifications.map((v) => (
                <VChip key={v.id}>{KIND_LABEL[v.kind] ?? v.kind}</VChip>
              ))}
              {org.loopcomLinked ? <Chip kind="ac" icon="link">Loopcom customer</Chip> : null}
            </div>
          ) : null}
          <div className="tabs">
            {(
              [
                ["about", "About"],
                ["posts", "Posts"],
                ["services", "Services"],
                ["catalog", `Catalog${org ? ` (${org.catalog.length})` : ""}`],
                ["jobs", `Jobs${org && org.openJobsCount ? ` (${org.openJobsCount})` : ""}`],
                ["people", `People${org ? ` (${org.people.length})` : ""}`],
                ["trust", "Trust"],
                ["events", "Events"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)} data-testid={`company-tab-${key}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!org ? (
        <div className="card">
          <Skeleton h={120} />
        </div>
      ) : notFound ? null : tab === "about" ? (
        <div className="card">
          <div className="ct">About</div>
          <p>{org.description || "This company hasn't added a description yet."}</p>
        </div>
      ) : tab === "posts" ? (
        <div className="card">
          <div className="ct">Posts</div>
          <LazyTab url={`/organizations/${org.id}/posts`} empty="No posts yet." />
        </div>
      ) : tab === "services" ? (
        <div className="card">
          <div className="ct">Services</div>
          <LazyTab url={`/organizations/${org.id}/services`} empty="No services listed yet." />
        </div>
      ) : tab === "catalog" ? (
        <div className="card">
          <div className="ct">Catalog</div>
          {org.catalog.length === 0 ? (
            <Empty title="No catalog items yet" />
          ) : (
            <div className="grid3">
              {org.catalog.map((c) => (
                <div className="card tight" style={{ background: "var(--bg-soft)" }} key={c.id} data-testid={`company-catalog-${c.id}`}>
                  <div style={{ height: 80, borderRadius: 8, background: "var(--panel-2)", marginBottom: 8, overflow: "hidden" }}>{c.assetId ? <img src={mediaUrl(c.assetId, "medium") ?? undefined} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</div>
                  <b className="sm">{c.name}</b>
                  {c.priceNote ? <small className="dim" style={{ display: "block" }}>{c.priceNote}</small> : null}
                  {org.viewer.canRequestQuote ? (
                    <div style={{ marginTop: 8 }}>
                      <Button small href={`/rfq/new?vendor=${org.id}&item=${c.id}`}>
                        Request quote
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : tab === "jobs" ? (
        <div className="card">
          <div className="ct">Open jobs</div>
          {org.openJobs.length === 0 ? (
            <Empty title="No open jobs right now" />
          ) : (
            <div className="list sm">
              {org.openJobs.map((j) => (
                <div className="li" key={j.id}>
                  <div className="t">
                    <b>{j.title}</b>
                    <small>{[j.location, j.employmentType.replace("_", " ").toLowerCase()].filter(Boolean).join(" · ")}</small>
                  </div>
                  <Button small href={`/jobs/${j.id}`}>
                    View
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : tab === "people" ? (
        <div className="card">
          <div className="ct">People at {org.displayName}</div>
          {org.people.length === 0 ? (
            <Empty title="No verified people listed yet" />
          ) : (
            <div className="list">
              {org.people.map((p) => (
                <Link className="li" href={`/people/${p.username}`} key={p.id}>
                  <Avatar name={p.name} assetId={p.avatarAssetId} size={34} />
                  <div className="t">
                    <b>{p.name}</b>
                    <small>{p.title ?? p.role}</small>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : tab === "trust" ? (
        <div className="card">
          <div className="ct">Trust &amp; verification</div>
          {org.verifications.length === 0 ? (
            <Empty title="No verifications on file yet" />
          ) : (
            <div className="list sm">
              {org.verifications.map((v) => (
                <div className="li" key={v.id}>
                  <Icon name="check" />
                  <div className="t">
                    <b>{KIND_LABEL[v.kind] ?? v.kind}</b>
                    <small>{v.note ?? `Verified ${fmtDate(v.since)}`}{v.expiresAt ? ` · expires ${fmtDate(v.expiresAt)}` : ""}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="ct">Events</div>
          <LazyTab url={`/organizations/${org.id}/events`} empty="No upcoming events." />
        </div>
      )}
    </div>
  );

  const sidebar = org ? (
    <div className="col">
      {org.hours ? (
        <div className="card">
          <div className="ct">Hours</div>
          <dl className="kv">
            {DAYS.map((d) => {
              const v = org.hours![d];
              return (
                <Fragment key={d}>
                  <dt>{DAY_LABEL[d]}</dt>
                  <dd>{!v ? "—" : v === "closed" ? "Closed" : `${v[0]} – ${v[1]}`}</dd>
                </Fragment>
              );
            })}
          </dl>
          {today ? (
            <div className="why" style={{ marginTop: 10 }}>
              <Icon name="clock" />
              <span>{today}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="card">
        <div className="ct">Contact</div>
        <div className="list sm">
          {org.contact.phone ? (
            <div className="li">
              <Icon name="phone" />
              <div className="t">
                <b>{org.contact.phone}</b>
              </div>
            </div>
          ) : null}
          {org.contact.whatsapp ? (
            <div className="li">
              <Icon name="wa" />
              <div className="t">
                <b>WhatsApp Business</b>
                <small>{org.contact.whatsapp}</small>
              </div>
            </div>
          ) : null}
          {org.contact.email ? (
            <div className="li">
              <Icon name="mail" />
              <div className="t">
                <b>{org.contact.email}</b>
              </div>
            </div>
          ) : null}
          {!org.contact.phone && !org.contact.whatsapp && !org.contact.email ? <p className="sm dim">No public contact info yet.</p> : null}
        </div>
      </div>
      {org.people.length ? (
        <div className="card">
          <div className="ct">
            People at {org.displayName} <span className="more">{org.people.length}</span>
          </div>
          <div className="list">
            {org.people.slice(0, 5).map((p) => (
              <div className="li" key={p.id}>
                <Avatar name={p.name} assetId={p.avatarAssetId} size={34} />
                <div className="t">
                  <b>{p.name}</b>
                  <small>{p.title ?? p.role}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {org.inYourNetwork.count > 0 ? (
        <div className="card">
          <div className="ct">In your network</div>
          <p className="sm">
            <Icon name="people" /> <b>{org.inYourNetwork.count} {org.inYourNetwork.count === 1 ? "person" : "people"} you know</b> {org.inYourNetwork.count === 1 ? "is" : "are"} a verified customer{org.inYourNetwork.count === 1 ? "" : "s"}: {org.inYourNetwork.people.map((p) => p.name).join(", ")}.
          </p>
        </div>
      ) : null}
      {org.openJobsCount > 0 ? (
        <div className="card">
          <div className="ct">
            Open jobs <span className="more">{org.openJobsCount}</span>
          </div>
          <div className="list sm">
            {org.openJobs.map((j) => (
              <div className="li" key={j.id}>
                <div className="t">
                  <b>{j.title}</b>
                  <small>{j.location}</small>
                </div>
                <Button small href={`/jobs/${j.id}`}>
                  Apply
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  ) : (
    <div className="col">
      <div className="card">
        <Skeleton h={200} />
      </div>
    </div>
  );

  if (notFound) {
    const body = (
      <div className="col" style={{ gridColumn: "1/-1" }}>
        <Empty title="That company page doesn't exist" text="It may have been removed or the link is wrong." action={<Button href="/">Go home</Button>} />
      </div>
    );
    return me ? (
      <AppShell title="Company not found">{body}</AppShell>
    ) : (
      <div className="content">{body}</div>
    );
  }

  if (me) {
    return (
      <AppShell cols="two" title={org?.displayName ?? "Company"}>
        {content}
        {sidebar}
      </AppShell>
    );
  }

  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span style={{ flex: 1 }} />
        <Link className="btn" href="/login" data-testid="company-public-signin">
          Sign in
        </Link>
        <Link className="btn p" href="/join" data-testid="company-public-join">
          Join free
        </Link>
      </nav>
      <div className="content two">
        {content}
        {sidebar}
      </div>
    </div>
  );
}
