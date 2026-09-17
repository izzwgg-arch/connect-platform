"use client";
/**
 * Yiddish Learning Engine — Gold set (2026-09-17, the Whisper fine-tune build).
 *
 *  POST /admin/yiddish/gold/sample        { count?, sourceKeys?, minSec?, maxSec? }
 *  GET  /admin/yiddish/gold               ?state&limit
 *  POST /admin/yiddish/gold/:reviewId/decide { decision, text? }
 *  GET  /admin/yiddish/gold/clips/:reviewId  (the audio, played through <audio>)
 *  GET  /admin/yiddish/gold/stats
 *
 * One clip at a time, oldest open item first: a native ear listens, corrects
 * or confirms the machine's guess, and moves on. Those decisions become the
 * eval set that proves a fine-tune improved anything (see the handoff at
 * docs/ai-context/AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md).
 *
 * ⛔ Same wall as every other screen in this section: a walled row (customer-
 * private, no recorded basis) never shows its text here, only that it is
 * walled. Deciding on a walled item is refused — there is nothing to correct.
 */
import { useEffect, useRef, useState } from "react";
import { apiPost, getPortalApiBaseUrl, peekBrowserAuthToken } from "../../../../../services/apiClient";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  Card,
  EmptyState,
  ErrorCard,
  LoadingCard,
  Note,
  OwnerOnlyNotice,
  PageHead,
  YC_API_PREFIX,
  YC_CUSTOMER_WALL_MESSAGE,
  YiddishPage,
  YiddishText,
  errText,
  hours,
  listFrom,
  num,
  pct,
  useApi,
} from "../YiddishUi";

type GoldQueueItem = {
  id: string;
  transcriptId: string;
  state: string;
  sourceKey: string | null;
  confidence: number | null;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  text: string | null;
  walled: boolean;
  clipUrl: string;
  createdAt: string | null;
};
type GoldQueueResponse = { items?: GoldQueueItem[]; total?: number; note?: string | null };

type FinetuneReport = {
  baselineWer?: number | null;
  tunedWer?: number | null;
  goldWerBefore?: number | null;
  goldWerAfter?: number | null;
  modelRepo?: string | null;
  reportedAt?: string | null;
} | null;

type GoldStats = {
  open: number;
  decided: number;
  total: number;
  goldHours: number;
  perSource: { sourceKey: string; open: number; decided: number }[];
  finetuneReport: FinetuneReport;
  note?: string | null;
};

type GoldDecision = "correct" | "accept" | "reject" | "skip";

const SAMPLE_COUNT = 50;

function clipSrc(clipUrl: string): string {
  const token = peekBrowserAuthToken();
  return `${getPortalApiBaseUrl()}${clipUrl}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export default function GoldSetPage() {
  const { role } = useAppContext();
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const queue = useApi<GoldQueueResponse>(`${YC_API_PREFIX}/gold?state=OPEN&limit=200`);
  const stats = useApi<GoldStats>(`${YC_API_PREFIX}/gold/stats`);
  const items = listFrom<GoldQueueItem>(queue.data?.items ?? queue.data, "items");
  // Oldest open item first, always. A decision removes it from the OPEN
  // queue on the server, so re-reading item 0 after every reload IS "move to
  // the next clip" — no separate index to keep in sync.
  const current = items[0] ?? null;

  useEffect(() => {
    setDraftText(current?.text ?? "");
    setPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [current?.id]);

  // Space toggles play/pause, but only when focus isn't in the text area
  // (where Space has to type a space). Enter-to-save is bound on the text
  // area itself instead, for the same reason.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, current?.id]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play().catch(() => undefined);
    }
  };

  const decide = async (decision: GoldDecision, text?: string) => {
    if (!current || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const body: Record<string, unknown> = { decision };
      if (text != null) body.text = text;
      await apiPost(`${YC_API_PREFIX}/gold/${encodeURIComponent(current.id)}/decide`, body);
      setNote({ kind: "ok", text: DECISION_NOTE[decision] });
      queue.reload();
      stats.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The decision was not recorded.") });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!current || current.walled) return;
    const trimmed = draftText.trim();
    if (!trimmed) {
      setNote({ kind: "bad", text: "There is no text to save — type a correction, or use Unusable / Skip." });
      return;
    }
    if (trimmed === (current.text ?? "").trim()) void decide("accept");
    else void decide("correct", trimmed);
  };

  const reviewed = num(stats.data?.decided ?? 0);
  const total = num(stats.data?.total ?? 0);
  const progressPct = stats.data && stats.data.total > 0 ? Math.round((stats.data.decided / stats.data.total) * 100) : 0;

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Gold set" />;

  return (
    <YiddishPage>
      <PageHead
        title="Gold set"
        subtitle="One clip at a time. Correct or confirm the machine's guess — this becomes the set that proves a fine-tune actually improved."
        actions={
          <>
            <button
              className="lbtn sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNote(null);
                try {
                  const out = await apiPost<{ created: number; candidatePool: number; note: string | null }>(
                    `${YC_API_PREFIX}/gold/sample`,
                    { count: SAMPLE_COUNT },
                  );
                  setNote({
                    kind: "ok",
                    text: out.note || `Sampled ${out.created} new clip(s) from a pool of ${out.candidatePool}.`,
                  });
                  queue.reload();
                  stats.reload();
                } catch (e: any) {
                  setNote({ kind: "bad", text: errText(e, "Sampling failed.") });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Sample {SAMPLE_COUNT} more
            </button>
            <button className="lbtn sm" onClick={() => { queue.reload(); stats.reload(); }}>
              Refresh
            </button>
          </>
        }
      />
      <Note note={note} />

      <Card className="gold-progress" title="Progress" sub={`${reviewed} of ${total} reviewed`}>
        <div className="track" style={{ height: 8, borderRadius: 4, background: "color-mix(in srgb, var(--fg) 10%, transparent)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progressPct}%`, background: "var(--accent)", transition: "width .2s" }} />
        </div>
        <div className="row small dimtx" style={{ marginTop: 8, gap: 16 }}>
          <span>{hours(stats.data?.goldHours ?? null)} of gold audio</span>
          {stats.data?.finetuneReport ? (
            <span>
              Latest run: WER {pct(stats.data.finetuneReport.goldWerBefore, 1)} → {pct(stats.data.finetuneReport.goldWerAfter, 1)}
              {stats.data.finetuneReport.modelRepo ? ` (${stats.data.finetuneReport.modelRepo})` : ""}
            </span>
          ) : (
            <span>No fine-tune run has reported back yet.</span>
          )}
        </div>
      </Card>

      {queue.loading && queue.data == null ? (
        <LoadingCard rows={4} label="Loading the gold queue" />
      ) : queue.error ? (
        <ErrorCard error={queue.error} what="The gold queue" onRetry={queue.reload} />
      ) : !current ? (
        <Card>
          <EmptyState
            title="Nothing waiting"
            text="The gold queue is empty. Sample more clips above, or everything sampled so far has already been reviewed."
          />
        </Card>
      ) : (
        <Card
          title={`Clip ${current.sourceKey ?? "unknown source"}`}
          sub={`Confidence ${pct(current.confidence, 0)} · ${current.durationMs != null ? `${(current.durationMs / 1000).toFixed(1)}s` : "—"}`}
          right={
            <span className="row" style={{ gap: 6 }}>
              <span className="pill dim">{current.sourceKey ?? "unknown"}</span>
              <span className="pill dim">confidence {pct(current.confidence, 0)}</span>
            </span>
          }
        >
          {current.walled ? (
            <EmptyState title="This clip is behind the customer data wall" text={YC_CUSTOMER_WALL_MESSAGE} />
          ) : (
            <>
              <audio
                ref={audioRef}
                src={clipSrc(current.clipUrl)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                controls
                style={{ width: "100%", marginBottom: 12 }}
              />
              <div style={{ marginBottom: 8 }}>
                <YiddishText text={current.text} className="big" block />
              </div>
              <div className="form">
                <label className="field full">
                  <span>Correction (Hebrew script, right-to-left)</span>
                  <textarea
                    dir="rtl"
                    lang="yi"
                    className="linput yi"
                    rows={3}
                    style={{ height: 96, resize: "vertical", padding: "8px 10px" }}
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        save();
                      }
                    }}
                    placeholder="Type the correct text, or leave as-is and click It's right"
                  />
                </label>
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                <button className="lbtn primary" disabled={busy} onClick={save}>
                  Correct (save my text)
                </button>
                <button className="lbtn" disabled={busy} onClick={() => decide("accept")}>
                  It's right
                </button>
                <button className="lbtn danger" disabled={busy} onClick={() => decide("reject")}>
                  Unusable
                </button>
                <button className="lbtn ghost" disabled={busy} onClick={() => decide("skip")}>
                  Skip
                </button>
              </div>
              <div className="help" style={{ marginTop: 8 }}>
                Enter saves (Correct if the text changed, It's right if not). Space plays or pauses the clip when focus isn't in
                the text box.
              </div>
            </>
          )}
        </Card>
      )}
    </YiddishPage>
  );
}

const DECISION_NOTE: Record<GoldDecision, string> = {
  correct: "Saved your correction as the gold text.",
  accept: "Confirmed — the machine's text is the gold text.",
  reject: "Marked unusable. The machine row stays as evidence; it just won't be used for eval or training.",
  skip: "Skipped for now.",
};
