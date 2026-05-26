"use client";

import { forwardRef } from "react";
import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { crm } from "../crmClasses";

export const LiveWorkspaceNotePanel = forwardRef<
  HTMLTextAreaElement,
  {
    noteBody: string;
    setNoteBody: (v: string) => void;
    savingNote: boolean;
    noteSavedAt: Date | null;
    onSave: () => void;
    disabled?: boolean;
  }
>(function LiveWorkspaceNotePanel(
  { noteBody, setNoteBody, savingNote, noteSavedAt, onSave, disabled },
  ref,
) {
  return (
    <div id="live-note-panel" className="scroll-mt-24">
    <CRMCard padding="md" className="border-crm-border/70">
      <CRMSection title="Live notes" description="Fast call notes saved directly to the timeline.">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {["Left voicemail", "Requested callback", "Sent SMS", "Interested", "Wrong number"].map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => setNoteBody(noteBody ? noteBody + (noteBody.endsWith(" ") ? "" : " ") + label : label)}
              disabled={disabled}
              className="rounded-full border border-crm-border/80 bg-crm-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-crm-muted hover:border-crm-accent/40 hover:text-crm-text"
            >
              + {label}
            </button>
          ))}
        </div>
        <textarea
          ref={ref}
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
          placeholder="Type your call note…"
          rows={5}
          disabled={disabled}
          className={`${crm.input} min-h-[9rem] resize-y leading-relaxed`}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          {noteSavedAt ? (
            <span className="text-xs text-crm-success">
              Saved at {noteSavedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!noteBody.trim() || savingNote || disabled}
            className={crm.btnPrimary}
          >
            {savingNote ? "Saving…" : "Save note"}
          </button>
        </div>
      </CRMSection>
    </CRMCard>
    </div>
  );
});
