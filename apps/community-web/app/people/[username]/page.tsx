"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, mediaUrl, newIdempotencyKey, trackEvent } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { AskIntroDialog } from "@/components/intros/AskIntroDialog";
import { NoteEditor } from "@/components/crm/NoteEditor";
import { Avatar, Button, Chip, Empty, Icon, Skeleton, VChip, fmtDate, useToast } from "@/components/ui";
import { ProfileCard, type PersonCardData } from "@/components/profile/ProfileCard";
import "@/components/profile/profile.css";

type SkillRow = { skill: string; count: number; endorsedByMe: boolean };
type LinkRow = { label: string; url: string };
type ExperienceRow = { id: string; companyName: string; title: string; startDate: string; endDate: string | null; isCurrent: boolean; location: string | null; description: string | null };
type EducationRow = { id: string; school: string; degree: string | null; field: string | null; startYear: number | null; endYear: number | null };
type ServiceRow = { id: string; name: string; description: string | null; priceFrom: string | null; priceNote: string | null };
type CertificationRow = { id: string; name: string; issuer: string | null; issuedAt: string | null; expiresAt: string | null };
type PortfolioRow = { id: string; title: string; description: string | null; url: string | null };
type RecommendationRow = { id: string; relationship: string; body: string; acceptedAt: string | null; createdAt: string; status: "accepted" | "pending"; author: PersonCardData | null };

type ConnectionState = "none" | "pending_out" | "pending_in" | "connected";

type PublicProfile = {
  person: { id: string; username: string; name: string; firstName: string; lastName: string };
  profile: {
    avatarAssetId: string | null;
    coverAssetId: string | null;
    industry: string | null;
    serviceArea: string[];
    objectives: string[];
    headline: string | null;
    about: string | null;
    location: string | null;
    languages: string[];
    skills: SkillRow[];
    links: LinkRow[];
    phone: string | null;
    email: string | null;
    experiences: ExperienceRow[];
    educations: EducationRow[];
    services: ServiceRow[];
    certifications: CertificationRow[];
    portfolio: PortfolioRow[];
  };
  verifications: string[];
  primaryOrg: { id: string; slug: string; displayName: string } | null;
  relationship: { degree: number; mutualCount: number; mutualSample: PersonCardData[]; connectionStatus: ConnectionState; following: boolean; canMessage: boolean; canCall: boolean };
  sections: Record<string, boolean>;
  visibility?: Record<string, string>;
};

const VIS_LABEL: Record<string, string> = { PUBLIC: "Public", CONNECTIONS: "Connections", ORGANIZATION: "My company", PRIVATE: "Only me" };

function EyeLabel({ vis }: { vis?: string }) {
  if (!vis) return null;
  return (
    <Link href="/settings/privacy" className="more profile-section-eye">
      <Icon name="eye" />
      {VIS_LABEL[vis] ?? vis}
    </Link>
  );
}

function dateRange(start: string, end: string | null, isCurrent: boolean) {
  const s = fmtDate(start, { month: "short", year: "numeric" });
  const e = isCurrent ? "present" : end ? fmtDate(end, { month: "short", year: "numeric" }) : "";
  return e ? `${s} – ${e}` : s;
}

export default function PublicProfilePage() {
  const params = useParams<{ username: string }>();
  const username = params.username;
  const { me } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [data, setData] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [recs, setRecs] = useState<RecommendationRow[]>([]);
  const [alsoViewed, setAlsoViewed] = useState<PersonCardData[]>([]);
  const [connectBusy, setConnectBusy] = useState(false);
  const [endorseBusy, setEndorseBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMissing(false);
    try {
      const r = await api<PublicProfile>(`/public/people/${username}`, { auth: !!me });
      setData(r);
      trackEvent("profile_view", { objectType: "person", objectId: r.person.id });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else toast((err as Error).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [username, me, toast]);

  useEffect(() => {
    void load();
    // Deliberately not just [username]: on a cold navigation, auth can still be
    // rehydrating tokens from storage when this first fires, so `me` is briefly
    // null and the profile fetch goes out unauthenticated — silently skipping
    // both privacy filtering and the block check (both require a viewer id).
    // Depending on `load` (or on `me` itself) would refetch on every renewed
    // object identity; `me?.person.id` only changes on a real sign-in/out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, me?.person.id]);

  useEffect(() => {
    if (!me || !data) return;
    api<{ items: RecommendationRow[] }>(`/people/${username}/recommendations`).then((r) => setRecs(r.items)).catch(() => setRecs([]));
    api<{ items: PersonCardData[] }>(`/people/${username}/also-viewed`).then((r) => setAlsoViewed(r.items)).catch(() => setAlsoViewed([]));
  }, [me, data, username]);

  if (loading) {
    return (
      <div className="content narrow">
        <Skeleton h={220} />
      </div>
    );
  }
  if (missing || !data) {
    return (
      <div className="content narrow">
        <Empty title="Profile not found" text="That profile doesn't exist, or isn't visible to you." />
      </div>
    );
  }

  const isOwner = me?.person.id === data.person.id;

  async function connect() {
    if (!data) return;
    setConnectBusy(true);
    try {
      await api("/connections/request", { method: "POST", body: { personId: data.person.id }, idempotencyKey: newIdempotencyKey() });
      toast("Connection request sent.");
      trackEvent("connection_request", { objectType: "person", objectId: data.person.id });
      void load();
    } catch (err) {
      const e = err as ApiError;
      toast(e.status === 404 ? "Connections aren't available yet — try again soon." : e.message, { kind: "err" });
    } finally {
      setConnectBusy(false);
    }
  }

  async function toggleEndorse(skill: SkillRow) {
    if (!data) return;
    setEndorseBusy(skill.skill);
    const already = skill.endorsedByMe;
    try {
      if (already) {
        await api(`/people/${data.person.id}/endorse`, { method: "DELETE", body: { skill: skill.skill } });
      } else {
        await api(`/people/${data.person.id}/endorse`, { method: "POST", body: { skill: skill.skill } });
      }
      setData({
        ...data,
        profile: {
          ...data.profile,
          skills: data.profile.skills.map((s) => (s.skill === skill.skill ? { ...s, count: s.count + (already ? -1 : 1), endorsedByMe: !already } : s)),
        },
      });
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setEndorseBusy(null);
    }
  }

  const canEndorse = !isOwner && !!me && data.relationship.connectionStatus === "connected";

  const actions = (
    <div className="row">
      {isOwner ? (
        <Button kind="p" icon="edit" href="/me/profile" data-testid="profile-edit">
          Edit profile
        </Button>
      ) : !me ? (
        <Button kind="p" icon="plus" href={`/login?next=${encodeURIComponent(`/people/${username}`)}`} data-testid="profile-signin-cta">
          Sign in to connect
        </Button>
      ) : (
        <>
          {data.relationship.canMessage ? (
            <Button icon="msg" href={`/messages/new?to=${data.person.id}`} data-testid="profile-message">
              Message
            </Button>
          ) : null}
          {data.relationship.canCall && data.profile.phone ? (
            <a className="btn" href={`tel:${data.profile.phone}`} data-testid="profile-call">
              <Icon name="phone" />
              Call
            </a>
          ) : null}
          {data.primaryOrg ? (
            <Button icon="quote" href={`/rfq/new?vendor=${data.primaryOrg.id}`} data-testid="profile-request-quote">
              Request quote
            </Button>
          ) : null}
          {data.relationship.connectionStatus === "none" ? (
            <Button kind="p" icon="plus" onClick={connect} loading={connectBusy} data-testid="profile-connect">
              Connect
            </Button>
          ) : data.relationship.connectionStatus === "pending_out" ? (
            <Button icon="clock" disabled data-testid="profile-connect-pending">
              Requested
            </Button>
          ) : data.relationship.connectionStatus === "pending_in" ? (
            <Button kind="p" icon="people" href="/network" data-testid="profile-connect-respond">
              Respond to request
            </Button>
          ) : null}
        </>
      )}
    </div>
  );

  const body = (
    <>
      <div className="col">
        <div className="card profile-cover-wrap" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cover">{data.profile.coverAssetId ? <img src={mediaUrl(data.profile.coverAssetId, "medium") ?? undefined} alt="" /> : null}</div>
          <div className="profile-head">
            <div className="row profile-avatar-row">
              <Avatar name={data.person.name} assetId={data.profile.avatarAssetId} size={84} />
              <span style={{ flex: 1 }} />
              {actions}
            </div>
            <div className="profile-name">
              <h1>{data.person.name}</h1>
              <p className="dim">{data.profile.headline || (isOwner ? "Add a headline in Edit profile" : "")}</p>
              <div className="row xs dim" style={{ marginTop: 4 }}>
                {data.profile.location ? (
                  <span>
                    <Icon name="pin" /> {data.profile.location}
                    {data.profile.serviceArea.length ? ` · serves ${data.profile.serviceArea.join(", ")}` : ""}
                  </span>
                ) : null}
                {data.relationship.mutualCount > 0 ? (
                  <span>
                    <Icon name="people" /> {data.relationship.mutualCount} mutual connection{data.relationship.mutualCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="pill-row">
              {data.verifications.map((k) => (
                <VChip key={k}>{k.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())} verified</VChip>
              ))}
              {data.primaryOrg ? (
                <Chip kind="ac" icon="link">
                  <Link href={`/companies/${data.primaryOrg.slug}`} style={{ color: "inherit" }}>
                    {data.primaryOrg.displayName}
                  </Link>
                </Chip>
              ) : null}
              {data.profile.languages.length ? <Chip>{data.profile.languages.join(" · ")}</Chip> : null}
            </div>
          </div>
        </div>

        {data.profile.about || isOwner ? (
          <div className="card">
            <div className="ct">
              About <EyeLabel vis={data.visibility?.about} />
            </div>
            <p>{data.profile.about || <span className="dim sm">No about section yet.</span>}</p>
          </div>
        ) : null}

        {data.profile.skills.length ? (
          <div className="card">
            <div className="ct">
              Skills <EyeLabel vis={data.visibility?.skills} />
            </div>
            <div className="pill-row">
              {data.profile.skills.map((s) => (
                <Chip key={s.skill} kind={s.endorsedByMe ? "ok" : ""} className="profile-skill-chip">
                  {s.skill}
                  {s.count > 0 ? <span className="dim">· {s.count}</span> : null}
                  {canEndorse ? (
                    <button
                      type="button"
                      className="ib"
                      style={{ width: 20, height: 20 }}
                      aria-label={s.endorsedByMe ? `Remove endorsement for ${s.skill}` : `Endorse ${s.skill}`}
                      onClick={() => void toggleEndorse(s)}
                      disabled={endorseBusy === s.skill}
                      data-testid={`profile-endorse-${s.skill}`}
                    >
                      <Icon name={s.endorsedByMe ? "check" : "plus"} />
                    </button>
                  ) : null}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}

        {data.profile.services.length || isOwner ? (
          <div className="card">
            <div className="ct">
              Services{" "}
              {isOwner ? (
                <Link href="/me/profile" className="more" data-testid="profile-edit-services">
                  Edit
                </Link>
              ) : (
                <EyeLabel vis={data.visibility?.services} />
              )}
            </div>
            {data.profile.services.length ? (
              <div className="grid3">
                {data.profile.services.map((s) => (
                  <div key={s.id} className="card tight" style={{ background: "var(--bg-soft)" }}>
                    <b>{s.name}</b>
                    <small className="dim" style={{ display: "block" }}>
                      {s.priceFrom ? `From $${s.priceFrom}` : ""}
                      {s.priceNote ? ` · ${s.priceNote}` : ""}
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sm dim">No services listed yet.</p>
            )}
          </div>
        ) : null}

        {data.profile.experiences.length || isOwner ? (
          <div className="card">
            <div className="ct">
              Experience{" "}
              {isOwner ? (
                <Link href="/me/profile" className="more" data-testid="profile-edit-experience">
                  Edit
                </Link>
              ) : (
                <EyeLabel vis={data.visibility?.experience} />
              )}
            </div>
            {data.profile.experiences.length ? (
              <div className="list">
                {data.profile.experiences.map((e) => (
                  <div className="li" key={e.id}>
                    <Avatar name={e.companyName} size={40} square />
                    <div className="t">
                      <b>
                        {e.title} · {e.companyName}
                      </b>
                      <small>
                        {dateRange(e.startDate, e.endDate, e.isCurrent)}
                        {e.location ? ` · ${e.location}` : ""}
                      </small>
                      {e.description ? <p className="sm" style={{ marginTop: 4 }}>{e.description}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sm dim">No experience listed yet.</p>
            )}
          </div>
        ) : null}

        {data.profile.certifications.length ? (
          <div className="card">
            <div className="ct">
              Certifications <EyeLabel vis={data.visibility?.certifications} />
            </div>
            <div className="list sm">
              {data.profile.certifications.map((c) => (
                <div className="li" key={c.id}>
                  <Icon name="star" />
                  <div className="t">
                    <b>{c.name}</b>
                    <small>
                      {c.issuer}
                      {c.issuedAt ? ` · issued ${fmtDate(c.issuedAt)}` : ""}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data.profile.portfolio.length ? (
          <div className="card">
            <div className="ct">
              Portfolio <EyeLabel vis={data.visibility?.portfolio} />
            </div>
            <div className="grid3">
              {data.profile.portfolio.map((p) => (
                <div key={p.id} className="card tight" style={{ background: "var(--bg-soft)" }}>
                  <b className="sm">{p.title}</b>
                  {p.description ? <small className="dim" style={{ display: "block" }}>{p.description}</small> : null}
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer" className="sm">
                      View
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {me && (recs.length > 0 || isOwner) ? (
          <div className="card">
            <div className="ct">
              Recommendations <span className="more">{recs.filter((r) => r.status === "accepted").length}</span>
            </div>
            {recs.length ? (
              <div className="list">
                {recs.map((r) => (
                  <div className="li" key={r.id}>
                    <Avatar name={r.author?.name ?? "?"} assetId={r.author?.avatarAssetId} size={36} />
                    <div className="t">
                      <b>
                        {r.author?.name ?? "Someone"} <span className="chip xs" style={{ marginLeft: 6 }}>{r.relationship}</span>
                        {isOwner && r.status === "pending" ? <span className="chip warn xs" style={{ marginLeft: 6 }}>Pending your review</span> : null}
                      </b>
                      <p className="sm" style={{ marginTop: 4 }}>
                        “{r.body}”
                      </p>
                      {isOwner && r.status === "pending" ? (
                        <div className="row" style={{ marginTop: 6 }}>
                          <Button
                            small
                            kind="p"
                            data-testid={`profile-recommendation-accept-${r.id}`}
                            onClick={() =>
                              api(`/me/recommendations/${r.id}/accept`, { method: "POST" })
                                .then(() => setRecs((cur) => cur.map((x) => (x.id === r.id ? { ...x, status: "accepted", acceptedAt: new Date().toISOString() } : x))))
                                .catch((err) => toast((err as Error).message, { kind: "err" }))
                            }
                          >
                            Show on profile
                          </Button>
                          <Button
                            small
                            data-testid={`profile-recommendation-reject-${r.id}`}
                            onClick={() =>
                              api(`/me/recommendations/${r.id}/reject`, { method: "POST" })
                                .then(() => setRecs((cur) => cur.filter((x) => x.id !== r.id)))
                                .catch((err) => toast((err as Error).message, { kind: "err" }))
                            }
                          >
                            Not now
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sm dim">No recommendations yet.</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="col">
        {me && !isOwner ? (
          <div className="card">
            <div className="ct">Your relationship</div>
            <div className="list">
              <div className="li">
                <Icon name="people" />
                <div className="t">
                  <b>{data.relationship.mutualCount} mutual connections</b>
                  {data.relationship.mutualSample.length ? <small>incl. {data.relationship.mutualSample.map((m) => m.name).join(", ")}</small> : null}
                </div>
              </div>
            </div>
            {data.relationship.degree !== 1 ? (
              <div style={{ marginTop: 10 }}>
                <AskIntroDialog targetPersonId={data.person.id} targetName={data.person.name} triggerLabel="Request introduction" />
              </div>
            ) : null}
          </div>
        ) : null}

        {me && !isOwner ? (
          <div className="card">
            <div className="ct">
              Private notes <span className="more dim" style={{ fontWeight: 500 }}><Icon name="lock" /> Only you</span>
            </div>
            <NoteEditor targetPersonId={data.person.id} />
          </div>
        ) : null}

        {isOwner ? (
          <div className="card">
            <div className="ct">
              Private notes <Icon name="lock" />
            </div>
            <p className="sm dim">Notes and reminders about people you know live in your CRM.</p>
            <div style={{ marginTop: 8 }}>
              <Button wide icon="star" href="/crm" data-testid="profile-open-crm">
                Open CRM
              </Button>
            </div>
          </div>
        ) : null}

        {me && !isOwner && alsoViewed.length ? (
          <div className="card">
            <div className="ct">People also viewed</div>
            <div className="list">
              {alsoViewed.map((p) => (
                <ProfileCard key={p.id} person={p} dense />
              ))}
            </div>
          </div>
        ) : null}

        {isOwner ? (
          <div className="card" style={{ textAlign: "center" }}>
            <div className="ct" style={{ justifyContent: "center" }}>
              My QR
            </div>
            <Button href="/me/qr" data-testid="profile-view-qr">
              View my QR code
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );

  if (me) {
    return (
      <AppShell cols="two" title={data.person.name}>
        {body}
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
        <Link className="btn" href="/login" data-testid="profile-anon-signin">
          Sign in
        </Link>
        <Link className="btn p" href="/join" data-testid="profile-anon-join">
          Join free
        </Link>
      </nav>
      <div className="content two">{body}</div>
    </div>
  );
}
