"use client";

/**
 * Schedule a meeting and email the invitations.
 *
 * ⛔ The addresses are read with `parseInviteEmails` from @connect/shared —
 * the SAME function the API validates with. A second client-side rule would
 * drift, and the drift shows up as a chip the host can see being silently
 * refused by the server.
 *
 * ⛔ The time is interpreted in the HOST'S OWN browser zone and that zone is
 * sent with it. The screen states the zone in words for the same reason the
 * email does: a time with no zone is a missed meeting.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { CalendarClock, Send, X } from "lucide-react";
import { parseInviteEmails } from "@connect/shared";
import { apiPost } from "../../../services/apiClient";
import { ConnectSelect } from "../../../components/ConnectSelect";
import type { MeetingSummary } from "../../../lib/meetings";

type Props = {
  t: (s: string) => string;
  onScheduled: (m: MeetingSummary, sent: number) => void;
};

const LENGTHS = [15, 30, 45, 60, 90, 120];

/** The browser's own zone — what the host means when they type "2:00". */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

/** The zone in words, for the date chosen (so it says Daylight vs Standard
 *  correctly rather than a generic label that is wrong half the year). */
function zoneLabel(at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value || browserTimeZone();
  } catch {
    return browserTimeZone();
  }
}

function defaultDate(): string {
  const d = new Date(Date.now() + 24 * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ScheduleMeeting({ t, onScheduled }: Props) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("14:00");
  const [minutes, setMinutes] = useState(30);
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [rejected, setRejected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<HTMLInputElement | null>(null);

  const startAt = useMemo(() => {
    const d = new Date(`${date}T${time}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, time]);

  /** Commit whatever is in the box as chips. Runs on Enter, on comma, on blur
   *  and on paste — a host who types an address and clicks Send must not have
   *  it silently dropped because they never pressed Enter. */
  const commitDraft = useCallback(
    (raw?: string) => {
      const text = raw ?? draft;
      if (!text.trim()) return;
      const parsed = parseInviteEmails(text);
      if (parsed.emails.length) {
        setEmails((prev) => Array.from(new Set([...prev, ...parsed.emails])));
      }
      setRejected(parsed.invalid);
      setDraft("");
    },
    [draft],
  );

  const submit = useCallback(async () => {
    if (busy) return;
    // ⛔ Sweep the box first — see commitDraft.
    const pending = parseInviteEmails(draft);
    const finalEmails = Array.from(new Set([...emails, ...pending.emails]));
    if (!startAt) {
      setError(t("Pick a date and a start time."));
      return;
    }
    if (!finalEmails.length) {
      setError(t("Add at least one email address to invite."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await apiPost<MeetingSummary & { invitesSent: number; invalidAddresses: string[] }>("/meetings", {
        title: title.trim() || undefined,
        scheduledStartAt: startAt.toISOString(),
        durationMinutes: minutes,
        timezone: browserTimeZone(),
        message: message.trim() || undefined,
        invites: finalEmails,
      });
      setTitle("");
      setEmails([]);
      setDraft("");
      setMessage("");
      setRejected(created.invalidAddresses || []);
      onScheduled(created, created.invitesSent ?? 0);
    } catch (e: any) {
      // ⛔ `.body`, never `.payload` — that field has never existed.
      const code = e?.body?.error;
      setError(
        code === "meetings_not_configured"
          ? t("Video meetings are not set up on this server yet.")
          : String(e?.body?.message || t("Could not schedule the meeting. Try again.")),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, draft, emails, startAt, title, minutes, message, onScheduled, t]);

  return (
    <div className="mtg-sched">
      <div className="mtg-sched-grid">
        <label className="mtg-field mtg-field-wide">
          <span>{t("Meeting name")}</span>
          <input
            className="mtg-input"
            value={title}
            maxLength={80}
            placeholder={t("Weekly production sync")}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="mtg-field">
          <span>{t("Date")}</span>
          <input className="mtg-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>

        <label className="mtg-field">
          <span>{t("Start time")}</span>
          <input className="mtg-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>

        <label className="mtg-field">
          <span>{t("Length")}</span>
          <ConnectSelect
            value={String(minutes)}
            onChange={(v) => setMinutes(Number(v))}
            options={LENGTHS.map((m) => ({
              value: String(m),
              label: m < 60 ? `${m} ${t("minutes")}` : m === 60 ? `1 ${t("hour")}` : `${m / 60} ${t("hours")}`,
            }))}
          />
        </label>
      </div>

      {startAt && (
        <p className="mtg-sched-zone">
          {t("Times are in")} {zoneLabel(startAt)} — {t("the invitation says so too.")}
        </p>
      )}

      <label className="mtg-field mtg-field-wide">
        <span>{t("Invite by email")}</span>
        <div className="mtg-chips" onClick={() => draftRef.current?.focus()}>
          {emails.map((e) => (
            <span className="mtg-chip" key={e}>
              {e}
              <button
                type="button"
                aria-label={`${t("Remove")} ${e}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setEmails((prev) => prev.filter((x) => x !== e));
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            ref={draftRef}
            className="mtg-chip-input"
            value={draft}
            placeholder={emails.length ? "" : t("Paste or type addresses — commas, semicolons and new lines all work")}
            onChange={(e) => {
              const v = e.target.value;
              // A separator means the address before it is finished.
              if (/[,;\s]/.test(v)) commitDraft(v);
              else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              } else if (e.key === "Backspace" && !draft && emails.length) {
                setEmails((prev) => prev.slice(0, -1));
              }
            }}
            onBlur={() => commitDraft()}
          />
        </div>
      </label>
      {rejected.length > 0 && (
        <p className="mtg-sched-warn">
          {t("Could not read:")} {rejected.join(", ")}
        </p>
      )}

      <label className="mtg-field mtg-field-wide">
        <span>{t("Message (optional)")}</span>
        <textarea
          className="mtg-input mtg-textarea"
          rows={3}
          maxLength={1000}
          value={message}
          placeholder={t("Anything they should know before joining.")}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>

      {error && <div className="mtg-error">{error}</div>}

      <div className="mtg-sched-actions">
        <button className="mtg-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? <CalendarClock size={16} /> : <Send size={16} />}
          {busy ? t("Sending…") : t("Schedule & send invites")}
        </button>
        <span className="mtg-sched-count">
          {emails.length === 1 ? t("1 person") : `${emails.length} ${t("people")}`}
        </span>
      </div>
    </div>
  );
}
