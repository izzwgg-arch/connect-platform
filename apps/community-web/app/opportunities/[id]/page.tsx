"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, trackEvent } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Skeleton, timeAgo, useToast } from "@/components/ui";
import type { OpportunityItem } from "@/components/opportunities/OpportunityCard";
import "@/components/opportunities/opportunities.css";

type OppField = { key: string; label: string; type: string; required?: boolean; options?: string[] };
type Interest = { person: { id: string; username: string; name: string; avatarAssetId: string | null } | null; message: string | null; threadId: string | null; createdAt: string };

function fieldDisplay(f: OppField, v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (f.type === "multiselect" && Array.isArray(v)) return v.join(", ");
  if (f.type === "money") return `$${Number(v).toLocaleString()}`;
  if (f.type === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export default function OpportunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const toast = useToast();
  const [item, setItem] = useState<OpportunityItem | null>(null);
  const [notFoundFlag, setNotFoundFlag] = useState(false);
  const [interestOpen, setInterestOpen] = useState(false);
  const [interestMessage, setInterestMessage] = useState("");
  const [questionOpen, setQuestionOpen] = useState(false);
  const [questionText, setQuestionText] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [interests, setInterests] = useState<Interest[] | null>(null);

  useEffect(() => {
    api<OpportunityItem>(`/public/opportunities/${id}`)
      .then((r) => {
        setItem(r);
        trackEvent("post_impression", { objectType: "Opportunity", objectId: id, surface: "opportunities_detail" });
      })
      .catch(() => setNotFoundFlag(true));
  }, [id]);

  const isPoster = !!me && !!item && item.poster?.id === me.person.id;

  useEffect(() => {
    if (!isPoster) return;
    api<{ interests: Interest[] }>(`/opportunities/${id}/interests`)
      .then((r) => setInterests(r.interests))
      .catch(() => setInterests([]));
  }, [isPoster, id]);

  async function submitInterest() {
    setBusy(true);
    try {
      await api(`/opportunities/${id}/interest`, { method: "POST", body: interestMessage.trim() ? { message: interestMessage.trim() } : {} });
      setItem((cur) => (cur ? { ...cur, myInterest: true, interestCount: cur.interestCount + 1 } : cur));
      toast("They'll see you're interested.");
      setInterestOpen(false);
      setInterestMessage("");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function submitQuestion() {
    if (!questionText.trim()) return;
    setBusy(true);
    try {
      await api(`/opportunities/${id}/question`, { method: "POST", body: { question: questionText.trim() } });
      toast("Question sent.");
      setQuestionOpen(false);
      setQuestionText("");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that question.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const url = `${window.location.origin}/opportunities/${id}`;
    try {
      if (navigator.share) await navigator.share({ title: item?.opportunity.title, url });
      else {
        await navigator.clipboard.writeText(url);
        toast("Link copied.");
      }
    } catch {
      /* cancelled */
    }
  }

  async function submitReport(reason: string) {
    try {
      await api("/reports", { method: "POST", body: { targetType: "opportunity", targetId: id, reason } });
      toast("Thanks — we'll take a look.");
      setReportOpen(false);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that report.", { kind: "err" });
    }
  }

  async function close() {
    try {
      const updated = await api<OpportunityItem>(`/opportunities/${id}/close`, { method: "POST" });
      setItem(updated);
      toast("Opportunity closed.");
      setCloseOpen(false);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't close that.", { kind: "err" });
    }
  }

  const schema: OppField[] = (item?.type?.fieldSchema as OppField[] | undefined) ?? [];

  const body = notFoundFlag ? (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <Empty title="That opportunity doesn't exist" text="It may have been removed or the link is wrong." action={<Button href="/opportunities">Back to opportunities</Button>} />
    </div>
  ) : !item ? (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <Skeleton h={220} />
    </div>
  ) : (
    <div className="col" style={{ gridColumn: "1/-1" }} data-testid="opportunities-detail">
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <Chip kind="ac">{item.type?.name ?? "Opportunity"}</Chip>
          {item.opportunity.status !== "OPEN" ? <Chip kind="warn">{item.opportunity.status === "CLOSED" ? "Closed" : "Removed"}</Chip> : null}
        </div>
        <h1 style={{ fontSize: 20, marginTop: 8 }}>{item.opportunity.title}</h1>
        <div className="row xs dim" style={{ marginTop: 6 }}>
          <Avatar name={item.organization?.displayName ?? item.poster?.name ?? "Someone"} assetId={item.organization?.logoAssetId ?? item.poster?.avatarAssetId ?? null} size={28} />
          {item.organization ? (
            <Link href={`/companies/${item.organization.slug}`}>{item.organization.displayName}</Link>
          ) : item.poster ? (
            <Link href={`/people/${item.poster.username}`}>{item.poster.name}</Link>
          ) : (
            <span>Someone</span>
          )}
          <span>· {[item.opportunity.location, timeAgo(item.opportunity.createdAt), `${item.interestCount} interested`].filter(Boolean).join(" · ")}</span>
        </div>

        <p className="sm" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
          {item.opportunity.description}
        </p>

        {schema.length ? (
          <div className="opp-field-grid">
            {schema.map((f) => (
              <div className="kv" key={f.key}>
                <small className="lbl" style={{ margin: 0 }}>
                  {f.label}
                </small>
                <b className="sm">{fieldDisplay(f, item.opportunity.fields[f.key])}</b>
              </div>
            ))}
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
          {isPoster ? null : me ? (
            <Button kind="p" disabled={item.myInterest || item.opportunity.status !== "OPEN"} onClick={() => setInterestOpen(true)} data-testid="opportunities-detail-interested">
              {item.myInterest ? "Interested ✓" : "I'm interested"}
            </Button>
          ) : (
            <Button kind="p" href={`/login?next=/opportunities/${id}`} data-testid="opportunities-detail-signin">
              Sign in to respond
            </Button>
          )}
          {!isPoster && me ? (
            <Button onClick={() => setQuestionOpen(true)} data-testid="opportunities-detail-question">
              Ask a question
            </Button>
          ) : null}
          <Button kind="g" icon="share" onClick={share} data-testid="opportunities-detail-share">
            Share
          </Button>
          {!isPoster && me ? (
            <Button kind="g" icon="flag" onClick={() => setReportOpen(true)} data-testid="opportunities-detail-report">
              Report
            </Button>
          ) : null}
          {isPoster && item.opportunity.status === "OPEN" ? (
            <Button kind="g d" onClick={() => setCloseOpen(true)} data-testid="opportunities-detail-close">
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {isPoster ? (
        <div className="card">
          <div className="ct">
            Interested <Chip kind="ac">{interests?.length ?? item.interestCount}</Chip>
          </div>
          {!interests ? (
            <Skeleton h={56} />
          ) : interests.length === 0 ? (
            <Empty title="No one yet" text="People who say they're interested will show up here." />
          ) : (
            <div className="list sm" data-testid="opportunities-detail-interests">
              {interests.map((it, i) => (
                <div className="li" key={i}>
                  <Avatar name={it.person?.name ?? "Someone"} assetId={it.person?.avatarAssetId ?? null} size={36} />
                  <div className="t">
                    <b>{it.person?.name ?? "Someone"}</b>
                    {it.message ? <p style={{ marginTop: 4 }}>{it.message}</p> : null}
                  </div>
                  {it.threadId ? (
                    <Button small href={`/messages/${it.threadId}`} data-testid={`opportunities-detail-message-${i}`}>
                      Message
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <Dialog open={interestOpen} onClose={() => setInterestOpen(false)} title="I'm interested">
        <textarea className="in" style={{ minHeight: 90, marginTop: 10 }} placeholder="Add a note (optional)…" value={interestMessage} onChange={(e) => setInterestMessage(e.target.value)} data-testid="opportunities-detail-interest-message" />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button kind="p" loading={busy} onClick={submitInterest} data-testid="opportunities-detail-interest-send">
            Send
          </Button>
        </div>
      </Dialog>

      <Dialog open={questionOpen} onClose={() => setQuestionOpen(false)} title="Ask a question">
        <textarea className="in" style={{ minHeight: 90, marginTop: 10 }} placeholder="What do you want to ask?" value={questionText} onChange={(e) => setQuestionText(e.target.value)} data-testid="opportunities-detail-question-text" />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button kind="p" loading={busy} disabled={!questionText.trim()} onClick={submitQuestion} data-testid="opportunities-detail-question-send">
            Send
          </Button>
        </div>
      </Dialog>

      <Dialog open={reportOpen} onClose={() => setReportOpen(false)} title="Report this opportunity">
        <div className="list sm">
          {["SPAM", "SCAM", "FAKE_COMPANY", "OTHER"].map((r) => (
            <button key={r} type="button" className="li" style={{ width: "100%", textAlign: "left", cursor: "pointer" }} onClick={() => submitReport(r)} data-testid={`opportunities-detail-report-${r.toLowerCase()}`}>
              <div className="t">
                <b>{r.replace("_", " ")}</b>
              </div>
            </button>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title="Close this opportunity?"
        footer={
          <>
            <Button kind="g" onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            <Button kind="p" onClick={close} data-testid="opportunities-detail-close-confirm">
              Close it
            </Button>
          </>
        }
      >
        <p className="sm">It will stop appearing in the board's listing.</p>
      </Dialog>
    </div>
  );

  if (me) {
    return <AppShell title={item?.opportunity.title ?? "Opportunity"}>{body}</AppShell>;
  }
  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span style={{ flex: 1 }} />
        <Link className="btn" href="/login" data-testid="opportunities-public-signin">
          Sign in
        </Link>
        <Link className="btn p" href="/join" data-testid="opportunities-public-join">
          Join free
        </Link>
      </nav>
      <div className="content">{body}</div>
    </div>
  );
}
