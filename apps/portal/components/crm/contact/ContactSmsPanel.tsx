"use client";

import type { ReactNode } from "react";
import { forwardRef } from "react";
import { MessageSquareDot, Send } from "lucide-react";
import { CRMCard, CRMSection, crm } from "..";
import { cn } from "../cn";
import { ConnectSelect } from "../../ConnectSelect";
import type { ContactPhone } from "./contactTypes";
import { formatDateTime } from "./contactFormatters";
import { phoneSummaryLabel, phoneDispositionSummary } from "./contactWorkspaceHelpers";
import { isSmsTextOverLimit, SmsCharCounter } from "../../chat/SmsCharCounter";

export type ContactSmsPanelMessage = {
  id: string;
  body: string;
  sentAt: string;
  mine: boolean;
  direction?: "INBOUND" | "OUTBOUND" | "INTERNAL";
  deliveryStatus?: string | null;
  deliveryError?: string | null;
};

export const ContactSmsPanel = forwardRef<
  HTMLDivElement,
  {
    phones: ContactPhone[];
    messages: ContactSmsPanelMessage[];
    loading: boolean;
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
    messages,
    loading,
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
      <CRMCard padding="lg" className="border-crm-accent/20 bg-crm-accent/5">
        <CRMSection
          title="SMS"
          description={
            messages.length > 0
              ? `${messages.length} message${messages.length !== 1 ? "s" : ""} from Connect Chat`
              : "Connect Chat SMS thread"
          }
        >
          {loading ? (
            <p className="text-sm text-crm-muted">Loading…</p>
          ) : messages.length === 0 ? (
            <div className="py-2 text-sm">
              <p className="font-semibold text-crm-text">No SMS activity yet.</p>
              <p className="mt-1 text-crm-muted">Send the first SMS below. It appears in Connect Chat and here.</p>
            </div>
          ) : (
            <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
              {messages.map((message) => {
                const isSent = message.mine || message.direction === "OUTBOUND";
                return (
                  <BubbleRow key={message.id} isSent={isSent}>
                    <SmsBubble isSent={isSent} body={message.body} />
                    <BubbleMeta deliveryStatus={message.deliveryStatus} deliveryError={message.deliveryError} createdAt={message.sentAt} />
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
                <ConnectSelect
                  value={smsPhone}
                  onChange={(value) => setSmsPhone(value)}
                  className="w-full"
                  options={[
                    {
                      value: "",
                      label: `${phoneSummaryLabel(phones.find((p) => p.isPrimary) ?? phones[0])} — ${(phones.find((p) => p.isPrimary) ?? phones[0]).numberRaw}`,
                    },
                    ...phones.map((p) => ({
                      value: p.numberRaw,
                      label: `${phoneSummaryLabel(p)} — ${p.numberRaw}${phoneDispositionSummary(p) ? ` · ${phoneDispositionSummary(p)}` : ""}`,
                    })),
                  ]}
                />
              ) : null}
              <div className="flex gap-2">
                <textarea
                  value={smsMessage}
                  onChange={(e) => setSmsMessage(e.target.value)}
                  rows={3}
                  placeholder="Type SMS reply…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSend();
                    }
                  }}
                  className={cn(crm.input, "min-h-[5rem] flex-1 resize-none")}
                />
                <button
                  type="button"
                  onClick={onSend}
                  disabled={smsSending || !smsMessage.trim() || isSmsTextOverLimit(smsMessage)}
                  title="Send SMS (⌘↵)"
                  className={cn(crm.btnPrimary, "self-end px-3")}
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              <ContactSmsFooter smsMessage={smsMessage} smsSuccess={smsSuccess} smsError={smsError} />
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

function BubbleMeta({ deliveryStatus, deliveryError, createdAt }: { deliveryStatus?: string | null; deliveryError?: string | null; createdAt: string }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5">
      {deliveryStatus ? <span className="text-[0.6875rem] text-crm-muted">{deliveryError ? "Failed" : deliveryStatus}</span> : null}
      <span className="text-[0.6875rem] text-crm-muted">{formatDateTime(createdAt)}</span>
    </div>
  );
}

function ContactSmsFooter({
  smsMessage,
  smsSuccess,
  smsError,
}: {
  smsMessage: string;
  smsSuccess: boolean;
  smsError: string | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      {smsMessage.trim() ? (
        <div className="text-xs text-crm-muted">
          <SmsCharCounter text={smsMessage} />
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-crm-muted">
        {!smsMessage.trim() ? <span>⌘↵ to send</span> : null}
        {smsSuccess ? <span className="font-semibold text-crm-success">✓ Sent</span> : null}
        {smsError ? <span className="text-crm-danger">{smsError}</span> : null}
      </div>
    </div>
  );
}
