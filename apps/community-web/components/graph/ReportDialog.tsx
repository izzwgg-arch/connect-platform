"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Dialog, useToast } from "@/components/ui";

export type ReportTargetType = "person" | "organization" | "post" | "comment" | "message" | "job" | "listing" | "rfq" | "event" | "group";

const REASONS: Array<{ value: string; label: string }> = [
  { value: "SPAM", label: "Spam" },
  { value: "SCAM", label: "Scam or fraud" },
  { value: "HARASSMENT", label: "Harassment" },
  { value: "IMPERSONATION", label: "Impersonation" },
  { value: "PHISHING", label: "Phishing" },
  { value: "MALWARE", label: "Malware or unsafe link" },
  { value: "FAKE_JOB", label: "Fake job posting" },
  { value: "FAKE_COMPANY", label: "Fake business" },
  { value: "FAKE_REVIEW", label: "Fake review" },
  { value: "BOT", label: "Bot / automated account" },
  { value: "MASS_SOLICITATION", label: "Mass unsolicited outreach" },
  { value: "OTHER", label: "Something else" },
];

/** Reusable report flow for any reportable object — never notifies the reported party. */
export function ReportDialog({
  open,
  onClose,
  targetType,
  targetId,
  testId = "report",
}: {
  open: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: string;
  testId?: string;
}) {
  const [reason, setReason] = useState("SPAM");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await api("/reports", { method: "POST", body: { targetType, targetId, reason, details: details.trim() || undefined } });
      toast("Thanks — we'll take a look.");
      setDetails("");
      onClose();
    } catch (e: any) {
      toast(e?.message ?? "Couldn't send that report.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Report"
      footer={
        <>
          <Button kind="g" onClick={onClose} data-testid={`${testId}-cancel`}>
            Cancel
          </Button>
          <Button kind="p" loading={busy} onClick={() => void submit()} data-testid={`${testId}-submit`}>
            Submit report
          </Button>
        </>
      }
    >
      <div className="field">
        <label className="lbl" htmlFor={`${testId}-reason`}>
          Reason
        </label>
        <select id={`${testId}-reason`} className="in" value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`${testId}-reason`}>
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label className="lbl" htmlFor={`${testId}-details`}>
          Details (optional)
        </label>
        <textarea id={`${testId}-details`} className="in" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} data-testid={`${testId}-details`} />
      </div>
      <p className="sm dim" style={{ marginTop: 8 }}>
        They won't be told you reported them.
      </p>
    </Dialog>
  );
}
