"use client";

// ── First-time setup ─────────────────────────────────────────────────────────
//
// Someone who has just paid should not meet the full Studio. This asks five
// questions, one per screen, and builds a working menu from the answers — the
// Ring-style walkthrough Izzy asked for.
//
// Rules it follows, and why:
//
//   • ONE question per screen. Two is a form, and a form is what we're avoiding.
//   • Skippable on every screen. Someone who wants to explore should not be
//     trapped, and a half-finished menu is worse than the honest default of
//     "ring the owner".
//   • Nothing is written until the last screen. Backing out leaves no debris.
//   • The last screen reads the whole thing back in plain English, using the
//     same wording the assistant and the Studio use — so all three describe the
//     call identically.
//   • It never publishes. The customer presses "Turn it on", exactly like the
//     Studio's Publish, so the moment callers are affected is always a
//     deliberate human action.

import { useMemo, useState } from "react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { KIND_LABEL, type MenuChoiceKind, type TenantDirectory } from "@connect/shared";

/** Registered up front so the whole walkthrough arrives translated at once,
 *  rather than switching to Yiddish a screen at a time.
 *
 *  The read-back on the last screen is written as short fragments with names
 *  interpolated between them, rather than one sentence with a placeholder,
 *  because Yiddish reads right-to-left and a fixed placeholder position would
 *  put the name in the wrong place. */
const PHRASES = [
  "When someone calls, what should they hear first?", "You can change any of this later.",
  "A short greeting", "“Thanks for calling Acme.” Then the call goes through.",
  "Ring straight away", "No recording - the phone just rings, like a normal call.",
  "Who should answer?", "One person, or a group of phones ringing together.",
  "Pick the person who picks up the phone.",
  "One person", "Rings their phone. If they don't pick up it goes to voicemail.",
  "A group", "Several phones ring at once. Whoever's free answers.",
  "Which group?", "Which person?", "Whose voicemail?", "That'll be",
  "What if nobody picks up?", "Everyone misses calls. This is where those callers go.",
  "Take a message", "They hear voicemail and can leave a message.",
  "End the call politely", "No voicemail. Use this if nobody checks messages.",
  "When are you open?", "Outside these hours callers go straight to voicemail.",
  "Always", "Calls come through at any time of day.",
  "Normal business hours", "Monday to Friday, 9 to 5. You can fine-tune this later.",
  "That's your phone system",
  "Here's what happens when someone calls", "Here's what happens when someone calls this number",
  "They hear a short greeting, then we ring", "We ring", "straight away.",
  "If nobody picks up, the call ends politely.",
  "If nobody picks up, they reach voicemail.",
  "If nobody picks up, they reach the voicemail for",
  "Outside Monday-Friday 9-5, callers go straight to voicemail.",
  "your team", "whoever you choose", "extension",
  "Back", "Next", "Turn it on", "Setting it up...",
  "Skip - I'll set this up myself",
];

export interface FirstRunAnswers {
  /** What callers hear first. */
  opening: "greeting" | "straight";
  /** Who the call goes to when there's no menu, or on key 1. */
  answerKind: MenuChoiceKind;
  answerTarget: string;
  /** Where callers land if nobody picks up. */
  fallbackKind: MenuChoiceKind;
  fallbackTarget: string;
  /** Skipped = always open. */
  hours: "always" | "weekdays" | "custom";
}

const DEFAULTS: FirstRunAnswers = {
  opening: "greeting",
  answerKind: "person",
  answerTarget: "",
  fallbackKind: "voicemail",
  fallbackTarget: "",
  hours: "always",
};

export function FirstRunSetup({
  directory,
  phoneNumber,
  busy,
  onFinish,
  onSkip,
}: {
  directory: TenantDirectory;
  phoneNumber: string | null;
  busy?: boolean;
  onFinish: (a: FirstRunAnswers) => void;
  onSkip: () => void;
}) {
  const { t } = useUiLanguage(PHRASES);
  const [i, setI] = useState(0);
  const [a, setA] = useState<FirstRunAnswers>(DEFAULTS);
  const set = (patch: Partial<FirstRunAnswers>) => setA((prev) => ({ ...prev, ...patch }));

  const people = directory.people;
  const teams = directory.teams;
  const hasTeams = teams.length > 0;

  // Pre-select the only sensible answer when there IS only one, so a one-person
  // business isn't asked to choose from a list of one.
  const soleExtension = people.length === 1 ? people[0].extension : "";

  const answerName = useMemo(() => {
    if (a.answerKind === "team") return teams.find((x) => x.number === a.answerTarget)?.name ?? t("your team");
    const p = people.find((x) => x.extension === (a.answerTarget || soleExtension));
    return p?.name || (a.answerTarget ? `${t("extension")} ${a.answerTarget}` : t("whoever you choose"));
  }, [a.answerKind, a.answerTarget, people, teams, soleExtension, t]);

  /** The person whose mailbox takes the message, or null when we only know it
   *  is voicemail — the read-back below says a different sentence for each. */
  const fallbackPerson = useMemo(() => {
    const p = people.find((x) => x.extension === (a.fallbackTarget || soleExtension));
    return p?.name || null;
  }, [a.fallbackTarget, people, soleExtension]);

  const screens = [
    {
      title: t("When someone calls, what should they hear first?"),
      sub: t("You can change any of this later."),
      body: (
        <>
          <Option on={a.opening === "greeting"} glyph="🔊" title={t("A short greeting")}
            desc={t("“Thanks for calling Acme.” Then the call goes through.")}
            onClick={() => set({ opening: "greeting" })} />
          <Option on={a.opening === "straight"} glyph="📞" title={t("Ring straight away")}
            desc={t("No recording - the phone just rings, like a normal call.")}
            onClick={() => set({ opening: "straight" })} />
        </>
      ),
      canGo: true,
    },
    {
      title: t("Who should answer?"),
      sub: t(hasTeams ? "One person, or a group of phones ringing together." : "Pick the person who picks up the phone."),
      body: (
        <>
          <Option on={a.answerKind === "person"} glyph="👤" title={t("One person")}
            desc={t("Rings their phone. If they don't pick up it goes to voicemail.")}
            onClick={() => set({ answerKind: "person", answerTarget: soleExtension })} />
          {hasTeams && (
            <Option on={a.answerKind === "team"} glyph="👥" title={t("A group")}
              desc={t("Several phones ring at once. Whoever's free answers.")}
              onClick={() => set({ answerKind: "team", answerTarget: "" })} />
          )}
          <Picker
            label={t(a.answerKind === "team" ? "Which group?" : "Which person?")}
            onlyLabel={t("That'll be")}
            options={a.answerKind === "team"
              // `tm`, not `t` — `t` is the translator in this scope and shadowing
              // it here would silently leave this whole branch in English.
              ? teams.map((tm) => ({ id: tm.number, name: tm.name || `${t("A group")} ${tm.number}`, meta: tm.number }))
              : people.map((p) => ({ id: p.extension, name: p.name || `${t("extension")} ${p.extension}`, meta: p.extension }))}
            value={a.answerTarget || (a.answerKind === "person" ? soleExtension : "")}
            onChange={(v) => set({ answerTarget: v })}
          />
        </>
      ),
      canGo: Boolean(a.answerTarget || (a.answerKind === "person" && soleExtension)),
    },
    {
      title: t("What if nobody picks up?"),
      sub: t("Everyone misses calls. This is where those callers go."),
      body: (
        <>
          <Option on={a.fallbackKind === "voicemail"} glyph="📼" title={t("Take a message")}
            desc={t("They hear voicemail and can leave a message.")}
            onClick={() => set({ fallbackKind: "voicemail" })} />
          <Option on={a.fallbackKind === "hangup"} glyph="⛔" title={t("End the call politely")}
            desc={t("No voicemail. Use this if nobody checks messages.")}
            onClick={() => set({ fallbackKind: "hangup", fallbackTarget: "" })} />
          {a.fallbackKind === "voicemail" && (
            <Picker
              label={t("Whose voicemail?")}
              onlyLabel={t("That'll be")}
              options={people.map((p) => ({ id: p.extension, name: p.name || `Extension ${p.extension}`, meta: p.extension }))}
              value={a.fallbackTarget || soleExtension}
              onChange={(v) => set({ fallbackTarget: v })}
            />
          )}
        </>
      ),
      canGo: a.fallbackKind === "hangup" || Boolean(a.fallbackTarget || soleExtension),
    },
    {
      title: t("When are you open?"),
      sub: t("Outside these hours callers go straight to voicemail."),
      body: (
        <>
          <Option on={a.hours === "always"} glyph="🕐" title={t("Always")}
            desc={t("Calls come through at any time of day.")}
            onClick={() => set({ hours: "always" })} />
          <Option on={a.hours === "weekdays"} glyph="📅" title={t("Normal business hours")}
            desc={t("Monday to Friday, 9 to 5. You can fine-tune this later.")}
            onClick={() => set({ hours: "weekdays" })} />
        </>
      ),
      canGo: true,
    },
    {
      title: t("That's your phone system"),
      sub: phoneNumber
        ? `${t("Here's what happens when someone calls this number")} ${phoneNumber}:`
        : `${t("Here's what happens when someone calls")}:`,
      body: (
        <div className="fr-readback">
          {a.opening === "greeting"
            ? <>{t("They hear a short greeting, then we ring")} <b>{answerName}</b>.</>
            : <>{t("We ring")} <b>{answerName}</b> {t("straight away.")}</>}
          <br />
          {a.fallbackKind === "hangup"
            ? <>{t("If nobody picks up, the call ends politely.")}</>
            : fallbackPerson
              ? <>{t("If nobody picks up, they reach the voicemail for")} <b>{fallbackPerson}</b>.</>
              : <>{t("If nobody picks up, they reach voicemail.")}</>}
          {a.hours === "weekdays" && <><br />{t("Outside Monday-Friday 9-5, callers go straight to voicemail.")}</>}
        </div>
      ),
      canGo: true,
    },
  ];

  const s = screens[i];
  const last = i === screens.length - 1;

  return (
    <div className="fr-backdrop">
      <div className="fr-card">
        <div className="fr-body">
          <h3>{s.title}</h3>
          <p className="fr-sub">{s.sub}</p>
          <div className="fr-options">{s.body}</div>
        </div>

        <div className="fr-foot">
          <div className="fr-dots" aria-hidden>
            {screens.map((_, n) => <i key={n} className={n === i ? "on" : ""} />)}
          </div>
          <div className="fr-actions">
            {i > 0 && <button className="fr-btn" onClick={() => setI(i - 1)} disabled={busy}>{t("Back")}</button>}
            {last ? (
              <button className="fr-btn primary" disabled={busy} onClick={() => onFinish(a)}>
                {t(busy ? "Setting it up..." : "Turn it on")}
              </button>
            ) : (
              <button className="fr-btn primary" disabled={!s.canGo || busy} onClick={() => setI(i + 1)}>{t("Next")}</button>
            )}
          </div>
          <button className="fr-skip" onClick={onSkip} disabled={busy}>
            {t("Skip - I'll set this up myself")}
          </button>
        </div>
      </div>
      <FirstRunStyles />
    </div>
  );
}

function Option({ on, glyph, title, desc, onClick }: { on: boolean; glyph: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button className={"fr-opt" + (on ? " on" : "")} onClick={onClick} type="button">
      <span className="fr-glyph" aria-hidden>{glyph}</span>
      <span className="fr-opt-text"><b>{title}</b><span>{desc}</span></span>
    </button>
  );
}

function Picker({ label, onlyLabel, options, value, onChange }: {
  label: string;
  /** Leading words for the one-option case, already translated by the caller. */
  onlyLabel: string;
  options: { id: string; name: string; meta: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  // One option is not a choice — say who it is instead of asking.
  if (options.length === 1) {
    return <p className="fr-only">{onlyLabel} <b>{options[0].name}</b>.</p>;
  }
  return (
    <div className="fr-picker">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.meta}</option>)}
      </select>
    </div>
  );
}

function FirstRunStyles() {
  return (
    <style jsx global>{`
      .fr-backdrop{position:fixed;inset:0;background:rgba(6,12,20,.55);display:grid;place-items:center;padding:20px;z-index:90}
      .fr-card{background:var(--panel,#fff);border:1px solid var(--line,rgba(19,32,48,.13));border-radius:18px;
        width:min(520px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 30px 70px -30px rgba(0,0,0,.45)}
      .fr-body{padding:30px 28px 8px;overflow:auto;text-align:center}
      .fr-body h3{font-size:21px;font-weight:710;margin:0 0 7px;letter-spacing:-.015em;line-height:1.25}
      .fr-sub{color:var(--dim,#5d6f84);font-size:14.5px;margin:0 0 20px;line-height:1.55}
      .fr-options{display:flex;flex-direction:column;gap:10px;text-align:left}
      .fr-opt{display:flex;gap:14px;align-items:center;padding:15px;border-radius:14px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);font:inherit;
        color:inherit;transition:.14s;text-align:left}
      .fr-opt:hover{border-color:var(--accent,#2f6bff)}
      .fr-opt.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08))}
      .fr-glyph{font-size:24px;flex:none}
      .fr-opt-text b{display:block;font-size:15px;font-weight:660}
      .fr-opt-text span{display:block;font-size:12.5px;color:var(--dim,#5d6f84);margin-top:2px;line-height:1.5}
      .fr-picker{margin-top:6px}
      .fr-picker label{display:block;font-size:12px;font-weight:640;color:var(--dim,#5d6f84);margin-bottom:6px}
      .fr-picker select{width:100%;font:inherit;font-size:14px;padding:11px 12px;border-radius:11px;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .fr-only{font-size:13.5px;color:var(--dim,#5d6f84);margin:4px 0 0}
      .fr-readback{text-align:left;border:1px solid var(--line,rgba(19,32,48,.13));border-radius:13px;
        padding:16px;background:var(--panel-2,#f6f9fc);font-size:14.5px;line-height:1.75}
      .fr-foot{padding:16px 28px 22px;border-top:1px solid var(--line-soft,rgba(19,32,48,.07));text-align:center}
      .fr-dots{display:flex;gap:6px;justify-content:center;margin-bottom:14px}
      .fr-dots i{width:6px;height:6px;border-radius:50%;background:var(--line,rgba(19,32,48,.2));display:block;transition:.2s}
      .fr-dots i.on{background:var(--accent,#2f6bff);width:18px;border-radius:99px}
      .fr-actions{display:flex;gap:10px;justify-content:center}
      .fr-btn{font:inherit;font-size:14.5px;font-weight:650;padding:12px 22px;border-radius:11px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .fr-btn.primary{background:var(--accent,#2f6bff);border-color:var(--accent,#2f6bff);color:#fff}
      .fr-btn:disabled{opacity:.5;cursor:not-allowed}
      .fr-skip{margin-top:14px;background:none;border:none;font:inherit;font-size:12.5px;
        color:var(--faint,#94a3b8);text-decoration:underline;cursor:pointer}
    `}</style>
  );
}
