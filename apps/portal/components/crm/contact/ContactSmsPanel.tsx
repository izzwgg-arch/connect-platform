"use client";

import type { ReactNode } from "react";
import { forwardRef } from "react";
import { MessageSquareDot, Send } from "lucide-react";
import { CRMCard, CRMEmptyState, CRMSection, crm } from "..";
import { cn } from "../cn";
import type { ContactPhone, TimelineEvent } from "./contactTypes";
import { formatDateTime } from "./contactFormatters";

export const ContactSmsPanel = forwardRef<
  HTMLDivElement,
  {
    phones: ContactPhone[];
    smsEvents: TimelineEvent[];
    timelineLoading: boolean;
    isArchived: boolean;
    doNotSms: boolean;
    smsPhone: string;
    setSmsPhone: (v: string) => void;
    smsMessage: string;
    setSmsMessage: (v: string) => void;
    smsSending: boolean;
    smsError: string | null;
    smsSuccess: boolean;
    onSend: () => void;
  }
>(function ContactSmsPanel(
  {
    phones,
    smsEvents,
    timelineLoading,
    isArchived,
    doNotSms,
    smsPhone,
    setSmsPhone,
    smsMessage,
    setSmsMessage,
    smsSending,
    smsError,
    smsSuccess,
    onSend,
  },
  ref,
) {
  if (phones.length === 0) return null;

  return (
    <div ref={ref}>
      <CRMCard padding="lg" className="border-crm-accent/15 bg-crm-accent/5">
        <CRMSection
          title="SMS conversation"
          description={
            smsEvents.length > 0
              ? `${smsEvents.length} recent message${smsEvents.length !== 1 ? "s" : ""}`
              : "Text thread from timeline — no extra API"
          }
        >
          {timelineLoading ? (
            <p className="text-sm text-crm-muted">Loading…</p>
          ) : smsEvents.length === 0 ? (
            <CRMEmptyState
              icon={<MessageSquareDot className="h-7 w-7" />}
              title="No messages yet"
              description="Send the first SMS below — it appears in the timeline when delivered."
            />
          ) : (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
              {smsEvents.map((ev) => {
                const isSent = ev.type === "SMS_SENT";
                const m = ev.metadata as Record<string, unknown> | null;
                const phone = isSent
                  ? (typeof m?.to === "string" ? m.to : null)
                  : (typeof m?.from === "string" ? m.from : null);
                return (
                  <BubbleRow key={ev.id} isSent={isSent}>
                    <SmsBubble isSent={isSent} body={ev.body} />
                    <BubbleMeta phone={phone} createdAt={ev.createdAt} />
                  </BubbleRow>
                );
              })}
            </div>
          )}

          {doNotSms ? (
            <div className="mt-3 flex items-center gap-2 rounded-crm border border-crm-danger/35 bg-crm-danger/10 px-3 py-2 text-sm text-crm-danger">
              <MessageSquareDot className="h-4 w-4 shrink-0" />
              SMS disabled — contact has opted out
            </div>
          ) : isArchived ? (
            <p className="mt-3 text-sm text-crm-muted">SMS sending is disabled while archived.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {phones.length > 1 ? (
                <select
                  value={smsPhone}
                  onChange={(e) => setSmsPhone(e.target.value)}
                  className={crm.input}
                >
                  <option value="">Primary: {phones[0].numberRaw}</option>
                  {phones.map((p) => (
                    <option key={p.id} value={p.numberRaw}>
                      {p.numberRaw} ({p.type.toLowerCase()}
                      {p.isPrimary ? " · primary" : ""})
                    </option>
                  ))}
                </select>
              ) : null}
              <div className="flex gap-2">
                <textarea
                  value={smsMessage}
                  onChange={(e) => setSmsMessage(e.target.value)}
                  rows={2}
                  placeholder="Reply…"
                  maxLength={1600}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSend();
                    }
                  }}
                  className={cn(crm.input, "min-h-[4rem] flex-1 resize-none")}
                />
                <button
                  type="button"
                  onClick={onSend}
                  disabled={smsSending || !smsMessage.trim()}
                  title="Send SMS (⌘↵)"
                  className={cn(crm.btnPrimary, "self-end px-3")}
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              <SmsFooter smsMessage={smsMessage} smsSuccess={smsSuccess} smsError={smsError} />
            </div>
          )}
        </CRMSection>
      </CRMCard>
    </div>
  );
});

function BubbleRow({ children, isSent }: { children: ReactNode; isSent: boolean }) {
  return (
    <div className={cn("flex flex-col", isSent ? "items-end" : "items-start")}>{children}</div>
  );
}

function SmsBubble({ isSent, body }: { isSent: boolean; body?: string | null }) {
  return (
    <div
      className={cn(
        "max-w-[88%] rounded-crm-lg px-3 py-2 text-sm leading-relaxed",
        isSent
          ? "rounded-br-sm bg-crm-accent/20 text-crm-text"
          : "rounded-bl-sm bg-violet-500/15 text-crm-text",
      )}
    >
      {body || <em className="opacity-60">(no body)</em>}
    </div>
  );
}

function BubbleMeta({ phone, createdAt }: { phone: string | null; createdAt: string }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5">
      {phone ? <span className="font-mono text-[0.6875rem] text-crm-muted">{phone}</span> : null}
      <span className="text-[0.6875rem] text-crm-muted">{formatDateTime(createdAt)}</span>
    </div>
  );
}

function SmsFooter({
  smsMessage,
  smsSuccess,
  smsError,
}: {
  smsMessage: string;
  smsSuccess: boolean;
  smsError: string | null;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-crm-muted">
      <span>{smsMessage.length > 0 ? `${smsMessage.length}/1600` : "⌘↵ to send"}</span>
      {smsSuccess ? <span className="font-semibold text-crm-success">✓ Sent</span> : null}
      {smsError ? <span className="text-crm-danger">{smsError}</span> : null}
    </div>
  );
}
