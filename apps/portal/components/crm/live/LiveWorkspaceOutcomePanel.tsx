"use client";

import type { ReactNode } from "react";
import { CalendarClock, CheckCheck } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { STAGE_OPTIONS } from "../contact/contactFormatters";
import type { CrmStage, LiveContact } from "./liveTypes";
import { DISPOSITION_OPTIONS } from "./liveTypes";

export function LiveWorkspaceOutcomePanel({
  id,
  contact,
  disposition,
  setDisposition,
  outcomeNote,
  setOutcomeNote,
  followUpOption,
  setFollowUpOption,
  followUpCustom,
  setFollowUpCustom,
  nextStage,
  setNextStage,
  savingOutcome,
  outcomeSaved,
  outcomeError,
  isPowerMode,
  onSave,
  disabled,
}: {
  id?: string;
  contact: LiveContact | null;
  disposition: string;
  setDisposition: (v: string) => void;
  outcomeNote: string;
  setOutcomeNote: (v: string) => void;
  followUpOption: "" | "today" | "tomorrow" | "nextweek" | "custom";
  setFollowUpOption: (v: "" | "today" | "tomorrow" | "nextweek" | "custom") => void;
  followUpCustom: string;
  setFollowUpCustom: (v: string) => void;
  nextStage: CrmStage | "";
  setNextStage: (v: CrmStage | "") => void;
  savingOutcome: boolean;
  outcomeSaved: boolean;
  outcomeError: string;
  isPowerMode: boolean;
  onSave: () => void;
  disabled?: boolean;
}) {
  const stage = contact?.crmStage;
  const dispositionTone: Record<string, string> = {
    Answered: "border-emerald-300/70 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    "No Answer": "border-slate-300/80 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    Voicemail: "border-violet-300/80 bg-violet-500/12 text-violet-700 dark:text-violet-300",
    Callback: "border-amber-300/80 bg-amber-500/12 text-amber-700 dark:text-amber-300",
    "Not Interested": "border-rose-300/80 bg-rose-500/12 text-rose-700 dark:text-rose-300",
    Closed: "border-sky-300/80 bg-sky-500/12 text-sky-700 dark:text-sky-300",
  };

  return (
    <div id={id ?? "live-outcome-panel"} className="scroll-mt-24">
    <CRMCard padding="md" className="overflow-hidden border-crm-border/70">
      <CRMSection
        title="Call outcome"
        description="Disposition, follow-up, and optional stage advance."
      >
        <div className="space-y-4">
          <div>
            <p className={crm.label}>Disposition *</p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {DISPOSITION_OPTIONS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  disabled={disabled}
                  onClick={() => setDisposition(d)}
                  className={cn(
                    "group min-h-[4.25rem] rounded-2xl border px-3 py-2 text-left text-xs font-bold transition-all focus:outline-none focus:ring-2 focus:ring-crm-accent/40",
                    disposition === d
                      ? "border-crm-accent bg-crm-accent text-white shadow-[0_14px_30px_-22px_rgba(14,165,233,0.8)]"
                      : dispositionTone[d] ?? "border-crm-border bg-crm-surface-2/50 text-crm-muted hover:border-crm-accent/40",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className={cn(
                    "mb-2 inline-flex h-5 min-w-5 items-center justify-center rounded-md border px-1 font-mono text-[10px]",
                    disposition === d ? "border-white/35 bg-white/15 text-white" : "border-current/20 bg-white/30 dark:bg-white/5",
                  )}>{i + 1}</span>
                  <span className="block leading-tight">{d}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className={crm.label}>Advance stage (optional)</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip active={nextStage === ""} onClick={() => setNextStage("")} disabled={disabled}>
                No change
              </Chip>
              {STAGE_OPTIONS.map((s) => (
                <Chip
                  key={s.value}
                  active={nextStage === s.value}
                  onClick={() => setNextStage(s.value)}
                  disabled={disabled}
                >
                  {s.label}
                </Chip>
              ))}
            </div>
            {nextStage && stage && nextStage !== stage ? (
              <p className="mt-1 text-xs text-crm-accent">
                Stage will change on save
              </p>
            ) : null}
          </div>

          <div>
            <p className={crm.label}>Outcome note (optional)</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                "Left voicemail",
                "Requested callback",
                "Sent SMS",
                "Interested",
                "Wrong number",
              ].map((label) => (
                <button
                  key={label}
                  type="button"
                  disabled={disabled}
                  onClick={() => setOutcomeNote(outcomeNote ? outcomeNote + (outcomeNote.endsWith(" ") ? "" : " ") + label : label)}
                  className="rounded-full border border-crm-border px-2.5 py-0.5 text-[11px] text-crm-muted hover:border-crm-accent/40"
                >
                  + {label}
                </button>
              ))}
            </div>
            <textarea
              value={outcomeNote}
              onChange={(e) => setOutcomeNote(e.target.value)}
              placeholder="Add a call outcome note…"
              rows={3}
              disabled={disabled}
              className={cn(crm.input, "mt-2")}
            />
          </div>

          <div>
            <p className={cn(crm.label, "flex items-center gap-1")}>
              <CalendarClock className="h-3 w-3" />
              Follow-up (optional)
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["today", "tomorrow", "nextweek", "custom"] as const).map((opt) => (
                <Chip
                  key={opt}
                  active={followUpOption === opt}
                  onClick={() => setFollowUpOption(followUpOption === opt ? "" : opt)}
                  disabled={disabled}
                >
                  {opt === "today"
                    ? "Today"
                    : opt === "tomorrow"
                      ? "Tomorrow"
                      : opt === "nextweek"
                        ? "Next week"
                        : "Custom"}
                </Chip>
              ))}
            </div>
            {disposition === "Callback" ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[{ label: "+15m", mins: 15 }, { label: "+1h", mins: 60 }, { label: "Today 5:00p", eod: true }, { label: "Tomorrow 9:00a", tomorrow9: true }].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      const d = new Date();
                      if (opt.mins) d.setMinutes(d.getMinutes() + opt.mins);
                      if ((opt as any).eod) { d.setHours(17,0,0,0); }
                      if ((opt as any).tomorrow9) { d.setDate(d.getDate()+1); d.setHours(9,0,0,0); }
                      setFollowUpOption("custom");
                      setFollowUpCustom(d.toISOString().slice(0,16));
                    }}
                    className="rounded-full border border-crm-border px-2.5 py-0.5 text-[11px] text-crm-muted hover:border-crm-accent/40"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : null}
            {followUpOption === "custom" ? (
              <input
                type="datetime-local"
                value={followUpCustom}
                onChange={(e) => setFollowUpCustom(e.target.value)}
                disabled={disabled}
                className={cn(crm.input, "mt-2")}
              />
            ) : null}
          </div>

          {outcomeError ? <p className="text-xs text-crm-danger">{outcomeError}</p> : null}
          {outcomeSaved ? (
            <p className="flex items-center gap-1.5 text-sm font-medium text-crm-success">
              <CheckCheck className="h-4 w-4" />
              Outcome saved — contact, tasks, and timeline updated.
            </p>
          ) : null}

          <button
            type="button"
            onClick={onSave}
            disabled={!disposition || savingOutcome || disabled}
            className={cn(crm.btnPrimary, "w-full")}
          >
            {savingOutcome
              ? "Saving…"
              : isPowerMode
                ? "Save outcome & next lead →"
                : "Save outcome"}
          </button>
          {!disposition ? (
            <p className="text-center text-xs text-crm-muted">
              Select a disposition to enable save
              {isPowerMode ? " — then advances to next lead" : ""}
            </p>
          ) : null}
          {isPowerMode && !savingOutcome ? (
            <p className="text-center text-xs text-crm-muted">
              Keyboard: <kbd className="rounded border border-crm-border bg-crm-surface-2 px-1 font-mono">O</kbd> to
              save
            </p>
          ) : null}
        </div>
      </CRMSection>
    </CRMCard>
    </div>
  );
}

function Chip({
  children,
  active,
  onClick,
  disabled,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium",
        active ? "border-crm-accent bg-crm-accent/15 text-crm-accent" : "border-crm-border text-crm-muted",
      )}
    >
      {children}
    </button>
  );
}
