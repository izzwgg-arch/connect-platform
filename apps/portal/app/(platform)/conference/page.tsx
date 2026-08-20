"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Pencil, Phone, Plus, RefreshCw, Trash2, UsersRound } from "lucide-react";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { useUiLanguage } from "../../../hooks/useUiLanguage";
import { apiDelete, apiGet } from "../../../services/apiClient";
import { ConferenceDialog, CONFERENCE_DIALOG_PHRASES, type ConferenceRoom } from "./ConferenceDialog";

/**
 * ⛔ Byte-exact. These strings are matched literally against what the screen
 * renders, so a curly apostrophe or an em-dash that differs by one character
 * never reaches Yiddish and silently falls back to English.
 */
const PHRASES = [
  "Conference",
  "Meeting rooms on your phone system. Anyone on your system can dial a room's number to join.",
  "New conference room", "Refresh", "Live", "Reconnecting",
  "Loading conference rooms…",
  "Conference rooms could not be loaded:",
  "No conference rooms yet.",
  "Create a room and anyone on your phone system can dial its number to meet — from a desk phone, the app, or this screen.",
  "dial to join", "on the call", "Nobody on the call",
  "Join from my phone", "Edit", "Delete", "Delete?", "Deleting…",
  "PIN", "Host PIN", "No PIN — open room", "show", "hide",
  "Recorded", "Announces joins", "Announces how many are on", "Everyone starts muted",
  "Music until the host joins", "Waits for the host", "Ends when the host leaves",
  "Quiet room", "Max", "people",
  "Couldn't delete that room.",
  "The live connection to the phone system is down, so the on-the-call counts may be out of date. Room numbers and PINs below are still correct.",
  "Outside callers can join too — ask us to point one of your phone numbers (or an IVR key) at a room.",
  "Conference rooms are switched off for your account.",
  ...CONFERENCE_DIALOG_PHRASES,
] as string[];

type ConferencesResponse = {
  conferences?: ConferenceRoom[];
  source?: string;
  skipReason?: string | null;
  mayManage?: boolean;
};

function ConferencePageInner() {
  const { can } = useAppContext();
  const { activeCalls, isLive } = useTelephony();
  const { t } = useUiLanguage(PHRASES);

  const [rooms, setRooms] = useState<ConferenceRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [serverMayManage, setServerMayManage] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; room: ConferenceRoom } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiGet<ConferencesResponse>("/voice/conferences")
      .then((res) => {
        if (res.source === "skipped") {
          setRooms([]);
          setConfigError(res.skipReason || "unavailable");
        } else {
          setRooms(res.conferences ?? []);
          setConfigError(null);
        }
        if (typeof res.mayManage === "boolean") setServerMayManage(res.mayManage);
      })
      .catch((e: any) => {
        setRooms([]);
        setConfigError(e?.body?.message || e?.body?.detail || e?.message || "unavailable");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // ⛔ The buttons check what the ROUTE accepts. The server's own answer wins
  // once loaded (it ran the identical gate); until then the local key check
  // keeps the button from flashing in and out.
  const canManage = serverMayManage ?? can("can_manage_conferences" as never);

  // Who's on a call in each room right now — read off the existing live-calls
  // feed, never a second REST source. A ConfBridge participant is a live call
  // whose destination is the room number, so this is an approximation: honest
  // for "is the room in use and roughly how busy", not a participant roster.
  const liveCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!isLive) return counts;
    for (const room of rooms) {
      const n = activeCalls.filter(
        (c) =>
          (c.state === "up" || c.state === "held") &&
          (c.destination_extension === room.extension ||
            c.to === room.extension ||
            (Array.isArray(c.extensions) && c.extensions.includes(room.extension))),
      ).length;
      counts.set(room.extension, n);
    }
    return counts;
  }, [rooms, activeCalls, isLive]);

  return (
    <div className="qb-page cf-page">
      <header className="qb-head">
        <div className="qb-head-main">
          <h1 className="qb-title">
            <UsersRound size={22} aria-hidden /> {t("Conference")}
          </h1>
          <p className="qb-sub">
            {t("Meeting rooms on your phone system. Anyone on your system can dial a room's number to join.")}
          </p>
        </div>
        <div className="qb-head-actions">
          <span className={`qb-livechip ${isLive ? "is-live" : "is-stale"}`}>
            <span className="qb-dot" aria-hidden />
            {isLive ? t("Live") : t("Reconnecting")}
          </span>
          <button type="button" className="qb-btn" onClick={reload}>
            <RefreshCw size={15} aria-hidden /> {t("Refresh")}
          </button>
          {canManage && (
            <button type="button" className="qb-btn qb-btn-primary" onClick={() => setDialog({ mode: "create" })}>
              <Plus size={15} aria-hidden /> {t("New conference room")}
            </button>
          )}
        </div>
      </header>

      {toast && <p className="qb-notice qb-notice-ok">{toast}</p>}

      {dialog && (
        <ConferenceDialog
          mode={dialog.mode}
          room={dialog.mode === "edit" ? dialog.room : undefined}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setToast(msg);
            reload();
          }}
        />
      )}

      {!isLive && rooms.length > 0 && (
        <p className="qb-notice qb-notice-warn">
          {t("The live connection to the phone system is down, so the on-the-call counts may be out of date. Room numbers and PINs below are still correct.")}
        </p>
      )}

      {configError && (
        <p className="qb-notice qb-notice-warn">
          {t("Conference rooms could not be loaded:")} {configError}
        </p>
      )}

      {loading && !rooms.length && <p className="qb-empty">{t("Loading conference rooms…")}</p>}

      {!loading && !configError && rooms.length === 0 && (
        <div className="qb-empty cf-empty">
          <p className="cf-empty-t">{t("No conference rooms yet.")}</p>
          <p>{t("Create a room and anyone on your phone system can dial its number to meet — from a desk phone, the app, or this screen.")}</p>
          {canManage && (
            <button type="button" className="qb-btn qb-btn-primary" onClick={() => setDialog({ mode: "create" })}>
              <Plus size={15} aria-hidden /> {t("New conference room")}
            </button>
          )}
        </div>
      )}

      {rooms.length > 0 && (
        <section className="cf-grid" aria-label={t("Conference")}>
          {rooms.map((room) => (
            <RoomCard
              key={room.extension}
              room={room}
              liveCount={liveCounts.get(room.extension) ?? 0}
              live={isLive}
              canManage={canManage}
              onEdit={() => setDialog({ mode: "edit", room })}
              onDeleted={(msg) => {
                setToast(msg);
                reload();
              }}
            />
          ))}
        </section>
      )}

      {rooms.length > 0 && (
        <p className="qb-foot">
          {t("Outside callers can join too — ask us to point one of your phone numbers (or an IVR key) at a room.")}
        </p>
      )}
    </div>
  );
}

function optionChips(room: ConferenceRoom, t: (s: string) => string): string[] {
  const chips: string[] = [];
  if (room.recordConference) chips.push(t("Recorded"));
  if (room.announceJoinLeave) chips.push(t("Announces joins"));
  if (room.announceUserCount) chips.push(t("Announces how many are on"));
  if (room.startMuted) chips.push(t("Everyone starts muted"));
  if (room.musicOnHoldWhenEmpty) chips.push(t("Music until the host joins"));
  if (room.waitForAdmin) chips.push(t("Waits for the host"));
  if (room.endWhenAdminLeaves) chips.push(t("Ends when the host leaves"));
  if (room.quiet) chips.push(t("Quiet room"));
  if (room.maxMembers) chips.push(`${t("Max")} ${room.maxMembers} ${t("people")}`);
  return chips;
}

function RoomCard({
  room,
  liveCount,
  live,
  canManage,
  onEdit,
  onDeleted,
}: {
  room: ConferenceRoom;
  liveCount: number;
  live: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDeleted: (msg: string) => void;
}) {
  const { t } = useUiLanguage();
  const [showPins, setShowPins] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Joining IS dialing: hand the room number to the softphone through the
  // same click-to-call bus the CRM uses. The FloatingDialer opens, shows the
  // call, and applies its own registered-state guards.
  const join = () => {
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: room.extension } }));
  };

  const doDelete = async () => {
    setDeleting(true);
    setErr(null);
    try {
      const res = await apiDelete<{ message?: string }>(`/voice/conferences/${encodeURIComponent(room.extension)}`);
      onDeleted(res?.message || `${room.name} — ${t("Delete")}`);
    } catch (e: any) {
      setErr(e?.body?.message || e?.body?.detail || e?.message || t("Couldn't delete that room."));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const hasPin = Boolean(room.userPin || room.adminPin);
  const mask = (pin: string | null) => (pin ? (showPins ? pin : "•".repeat(Math.min(pin.length, 6))) : null);

  return (
    <article className="qb-card cf-card">
      <header className="qb-card-h">
        <div>
          <h3 className="qb-card-t">{room.name}</h3>
          <div className="cf-dial">
            {room.extension} <span className="cf-dial-hint">{t("dial to join")}</span>
          </div>
        </div>
        <span className={`cf-live ${live && liveCount > 0 ? "cf-live-on" : "cf-live-idle"}`}>
          {live && liveCount > 0 ? `${liveCount} ${t("on the call")}` : t("Nobody on the call")}
        </span>
      </header>

      <div className="cf-pins">
        {hasPin ? (
          <>
            {room.userPin && (
              <span>
                {t("PIN")} <b className="qb-num">{mask(room.userPin)}</b>
              </span>
            )}
            {room.adminPin && (
              <span>
                {t("Host PIN")} <b className="qb-num">{room.adminPin === "•••" ? "•••" : mask(room.adminPin)}</b>
              </span>
            )}
            <button type="button" className="cf-eye" onClick={() => setShowPins((v) => !v)}>
              {showPins ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}{" "}
              {showPins ? t("hide") : t("show")}
            </button>
          </>
        ) : (
          <span className="qb-dim">{t("No PIN — open room")}</span>
        )}
      </div>

      {optionChips(room, t).length > 0 && (
        <ul className="cf-chips">
          {optionChips(room, t).map((c) => (
            <li key={c} className="cf-chip">
              {c}
            </li>
          ))}
        </ul>
      )}

      {err && <p className="qb-notice qb-notice-warn">{err}</p>}

      <div className="cf-actions">
        <button type="button" className="qb-btn qb-btn-primary" onClick={join}>
          <Phone size={14} aria-hidden /> {t("Join from my phone")}
        </button>
        {canManage && (
          <>
            <button type="button" className="qb-btn" onClick={onEdit}>
              <Pencil size={14} aria-hidden /> {t("Edit")}
            </button>
            {confirmingDelete ? (
              <button type="button" className="qb-btn cf-btn-danger" onClick={doDelete} disabled={deleting}>
                <Trash2 size={14} aria-hidden /> {deleting ? t("Deleting…") : t("Delete?")}
              </button>
            ) : (
              <button type="button" className="qb-btn" onClick={() => setConfirmingDelete(true)}>
                <Trash2 size={14} aria-hidden /> {t("Delete")}
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/**
 * ⛔ The page gates itself. Hiding the sidebar item is presentation, not
 * access — without this a link, a bookmark or a typed URL would still render
 * the screen for somebody whose role has it switched off.
 */
export default function ConferencePage() {
  return (
    <PermissionGate
      permission={"can_view_conferences" as never}
      fallback={
        <div className="qb-page">
          <p className="qb-notice qb-notice-warn">Conference rooms are switched off for your account.</p>
        </div>
      }
    >
      <ConferencePageInner />
    </PermissionGate>
  );
}
