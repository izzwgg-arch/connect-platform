"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { apiPatch, apiPost } from "../../../services/apiClient";
import { useAppContext } from "../../../hooks/useAppContext";
import { useUiLanguage } from "../../../hooks/useUiLanguage";

/**
 * Create or edit a conference room.
 *
 * Same rules as the queue dialog: plain language on every control (what it does
 * to a caller, not what Asterisk calls it), and honesty about when it goes
 * live. It posts to the EXISTING /voice/conferences routes — no second path.
 *
 * ⛔ Apply Changes: a new room does not answer callers until the phone system
 * applies. Only a SUPER_ADMIN sees the "turn it on now" switch (the route
 * ignores the flag from anyone else); it is OFF by default on purpose — Apply
 * is whole-PBX and is not something to fire casually.
 */

export type ConferenceRoom = {
  id: string;
  extension: string;
  name: string;
  userPin: string | null;
  adminPin: string | null;
  maxMembers: number | null;
  recordConference: boolean;
  startMuted: boolean;
  quiet: boolean;
  announceUserCount: boolean;
  announceJoinLeave: boolean;
  musicOnHoldWhenEmpty: boolean;
  waitForAdmin: boolean;
  endWhenAdminLeaves: boolean;
};

/** Byte-exact strings, so every one of them reaches Yiddish. */
export const CONFERENCE_DIALOG_PHRASES = [
  "New conference room", "Edit conference room",
  "A number anyone on your phone system can dial to meet.",
  "Room name", "Sales stand-up, Vendors, Family — whatever you'll call the meeting.",
  "Room number", "Leave blank and we pick the next free one (700, 701, …).",
  "The room's number can't change after it's made.",
  "Participant PIN", "Host PIN", "3–10 digits, or leave blank for an open room.",
  "Whoever enters this PIN runs the meeting. Must be different from the participant PIN.",
  "Record the meeting",
  "Play a beep when someone joins or leaves",
  "Say how many people are on when someone joins",
  "Everyone joins muted (the host unmutes)",
  "Play music until the host arrives",
  "Wait for the host before the meeting starts",
  "End the meeting when the host hangs up",
  "Most people allowed on the call", "0 means no limit",
  "Turn it on now (applies phone-system changes)",
  "Cancel", "Create room", "Save changes", "Saving…",
  "Give the room a name.",
  "A PIN is 3–10 digits.",
  "The host PIN has to be different from the participant PIN.",
  "Couldn't save the room.",
] as const;

const PIN_RE = /^\d{3,10}$/;

export function ConferenceDialog({
  mode,
  room,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  room?: ConferenceRoom;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { t } = useUiLanguage(CONFERENCE_DIALOG_PHRASES as unknown as string[]);
  const { backendJwtRole } = useAppContext();
  const isSuper = backendJwtRole === "SUPER_ADMIN";

  const [name, setName] = useState(room?.name ?? "");
  const [extension, setExtension] = useState("");
  const [userPin, setUserPin] = useState(room?.userPin ?? "");
  // A masked host PIN ("•••") means the server withheld it; treat as untouched.
  const [adminPin, setAdminPin] = useState(room?.adminPin === "•••" ? "" : room?.adminPin ?? "");
  const [maxMembers, setMaxMembers] = useState(room?.maxMembers ?? 0);
  const [record, setRecord] = useState(room?.recordConference ?? false);
  const [announceJoinLeave, setAnnounceJoinLeave] = useState(room?.announceJoinLeave ?? true);
  const [announceUserCount, setAnnounceUserCount] = useState(room?.announceUserCount ?? false);
  const [startMuted, setStartMuted] = useState(room?.startMuted ?? false);
  const [mohWhenEmpty, setMohWhenEmpty] = useState(room?.musicOnHoldWhenEmpty ?? true);
  const [waitForAdmin, setWaitForAdmin] = useState(room?.waitForAdmin ?? false);
  const [endWhenAdminLeaves, setEndWhenAdminLeaves] = useState(room?.endWhenAdminLeaves ?? false);
  const [applyNow, setApplyNow] = useState(false);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    // ⛔ Refuse loudly at the control that was pressed — never a silently
    // disabled button.
    if (!name.trim()) {
      setErr(t("Give the room a name."));
      return;
    }
    for (const pin of [userPin.trim(), adminPin.trim()]) {
      if (pin && !PIN_RE.test(pin)) {
        setErr(t("A PIN is 3–10 digits."));
        return;
      }
    }
    if (userPin.trim() && adminPin.trim() && userPin.trim() === adminPin.trim()) {
      setErr(t("The host PIN has to be different from the participant PIN."));
      return;
    }

    setSaving(true);
    setErr(null);
    try {
      const toggles = {
        recordConference: record,
        announceJoinLeave,
        announceUserCount,
        startMuted,
        musicOnHoldWhenEmpty: mohWhenEmpty,
        waitForAdmin,
        endWhenAdminLeaves,
        ...(isSuper && applyNow ? { applyNow: true } : {}),
      };
      let message: string | undefined;
      if (mode === "create") {
        const res = await apiPost<{ message?: string }>("/voice/conferences", {
          name: name.trim(),
          ...(extension.trim() ? { extension: extension.trim() } : {}),
          ...(userPin.trim() ? { userPin: userPin.trim() } : {}),
          ...(adminPin.trim() ? { adminPin: adminPin.trim() } : {}),
          ...(maxMembers > 0 ? { maxMembers } : {}),
          ...toggles,
        });
        message = res?.message;
      } else {
        const res = await apiPatch<{ message?: string }>(
          `/voice/conferences/${encodeURIComponent(room!.extension)}`,
          {
            name: name.trim(),
            // Empty = clear the PIN (open room); the route reads null as clear.
            userPin: userPin.trim() ? userPin.trim() : null,
            ...(adminPin.trim() ? { adminPin: adminPin.trim() } : room?.adminPin === "•••" ? {} : { adminPin: null }),
            maxMembers: maxMembers > 0 ? maxMembers : null,
            ...toggles,
          },
        );
        message = res?.message;
      }
      onSaved(message || name.trim());
      onClose();
    } catch (e: any) {
      setErr(e?.body?.message || e?.body?.detail || e?.message || t("Couldn't save the room."));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "create" ? t("New conference room") : t("Edit conference room");

  return (
    <div className="qb-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="qb-modal">
        <header className="qb-modal-h">
          <h2>{title}</h2>
          <button type="button" className="qb-ctl-x" onClick={onClose} aria-label={t("Cancel")}>
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="qb-modal-body">
          <p className="qb-hint">{t("A number anyone on your phone system can dial to meet.")}</p>

          <Field label={t("Room name")} hint={t("Sales stand-up, Vendors, Family — whatever you'll call the meeting.")}>
            <input className="qb-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>

          {mode === "create" ? (
            <Field label={t("Room number")} hint={t("Leave blank and we pick the next free one (700, 701, …).")}>
              <input
                className="qb-input"
                value={extension}
                onChange={(e) => setExtension(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="700"
              />
            </Field>
          ) : (
            <Field label={t("Room number")} hint={t("The room's number can't change after it's made.")}>
              <input className="qb-input" value={room!.extension} disabled />
            </Field>
          )}

          <div className="qb-fieldrow">
            <Field label={t("Participant PIN")} hint={t("3–10 digits, or leave blank for an open room.")}>
              <input
                className="qb-input"
                value={userPin}
                onChange={(e) => setUserPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
                inputMode="numeric"
              />
            </Field>
            <Field label={t("Host PIN")} hint={t("Whoever enters this PIN runs the meeting. Must be different from the participant PIN.")}>
              <input
                className="qb-input"
                value={adminPin}
                onChange={(e) => setAdminPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
                inputMode="numeric"
                placeholder={room?.adminPin === "•••" ? "•••" : undefined}
              />
            </Field>
          </div>

          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
            <span>{t("Record the meeting")}</span>
          </label>
          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={announceJoinLeave} onChange={(e) => setAnnounceJoinLeave(e.target.checked)} />
            <span>{t("Play a beep when someone joins or leaves")}</span>
          </label>
          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={announceUserCount} onChange={(e) => setAnnounceUserCount(e.target.checked)} />
            <span>{t("Say how many people are on when someone joins")}</span>
          </label>
          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={startMuted} onChange={(e) => setStartMuted(e.target.checked)} />
            <span>{t("Everyone joins muted (the host unmutes)")}</span>
          </label>
          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={mohWhenEmpty} onChange={(e) => setMohWhenEmpty(e.target.checked)} />
            <span>{t("Play music until the host arrives")}</span>
          </label>
          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={waitForAdmin} onChange={(e) => setWaitForAdmin(e.target.checked)} />
            <span>{t("Wait for the host before the meeting starts")}</span>
          </label>
          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={endWhenAdminLeaves} onChange={(e) => setEndWhenAdminLeaves(e.target.checked)} />
            <span>{t("End the meeting when the host hangs up")}</span>
          </label>

          <Field label={t("Most people allowed on the call")} hint={t("0 means no limit")}>
            <input
              className="qb-input cf-input-narrow"
              type="number"
              min={0}
              max={500}
              value={maxMembers}
              onChange={(e) => setMaxMembers(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
            />
          </Field>

          {isSuper && (
            <label className="qb-check qb-check-row">
              <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} />
              <span>{t("Turn it on now (applies phone-system changes)")}</span>
            </label>
          )}

          {err && <p className="qb-notice qb-notice-warn">{err}</p>}
        </div>

        <footer className="qb-modal-f">
          <button type="button" className="qb-btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className="qb-btn qb-btn-primary" onClick={submit} disabled={saving}>
            {saving ? t("Saving…") : mode === "create" ? t("Create room") : t("Save changes")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="qb-field">
      <label className="qb-label">{label}</label>
      {children}
      {hint && <p className="qb-hint">{hint}</p>}
    </div>
  );
}
