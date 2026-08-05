"use client";

// ── Which number rings this menu, when — and what plays first ────────────────
//
// The map's top step used to be a label. Now it's the control Izzy asked for:
//
//   • pick which phone number reaches this menu, or "No phone number" for a
//     menu opened from another menu;
//   • choose WHEN the switch happens — exactly two options, on his
//     instruction: right now (at publish) or a date and time. The end is
//     "never" or "on a date", after which calls go back to exactly how they
//     were routed before;
//   • optionally book an announcement that plays BEFORE the menu ("we're
//     closed Thursday for the holiday"), with the same start/stop choices.
//
// Two promises this screen keeps, stated because they are the whole safety
// story:
//   • Every number row says what the number does RIGHT NOW. Nobody takes over
//     a line without being told what they're taking it from.
//   • Choosing a number changes nothing for callers. The flip happens at
//     Publish (or at the booked moment) — the Publish button's label says
//     which.

import { useEffect, useMemo, useState } from "react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";

/** Registered up front so the whole screen arrives translated at once. */
const PHRASES = [
  "Which phone number should reach this menu?",
  "Nothing changes for callers until you press Publish.",
  "No phone number", "Callers reach this menu from another menu",
  "When should this number start using this menu?",
  "Start right now", "Pick a date and time",
  "When should it start?", "When should it stop?", "Never - keep it", "On a date",
  "If you set an end date, calls go back to exactly how they were before.",
  "Play an announcement first",
  "A short message callers hear before the menu - for holidays or emergencies.",
  "No announcement", "Which recording?",
  "It plays before the menu on every call until it stops.",
  "Save choice", "Cancel", "Loading your numbers...",
  "No numbers are set up for this customer yet.",
  "The last switch of this number failed - picking it again will retry.",
  "Pick a date and time first.",
  "The end date has to be after the start date.",
  "Pick which recording to play first.",
];

export interface TenantNumber {
  mappingId: string;
  e164: string;
  routingMode: "pbx" | "connect";
  ivrProfileId: string | null;
  ivrProfileName: string | null;
  currentlyLabel: string;
  pendingSwitch: { id: string; ivrProfileId: string; activateAt: string; endAt: string | null } | null;
  /** Set when the most recent switch attempt failed — cleared by a success. */
  lastSwitchError?: string | null;
  lastSwitchedAt?: string | null;
}

/** What the page carries until Publish. */
export interface NumberPlan {
  mappingId: string;
  e164: string;
  /** "now" = flip when Publish is pressed; else an ISO datetime. */
  when: "now" | string;
  endAt: string | null;
}

export interface AnnouncementPlan {
  promptRef: string;
  /** "now" or an ISO datetime. */
  startAt: "now" | string;
  endAt: string | null;
}

export function fmtUs(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return e164;
}

export function NumberStep({
  numbers,
  loading,
  loadError,
  currentProfileId,
  recordings,
  onSave,
  onClose,
}: {
  numbers: TenantNumber[];
  loading: boolean;
  loadError: string | null;
  currentProfileId: string;
  recordings: Array<{ promptRef: string; displayName: string }>;
  /** numberPlan null = "no phone number"; announcement null = none booked here. */
  onSave: (numberPlan: NumberPlan | null, announcement: AnnouncementPlan | null) => void;
  onClose: () => void;
}) {
  const { t } = useUiLanguage(PHRASES);

  // Pre-select the number already pointing (or booked to point) at this menu.
  const initial = useMemo(
    () => numbers.find((n) => n.ivrProfileId === currentProfileId || n.pendingSwitch?.ivrProfileId === currentProfileId) ?? null,
    [numbers, currentProfileId],
  );
  const [picked, setPicked] = useState<string | null>(initial ? initial.mappingId : null);
  const [none, setNone] = useState<boolean>(!initial);
  useEffect(() => { setPicked(initial ? initial.mappingId : null); setNone(!initial); }, [initial]);

  // Exactly two options each, per Izzy: now, or a date and time.
  const [whenKind, setWhenKind] = useState<"now" | "custom">("now");
  const [whenDate, setWhenDate] = useState("");
  const [whenTime, setWhenTime] = useState("09:00");
  const [endKind, setEndKind] = useState<"never" | "date">("never");
  const [endDate, setEndDate] = useState("");

  const [annOn, setAnnOn] = useState(false);
  const [annRef, setAnnRef] = useState("");
  const [annWhenKind, setAnnWhenKind] = useState<"now" | "custom">("now");
  const [annDate, setAnnDate] = useState("");
  const [annTime, setAnnTime] = useState("09:00");
  const [annEndKind, setAnnEndKind] = useState<"never" | "date">("never");
  const [annEndDate, setAnnEndDate] = useState("");

  const [err, setErr] = useState<string | null>(null);

  function resolveWhen(kind: "now" | "custom", date: string, time: string): "now" | string | null {
    if (kind === "now") return "now";
    if (!date || !time) return null;
    return new Date(`${date}T${time}`).toISOString();
  }
  /** End of that business day, local time — "it ends that day". */
  function resolveEnd(kind: "never" | "date", date: string): string | null | undefined {
    if (kind === "never") return null;
    if (!date) return undefined; // undefined = invalid
    return new Date(`${date}T23:59`).toISOString();
  }

  function save() {
    setErr(null);

    let numberPlan: NumberPlan | null = null;
    if (!none) {
      const row = numbers.find((n) => n.mappingId === picked);
      if (!row) { setErr(t("Pick a date and time first.")); return; }
      const when = resolveWhen(whenKind, whenDate, whenTime);
      if (!when) { setErr(t("Pick a date and time first.")); return; }
      const endAt = resolveEnd(endKind, endDate);
      if (endAt === undefined) { setErr(t("Pick a date and time first.")); return; }
      const startMs = when === "now" ? Date.now() : new Date(when).getTime();
      if (endAt && new Date(endAt).getTime() <= startMs) { setErr(t("The end date has to be after the start date.")); return; }
      numberPlan = { mappingId: row.mappingId, e164: row.e164, when, endAt };
    }

    let announcement: AnnouncementPlan | null = null;
    if (annOn) {
      if (!annRef) { setErr(t("Pick which recording to play first.")); return; }
      const startAt = resolveWhen(annWhenKind, annDate, annTime);
      if (!startAt) { setErr(t("Pick a date and time first.")); return; }
      const endAt = resolveEnd(annEndKind, annEndDate);
      if (endAt === undefined) { setErr(t("Pick a date and time first.")); return; }
      const startMs = startAt === "now" ? Date.now() : new Date(startAt).getTime();
      if (endAt && new Date(endAt).getTime() <= startMs) { setErr(t("The end date has to be after the start date.")); return; }
      announcement = { promptRef: annRef, startAt, endAt };
    }

    onSave(numberPlan, announcement);
  }

  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card" onClick={(e) => e.stopPropagation()}>
        <div className="ns-head">
          <div>
            <h3>{t("Which phone number should reach this menu?")}</h3>
            <p>{t("Nothing changes for callers until you press Publish.")}</p>
          </div>
          <button className="ns-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ns-body">
          {loading && <p className="ns-dim">{t("Loading your numbers...")}</p>}
          {loadError && <div className="ns-err">{loadError}</div>}

          {!loading && !loadError && (
            <>
              {numbers.map((n) => (
                <button
                  key={n.mappingId}
                  className={"ns-row" + (!none && picked === n.mappingId ? " on" : "")}
                  onClick={() => { setNone(false); setPicked(n.mappingId); }}
                >
                  <span className="ns-glyph" aria-hidden>☎️</span>
                  <span className="ns-txt">
                    <b>{fmtUs(n.e164)}</b>
                    <span>{n.currentlyLabel}</span>
                    {n.lastSwitchError && n.routingMode !== "connect" && (
                      <span className="ns-warn">⚠ {t("The last switch of this number failed - picking it again will retry.")}</span>
                    )}
                  </span>
                  {!none && picked === n.mappingId && <span className="ns-check" aria-hidden>✓</span>}
                </button>
              ))}
              {numbers.length === 0 && <p className="ns-dim">{t("No numbers are set up for this customer yet.")}</p>}

              <button className={"ns-row" + (none ? " on" : "")} onClick={() => setNone(true)}>
                <span className="ns-glyph" aria-hidden>↪️</span>
                <span className="ns-txt">
                  <b>{t("No phone number")}</b>
                  <span>{t("Callers reach this menu from another menu")}</span>
                </span>
                {none && <span className="ns-check" aria-hidden>✓</span>}
              </button>

              {!none && picked && (
                <>
                  <div className="ns-lbl">{t("When should this number start using this menu?")}</div>
                  <div className="ns-chips">
                    <Chip on={whenKind === "now"} label={t("Start right now")} onClick={() => setWhenKind("now")} />
                    <Chip on={whenKind === "custom"} label={t("Pick a date and time")} onClick={() => setWhenKind("custom")} />
                  </div>
                  {whenKind === "custom" && (
                    <div className="ns-dt">
                      <input type="date" value={whenDate} onChange={(e) => setWhenDate(e.target.value)} />
                      <input type="time" value={whenTime} onChange={(e) => setWhenTime(e.target.value)} />
                    </div>
                  )}

                  <div className="ns-lbl">{t("When should it stop?")}</div>
                  <div className="ns-chips">
                    <Chip on={endKind === "never"} label={t("Never - keep it")} onClick={() => setEndKind("never")} />
                    <Chip on={endKind === "date"} label={t("On a date")} onClick={() => setEndKind("date")} />
                  </div>
                  {endKind === "date" && (
                    <div className="ns-dt">
                      <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                    </div>
                  )}
                  <p className="ns-fine">{t("If you set an end date, calls go back to exactly how they were before.")}</p>
                </>
              )}

              <div className="ns-lbl">{t("Play an announcement first")}</div>
              <p className="ns-dim" style={{ margin: "0 0 8px" }}>
                {t("A short message callers hear before the menu - for holidays or emergencies.")}
              </p>
              <div className="ns-chips">
                <Chip on={!annOn} label={t("No announcement")} onClick={() => setAnnOn(false)} />
                <Chip on={annOn} label={t("Play an announcement first")} onClick={() => setAnnOn(true)} />
              </div>

              {annOn && (
                <>
                  <div className="ns-lbl">{t("Which recording?")}</div>
                  <select className="ns-sel" value={annRef} onChange={(e) => setAnnRef(e.target.value)}>
                    <option value="">…</option>
                    {recordings.map((r) => (
                      <option key={r.promptRef} value={r.promptRef}>{r.displayName}</option>
                    ))}
                  </select>

                  <div className="ns-lbl">{t("When should it start?")}</div>
                  <div className="ns-chips">
                    <Chip on={annWhenKind === "now"} label={t("Start right now")} onClick={() => setAnnWhenKind("now")} />
                    <Chip on={annWhenKind === "custom"} label={t("Pick a date and time")} onClick={() => setAnnWhenKind("custom")} />
                  </div>
                  {annWhenKind === "custom" && (
                    <div className="ns-dt">
                      <input type="date" value={annDate} onChange={(e) => setAnnDate(e.target.value)} />
                      <input type="time" value={annTime} onChange={(e) => setAnnTime(e.target.value)} />
                    </div>
                  )}

                  <div className="ns-lbl">{t("When should it stop?")}</div>
                  <div className="ns-chips">
                    <Chip on={annEndKind === "never"} label={t("Never - keep it")} onClick={() => setAnnEndKind("never")} />
                    <Chip on={annEndKind === "date"} label={t("On a date")} onClick={() => setAnnEndKind("date")} />
                  </div>
                  {annEndKind === "date" && (
                    <div className="ns-dt">
                      <input type="date" value={annEndDate} onChange={(e) => setAnnEndDate(e.target.value)} />
                    </div>
                  )}
                  <p className="ns-fine">{t("It plays before the menu on every call until it stops.")}</p>
                </>
              )}

              {err && <div className="ns-err">{err}</div>}
            </>
          )}
        </div>

        <div className="ns-foot">
          <button className="ns-btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="ns-btn primary" onClick={save} disabled={loading || (!none && !picked)}>
            {t("Save choice")}
          </button>
        </div>
      </div>
      <NumberStepStyles />
    </div>
  );
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button className={"ns-chip" + (on ? " on" : "")} onClick={onClick} type="button">{label}</button>
  );
}

function NumberStepStyles() {
  return (
    <style jsx global>{`
      .ns-backdrop{position:fixed;inset:0;background:rgba(6,12,20,.55);display:grid;place-items:center;padding:20px;z-index:95}
      .ns-card{background:var(--panel,#fff);border:1px solid var(--line,rgba(19,32,48,.13));border-radius:18px;
        width:min(560px,100%);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 30px 70px -30px rgba(0,0,0,.45);color:inherit}
      .ns-head{display:flex;justify-content:space-between;gap:12px;padding:22px 24px 0}
      .ns-head h3{font-size:18px;font-weight:700;margin:0;letter-spacing:-.015em}
      .ns-head p{margin:6px 0 0;font-size:13.5px;color:var(--dim,#5d6f84);line-height:1.55}
      .ns-x{background:none;border:none;font-size:26px;line-height:1;color:var(--faint,#94a3b8);cursor:pointer;padding:0 4px}
      .ns-body{padding:18px 24px 6px;overflow:auto}
      .ns-row{display:flex;gap:12px;align-items:center;width:100%;text-align:left;font:inherit;color:inherit;
        padding:13px 14px;margin-bottom:8px;border-radius:12px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc)}
      .ns-row:hover{border-color:var(--accent,#2f6bff)}
      .ns-row.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08))}
      .ns-glyph{font-size:20px;flex:none}
      .ns-txt{flex:1;min-width:0}
      .ns-txt b{display:block;font-size:14.5px;font-weight:660}
      .ns-txt span{display:block;font-size:12.5px;color:var(--dim,#5d6f84);margin-top:2px}
      .ns-txt .ns-warn{color:#c9414c;font-weight:600}
      .ns-check{color:var(--accent,#2f6bff);font-weight:800}
      .ns-lbl{font-size:12px;font-weight:660;color:var(--dim,#5d6f84);margin:18px 0 8px}
      .ns-chips{display:flex;gap:7px;flex-wrap:wrap}
      .ns-chip{font:inherit;font-size:13px;font-weight:620;padding:9px 14px;border-radius:10px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:inherit}
      .ns-chip.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08));color:var(--accent,#2f6bff)}
      .ns-dt{display:flex;gap:8px;margin-top:9px}
      .ns-dt input{font:inherit;font-size:14px;padding:10px 12px;border-radius:10px;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .ns-sel{width:100%;font:inherit;font-size:14px;padding:10px 12px;border-radius:10px;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .ns-fine{font-size:12px;color:var(--faint,#94a3b8);line-height:1.55;margin:10px 0 0}
      .ns-err{margin-top:12px;padding:11px 13px;border-radius:11px;font-size:13px;line-height:1.55;
        color:#c9414c;background:rgba(201,65,76,.08);border:1px solid rgba(201,65,76,.28)}
      .ns-dim{font-size:13px;color:var(--dim,#5d6f84)}
      .ns-foot{display:flex;gap:10px;justify-content:flex-end;padding:16px 24px 20px;
        border-top:1px solid var(--line-soft,rgba(19,32,48,.07))}
      .ns-btn{font:inherit;font-size:14px;font-weight:650;padding:11px 20px;border-radius:11px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .ns-btn.primary{background:var(--accent,#2f6bff);border-color:var(--accent,#2f6bff);color:#fff}
      .ns-btn:disabled{opacity:.5;cursor:not-allowed}
    `}</style>
  );
}
