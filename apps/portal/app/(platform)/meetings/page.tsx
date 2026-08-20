"use client";

/**
 * Meetings — start a video meeting, share the link, see your recent meetings.
 * The meeting itself lives on the public /meet/<code> page so guests join the
 * exact same screen the host does.
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, Plus, Video } from "lucide-react";
import { PermissionGate } from "../../../components/PermissionGate";
import { useUiLanguage } from "../../../hooks/useUiLanguage";
import { apiGet, apiPost } from "../../../services/apiClient";
import { meetingLink, type MeetingSummary } from "../../../lib/meetings";
import "./meetings.css";

/** ⛔ Byte-exact — matched literally against what the screen renders for Yiddish. */
const PHRASES = [
  "Meetings", "New meeting",
  "Start a video meeting and share the link — anyone can join from their browser, no account needed.",
  "Meeting name (optional)", "Start meeting", "Starting…",
  "Your recent meetings", "Copy link", "Link copied", "Open", "End", "Ended",
  "No meetings yet. Start one and share the link.",
  "Loading your meetings…", "Locked",
  "Could not load your meetings.", "Could not create the meeting. Try again.",
  "Video meetings are not set up on this server yet.",
] as string[];

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function MeetingsPageInner() {
  const { t } = useUiLanguage(PHRASES);
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiGet<{ meetings: MeetingSummary[] }>("/meetings");
      setMeetings(res.meetings);
      setLoadError(null);
    } catch {
      setLoadError(t("Could not load your meetings."));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await apiPost<MeetingSummary>("/meetings", title.trim() ? { title: title.trim() } : {});
      setTitle("");
      // Straight into the meeting — the person who starts one wants to be in it.
      window.open(`/meet/${created.code}`, "_blank", "noopener");
      await reload();
    } catch (e: any) {
      // ⛔ `.body`, never `.payload` — and map the one config error to plain English.
      const code = e?.body?.error;
      setCreateError(
        code === "meetings_not_configured"
          ? t("Video meetings are not set up on this server yet.")
          : String(e?.body?.message || t("Could not create the meeting. Try again.")),
      );
    } finally {
      setCreating(false);
    }
  }, [creating, title, reload, t]);

  const copyLink = useCallback(async (m: MeetingSummary) => {
    const link = meetingLink(m.code, window.location);
    try {
      await navigator.clipboard.writeText(link);
      setCopiedCode(m.code);
      window.setTimeout(() => setCopiedCode(null), 2500);
    } catch {
      // Clipboard blocked (http / permissions) — select-able prompt fallback.
      window.prompt(t("Copy link"), link);
    }
  }, [t]);

  const endMeeting = useCallback(
    async (m: MeetingSummary) => {
      try {
        await apiPost(`/meetings/${encodeURIComponent(m.code)}/end`);
      } catch {
        /* the list reload shows the truth either way */
      }
      await reload();
    },
    [reload],
  );

  return (
    <div className="mtg-page">
      <header className="mtg-head">
        <div>
          <h1>{t("Meetings")}</h1>
          <p>{t("Start a video meeting and share the link — anyone can join from their browser, no account needed.")}</p>
        </div>
      </header>

      <section className="mtg-new">
        <Video size={20} className="mtg-new-icon" />
        <input
          className="mtg-input"
          placeholder={t("Meeting name (optional)")}
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        <button className="mtg-primary" disabled={creating} onClick={() => void create()}>
          <Plus size={16} />
          {creating ? t("Starting…") : t("Start meeting")}
        </button>
      </section>
      {createError && <div className="mtg-error">{createError}</div>}

      <section className="mtg-list-wrap">
        <h2>{t("Your recent meetings")}</h2>
        {meetings === null && !loadError && <div className="mtg-note">{t("Loading your meetings…")}</div>}
        {loadError && <div className="mtg-error">{loadError}</div>}
        {meetings !== null && meetings.length === 0 && <div className="mtg-note">{t("No meetings yet. Start one and share the link.")}</div>}
        {meetings !== null && meetings.length > 0 && (
          <ul className="mtg-list">
            {meetings.map((m) => (
              <li key={m.id} className={`mtg-row ${m.endedAt ? "ended" : ""}`}>
                <div className="mtg-row-main">
                  <span className="mtg-row-title">{m.title}</span>
                  <span className="mtg-row-meta">
                    {fmtWhen(m.createdAt)}
                    {m.locked && !m.endedAt ? ` · ${t("Locked")}` : ""}
                    {m.endedAt ? ` · ${t("Ended")}` : ""}
                  </span>
                </div>
                <code className="mtg-code">/meet/{m.code}</code>
                {!m.endedAt && (
                  <>
                    <button className="mtg-btn" onClick={() => void copyLink(m)}>
                      <Copy size={14} />
                      {copiedCode === m.code ? t("Link copied") : t("Copy link")}
                    </button>
                    <a className="mtg-btn accent" href={`/meet/${m.code}`} target="_blank" rel="noopener noreferrer">
                      {t("Open")}
                    </a>
                    <button className="mtg-btn danger" onClick={() => void endMeeting(m)}>
                      {t("End")}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function MeetingsPage() {
  return (
    <PermissionGate permission="can_view_workspace_overview">
      <MeetingsPageInner />
    </PermissionGate>
  );
}
