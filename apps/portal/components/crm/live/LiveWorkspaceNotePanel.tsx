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
    <CRMCard padding="md">
      <CRMSection title="Call note" description="Saved to timeline immediately.">
        <textarea
          ref={ref}
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
          placeholder="Type your call note…"
          rows={4}
          disabled={disabled}
          className={crm.input}
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
