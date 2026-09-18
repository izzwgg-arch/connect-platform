"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Chip, Dialog, Empty, Skeleton, useToast } from "@/components/ui";
import { OpportunityCard, type OpportunityItem } from "@/components/opportunities/OpportunityCard";
import "@/components/opportunities/opportunities.css";

type OppType = { id: string; slug: string; name: string; description: string | null; fieldSchema: unknown; count: number };

export default function OpportunitiesPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [types, setTypes] = useState<OppType[]>([]);
  const [type, setType] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<OpportunityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [interestFor, setInterestFor] = useState<string | null>(null);
  const [interestMessage, setInterestMessage] = useState("");
  const [questionFor, setQuestionFor] = useState<string | null>(null);
  const [questionText, setQuestionText] = useState("");

  useEffect(() => {
    api<{ types: OppType[] }>("/opportunities/types")
      .then((r) => setTypes(r.types))
      .catch(() => setTypes([]));
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      cursor ? setLoadingMore(true) : setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (type) params.set("type", type);
        if (cursor) params.set("cursor", cursor);
        const r = await api<{ items: OpportunityItem[]; nextCursor: string | null }>(`/opportunities?${params.toString()}`);
        setItems((cur) => (cursor ? [...cur, ...r.items] : r.items));
        setNextCursor(r.nextCursor);
      } catch (e: any) {
        toast(e?.message ?? "Couldn't load opportunities.", { kind: "err" });
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, type],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, type]);

  async function submitInterest() {
    if (!interestFor) return;
    setBusyId(interestFor);
    try {
      await api(`/opportunities/${interestFor}/interest`, { method: "POST", body: interestMessage.trim() ? { message: interestMessage.trim() } : {} });
      setItems((cur) => cur.map((it) => (it.opportunity.id === interestFor ? { ...it, myInterest: true, interestCount: it.interestCount + 1 } : it)));
      toast("They'll see you're interested.");
      setInterestFor(null);
      setInterestMessage("");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function submitQuestion() {
    if (!questionFor || !questionText.trim()) return;
    setBusyId(questionFor);
    try {
      await api(`/opportunities/${questionFor}/question`, { method: "POST", body: { question: questionText.trim() } });
      toast("Question sent.");
      setQuestionFor(null);
      setQuestionText("");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that question.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function share(id: string) {
    const url = `${window.location.origin}/opportunities/${id}`;
    try {
      if (navigator.share) await navigator.share({ url });
      else {
        await navigator.clipboard.writeText(url);
        toast("Link copied.");
      }
    } catch {
      /* cancelled */
    }
  }

  const totalCount = types.reduce((s, t) => s + t.count, 0);

  return (
    <AppShell title="Opportunities">
      <div className="col" style={{ gridColumn: "1/-1" }}>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <form
              className="row"
              style={{ flex: 1 }}
              onSubmit={(e) => {
                e.preventDefault();
                setQ(qInput.trim());
              }}
            >
              <input className="in" style={{ flex: 1 }} placeholder="Search opportunities" value={qInput} onChange={(e) => setQInput(e.target.value)} data-testid="opportunities-search-input" />
              <Button kind="p" type="submit" icon="search" data-testid="opportunities-search-submit">
                Search
              </Button>
            </form>
            <Button href="/opportunities/new" icon="plus" data-testid="opportunities-post">
              Post an opportunity
            </Button>
          </div>
          <div className="pill-row opp-type-chips" style={{ marginTop: 10 }} data-testid="opportunities-type-chips">
            <Chip kind={type === "" ? "sel" : ""} onClick={() => setType("")} testId="opportunities-type-all">
              All · {totalCount}
            </Chip>
            {types.map((t) => (
              <Chip key={t.slug} kind={type === t.slug ? "sel" : ""} onClick={() => setType(t.slug)} testId={`opportunities-type-${t.slug}`}>
                {t.name} · {t.count}
              </Chip>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="grid2">
            <Skeleton h={160} />
            <Skeleton h={160} />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No opportunities match yet" text="Try a different type or search." action={<Button href="/opportunities/new" icon="plus">Post an opportunity</Button>} />
        ) : (
          <>
            <div className="grid2" data-testid="opportunities-grid">
              {items.map((it) => (
                <OpportunityCard
                  key={it.opportunity.id}
                  item={it}
                  busy={busyId === it.opportunity.id}
                  onInterested={setInterestFor}
                  onQuestion={setQuestionFor}
                  onShare={share}
                />
              ))}
            </div>
            {nextCursor ? (
              <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
                <Button loading={loadingMore} onClick={() => load(nextCursor)} data-testid="opportunities-load-more">
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={!!interestFor} onClose={() => setInterestFor(null)} title="I'm interested">
        <textarea
          className="in"
          style={{ minHeight: 90, marginTop: 10 }}
          placeholder="Add a note (optional)…"
          value={interestMessage}
          onChange={(e) => setInterestMessage(e.target.value)}
          data-testid="opportunities-interest-message"
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button kind="p" loading={busyId === interestFor} onClick={submitInterest} data-testid="opportunities-interest-send">
            Send
          </Button>
        </div>
      </Dialog>

      <Dialog open={!!questionFor} onClose={() => setQuestionFor(null)} title="Ask a question">
        <textarea
          className="in"
          style={{ minHeight: 90, marginTop: 10 }}
          placeholder="What do you want to ask?"
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
          data-testid="opportunities-question-text"
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button kind="p" loading={busyId === questionFor} disabled={!questionText.trim()} onClick={submitQuestion} data-testid="opportunities-question-send">
            Send
          </Button>
        </div>
      </Dialog>
    </AppShell>
  );
}
