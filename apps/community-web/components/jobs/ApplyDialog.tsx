"use client";

import { useState } from "react";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { Button, Dialog, Field, useToast } from "@/components/ui";
import { Uploader, type UploadedAsset } from "@/components/media/Uploader";

export const APPLY_SECTIONS: Array<{ key: string; label: string; default: boolean }> = [
  { key: "headline", label: "Headline", default: true },
  { key: "about", label: "About", default: true },
  { key: "experience", label: "Experience", default: true },
  { key: "education", label: "Education", default: true },
  { key: "skills", label: "Skills", default: true },
  { key: "certifications", label: "Certifications", default: true },
  { key: "services", label: "Services", default: false },
];

/** The one "Apply with profile" flow both /jobs and /jobs/[id] use. */
export function ApplyDialog({ open, onClose, jobId, onApplied }: { open: boolean; onClose: () => void; jobId: string; onApplied: () => void }) {
  const toast = useToast();
  const [sections, setSections] = useState<Record<string, boolean>>(() => Object.fromEntries(APPLY_SECTIONS.map((s) => [s.key, s.default])));
  const [resume, setResume] = useState<UploadedAsset[]>([]);
  const [coverNote, setCoverNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const chosen = APPLY_SECTIONS.filter((s) => sections[s.key]).map((s) => s.key);
    if (!chosen.length) {
      toast("Choose at least one section to share.", { kind: "err" });
      return;
    }
    setBusy(true);
    try {
      await api(`/jobs/${jobId}/apply`, {
        method: "POST",
        body: { sections: chosen, resumeAssetId: resume[0]?.id, coverNote: coverNote.trim() || undefined },
        idempotencyKey: newIdempotencyKey(),
      });
      toast("Application sent.");
      onApplied();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't send that application.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Apply with profile"
      footer={
        <>
          <Button kind="g" onClick={onClose} data-testid="jobs-apply-cancel">
            Cancel
          </Button>
          <Button kind="p" loading={busy} onClick={() => void submit()} data-testid="jobs-apply-submit">
            Send application
          </Button>
        </>
      }
    >
      <p className="sm dim">Choose what to share — this sends a snapshot, never your live profile.</p>
      <div className="jobs-section-checklist">
        {APPLY_SECTIONS.map((s) => (
          <label key={s.key}>
            <input type="checkbox" checked={!!sections[s.key]} onChange={(e) => setSections((cur) => ({ ...cur, [s.key]: e.target.checked }))} data-testid={`jobs-apply-section-${s.key}`} />
            {s.label}
          </label>
        ))}
      </div>
      <Field label="Résumé (optional)" htmlFor="jobs-apply-resume">
        <Uploader accept="document" multiple={false} maxFiles={1} isPrivate onChange={setResume} testId="jobs-apply-resume" />
      </Field>
      <Field label="Cover note (optional)" htmlFor="jobs-apply-cover">
        <textarea id="jobs-apply-cover" className="in" rows={3} value={coverNote} onChange={(e) => setCoverNote(e.target.value)} maxLength={4000} data-testid="jobs-apply-cover" />
      </Field>
    </Dialog>
  );
}
