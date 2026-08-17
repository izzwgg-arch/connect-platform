"use client";

import type { ReactNode } from "react";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, MessageSquareDot, Plus, Save, Send, Trash2, X } from "lucide-react";
import { CRMCard, crm } from "..";
import { cn } from "../cn";
import { ConnectSelect } from "../../ConnectSelect";
import type { ContactPhone } from "./contactTypes";
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

export type ContactSmsTemplate = {
  id: string;
  name: string;
  bodyText: string;
  isFavorite?: boolean;
  usageCount?: number;
};

export const ContactSmsPanel = forwardRef<
  HTMLDivElement,
  {
    contactName: string;
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
    outboundConfigured?: boolean;
    smsError: string | null;
    smsSuccess: boolean;
    smsTemplates: ContactSmsTemplate[];
    smsTemplatesLoading: boolean;
    selectedSmsTemplateId: string;
    setSelectedSmsTemplateId: (v: string) => void;
    smsTemplateSaving: boolean;
    smsTemplateError: string | null;
    onCreateTemplate: (input: { name: string; bodyText: string }) => Promise<void>;
    onArchiveTemplate: (templateId: string) => Promise<void>;
    onSend: () => void;
    onOpenChat: () => void;
    openingChat?: boolean;
  }
>(function ContactSmsPanel(
  {
    contactName,
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
    outboundConfigured = true,
    smsError,
    smsSuccess,
    smsTemplates,
    smsTemplatesLoading,
    selectedSmsTemplateId,
    setSelectedSmsTemplateId,
    smsTemplateSaving,
    smsTemplateError,
    onCreateTemplate,
    onArchiveTemplate,
    onSend,
    onOpenChat,
    openingChat,
  },
  ref,
) {
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templateTrayOpen, setTemplateTrayOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const selectedTemplate = useMemo(
    () => smsTemplates.find((template) => template.id === selectedSmsTemplateId) ?? null,
    [selectedSmsTemplateId, smsTemplates],
  );
  const selectedPhone = useMemo(
    () => phones.find((phone) => phone.numberRaw === smsPhone) ?? phones.find((phone) => phone.isPrimary) ?? phones[0],
    [phones, smsPhone],
  );
  const phoneOptions = useMemo(
    () => {
      const primary = phones.find((p) => p.isPrimary) ?? phones[0];
      if (!primary) return [];
      return [
        {
          value: "",
          label: `${phoneSummaryLabel(primary)} — ${primary.numberRaw}`,
        },
        ...phones.map((p) => ({
          value: p.numberRaw,
          label: `${phoneSummaryLabel(p)} — ${p.numberRaw}${phoneDispositionSummary(p) ? ` · ${phoneDispositionSummary(p)}` : ""}`,
        })),
      ];
    },
    [phones],
  );
  const messageGroups = useMemo(() => groupMessagesByDay(messages), [messages]);

  useEffect(() => {
    if (!creatingTemplate) return;
    setTemplateBody((current) => current || smsMessage);
  }, [creatingTemplate, smsMessage]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [messages.length]);

  if (phones.length === 0) return null;

  const handleSelectTemplate = (templateId: string) => {
    setSelectedSmsTemplateId(templateId);
    const template = smsTemplates.find((item) => item.id === templateId);
    if (template) {
      setSmsMessage(template.bodyText);
      setTemplateTrayOpen(false);
    }
  };

  const handleMessageChange = (value: string) => {
    setSmsMessage(value);
    if (selectedTemplate && value !== selectedTemplate.bodyText) {
      setSelectedSmsTemplateId("");
    }
  };

  const handleCreateTemplate = async () => {
    try {
      await onCreateTemplate({ name: templateName, bodyText: templateBody });
      setTemplateName("");
      setTemplateBody("");
      setCreatingTemplate(false);
    } catch {
      // Keep the draft visible; the parent surfaces the API error.
    }
  };

  return (
    <div ref={ref} className="crm-contact-module crm-contact-sms-workspace">
      <CRMCard padding="lg" className="crm-contact-module-card crm-contact-sms-card border-crm-accent/20 bg-crm-accent/5">
        <div className="crm-contact-sms-chat-frame">
          <div className="crm-contact-sms-conversation-header">
            <div className="min-w-0">
              <p className="crm-contact-sms-eyebrow">Loopcom Chat SMS</p>
              <h2 className="crm-contact-sms-title">Conversation with {contactName}</h2>
              <div className="crm-contact-sms-header-meta">
                <span>{selectedPhone?.numberRaw ?? "No phone selected"}</span>
                <span>{messages.length} message{messages.length !== 1 ? "s" : ""}</span>
                <span>{outboundConfigured ? "Ready to send" : "Sender setup needed"}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenChat}
              disabled={openingChat}
              className={cn(crm.btnSecondary, "crm-contact-sms-open-chat px-3 py-1.5 text-xs")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {openingChat ? "Opening..." : "Open in Chat"}
            </button>
          </div>

          <div className="crm-contact-sms-thread-shell">
            {loading ? (
              <p className="crm-contact-sms-loading">Loading conversation...</p>
            ) : messages.length === 0 ? (
              <div className="crm-contact-sms-empty crm-contact-module-empty py-2 text-sm">
                <p className="font-semibold text-crm-text">No SMS activity yet.</p>
                <p className="mt-1 text-crm-muted">Send the first SMS below. It appears in Loopcom Chat and here.</p>
              </div>
            ) : (
              <div ref={threadRef} className="crm-contact-sms-thread flex max-h-80 flex-col overflow-y-auto">
                {messageGroups.map((group) => (
                  <div key={group.key} className="crm-contact-sms-day-group">
                    <div className="crm-contact-sms-date-separator"><span>{group.label}</span></div>
                    {group.messages.map((message) => {
                      const isSent = message.mine || message.direction === "OUTBOUND";
                      return (
                        <BubbleRow key={message.id} isSent={isSent}>
                          <SmsBubble isSent={isSent} body={message.body} />
                          <BubbleMeta
                            isSent={isSent}
                            deliveryStatus={message.deliveryStatus}
                            deliveryError={message.deliveryError}
                            createdAt={message.sentAt}
                          />
                        </BubbleRow>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

          {doNotSms ? (
            <div className="crm-contact-module-alert crm-contact-module-alert-danger mt-3 flex items-center gap-2 rounded-crm border border-crm-danger/35 bg-crm-danger/10 px-3 py-2 text-sm text-crm-danger">
              <MessageSquareDot className="h-4 w-4 shrink-0" />
              SMS disabled — contact has opted out
            </div>
          ) : isArchived ? (
            <p className="mt-3 text-sm text-crm-muted">SMS sending is disabled while archived.</p>
          ) : (
            <div className="crm-contact-sms-composer">
              <div className="crm-contact-sms-compose-shell">
                <div className="crm-contact-sms-composer-toolbar">
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateTrayOpen((value) => !value);
                      if (creatingTemplate) setCreatingTemplate(false);
                    }}
                    className={cn(crm.btnSecondary, "crm-contact-sms-toolbar-button")}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Template
                  </button>
                  <div className="crm-contact-sms-phone-picker">
                    <span className="crm-contact-sms-phone-label">Send to</span>
                    <ConnectSelect
                      value={smsPhone}
                      onChange={(value) => setSmsPhone(value)}
                      className="min-w-0 flex-1"
                      options={phoneOptions}
                      size="sm"
                    />
                  </div>
                  <div className="crm-contact-sms-counter">
                    <SmsCharCounter text={smsMessage} />
                    {!smsMessage.trim() ? <span>0 chars · 0 segments</span> : null}
                  </div>
                </div>

                {templateTrayOpen || creatingTemplate || selectedTemplate || smsTemplateError ? (
                  <div className="crm-contact-sms-template-panel">
                    <div className="crm-contact-sms-template-panel-header">
                      <div>
                        <p className="crm-contact-sms-template-title">SMS templates</p>
                        <p className="crm-contact-sms-template-subtitle">Reusable snippets for this conversation.</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setCreatingTemplate(true);
                            setTemplateTrayOpen(true);
                            setTemplateBody(smsMessage);
                          }}
                          className={cn(crm.btnSecondary, "crm-contact-sms-mini-action")}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          New
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTemplateTrayOpen(false);
                            setCreatingTemplate(false);
                          }}
                          className="rounded-full p-1 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text"
                          aria-label="Close templates"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {smsTemplateError ? (
                      <p className="crm-contact-sms-template-safe-error">{smsTemplateError}</p>
                    ) : smsTemplatesLoading ? (
                      <p className="crm-contact-sms-template-empty">Loading templates...</p>
                    ) : smsTemplates.length === 0 ? (
                      <div className="crm-contact-sms-template-empty">
                        <p className="font-semibold text-crm-text">No SMS templates yet.</p>
                        <p className="mt-1">Create one from the draft below when you have reusable copy.</p>
                      </div>
                    ) : (
                      <div className="crm-contact-sms-template-list">
                        {smsTemplates.map((template) => (
                          <div key={template.id} className={cn("crm-contact-sms-template-card", selectedSmsTemplateId === template.id && "is-selected")}>
                            <div className="min-w-0">
                              <div className="crm-contact-sms-template-card-title">
                                <span>{template.name}</span>
                                {template.isFavorite ? <span className="crm-contact-sms-template-chip">Favorite</span> : null}
                              </div>
                              <p className="crm-contact-sms-template-snippet">{template.bodyText}</p>
                              {template.usageCount ? <p className="crm-contact-sms-template-usage">Used {template.usageCount} time{template.usageCount !== 1 ? "s" : ""}</p> : null}
                            </div>
                            <div className="crm-contact-sms-template-actions">
                              <button type="button" onClick={() => handleSelectTemplate(template.id)} className={cn(crm.btnSecondary, "crm-contact-sms-mini-action")}>
                                Insert
                              </button>
                              <button
                                type="button"
                                onClick={() => void onArchiveTemplate(template.id)}
                                className={cn(crm.btnSecondary, "crm-contact-sms-mini-action text-crm-danger")}
                                title="Archive SMS template"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {creatingTemplate ? (
                      <div className="crm-contact-sms-template-editor">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-bold text-crm-text">Create SMS template</p>
                          <button
                            type="button"
                            onClick={() => setCreatingTemplate(false)}
                            className="rounded-full p-1 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <input
                          value={templateName}
                          onChange={(e) => setTemplateName(e.target.value)}
                          placeholder="Template name"
                          className={cn(crm.input, "mt-2")}
                        />
                        <textarea
                          value={templateBody}
                          onChange={(e) => setTemplateBody(e.target.value)}
                          rows={2}
                          placeholder="Template message..."
                          className={cn(crm.input, "mt-2 min-h-[4rem] resize-none")}
                        />
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-crm-muted">
                          <SmsCharCounter text={templateBody} />
                          <div className="flex items-center justify-end gap-2">
                            <button type="button" onClick={() => setCreatingTemplate(false)} className={cn(crm.btnSecondary, "px-3 py-1.5 text-xs")}>
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleCreateTemplate()}
                              disabled={smsTemplateSaving || !templateName.trim() || !templateBody.trim() || isSmsTextOverLimit(templateBody)}
                              className={cn(crm.btnPrimary, "px-3 py-1.5 text-xs")}
                            >
                              <Save className="h-3.5 w-3.5" />
                              Save
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="crm-contact-sms-compose-row">
                  <textarea
                    value={smsMessage}
                    onChange={(e) => handleMessageChange(e.target.value)}
                    rows={3}
                    placeholder="Type SMS reply..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        onSend();
                      }
                    }}
                    className={cn(crm.input, "crm-contact-sms-input flex-1 resize-none")}
                  />
                  <button
                    type="button"
                    onClick={onSend}
                    disabled={!outboundConfigured || smsSending || !smsMessage.trim() || isSmsTextOverLimit(smsMessage)}
                    title="Send SMS (⌘↵)"
                    className={cn(crm.btnPrimary, "crm-contact-sms-send-button px-3")}
                  >
                    <Send className="h-4 w-4" />
                    {smsSending ? "Sending" : "Send"}
                  </button>
                </div>
              </div>
              <ContactSmsFooter smsMessage={smsMessage} smsSuccess={smsSuccess} smsError={smsError} />
            </div>
          )}
        </div>
      </CRMCard>
    </div>
  );
});

function BubbleRow({ children, isSent }: { children: ReactNode; isSent: boolean }) {
  return (
    <div className={cn("crm-contact-sms-row flex flex-col", isSent ? "items-end" : "items-start")}>{children}</div>
  );
}

function SmsBubble({ isSent, body }: { isSent: boolean; body?: string | null }) {
  return (
    <div
      className={cn(
        "crm-contact-sms-bubble inline-block max-w-[72%] rounded-[1.05rem] px-2.5 py-1 text-[0.8125rem] leading-snug",
        isSent
          ? "crm-contact-sms-bubble-outgoing rounded-br-sm bg-crm-accent/20 text-crm-text"
          : "crm-contact-sms-bubble-incoming rounded-bl-sm bg-violet-500/15 text-crm-text",
      )}
    >
      {body || <em className="opacity-60">(no body)</em>}
    </div>
  );
}

function groupMessagesByDay(messages: ContactSmsPanelMessage[]) {
  const groups: Array<{ key: string; label: string; messages: ContactSmsPanelMessage[] }> = [];
  for (const message of messages) {
    const date = new Date(message.sentAt);
    const key = Number.isNaN(date.getTime()) ? "unknown" : date.toDateString();
    const label = Number.isNaN(date.getTime()) ? "Recent" : formatDateSeparator(date);
    const current = groups[groups.length - 1];
    if (current?.key === key) {
      current.messages.push(message);
    } else {
      groups.push({ key, label, messages: [message] });
    }
  }
  return groups;
}

function formatDateSeparator(date: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function BubbleMeta({
  isSent,
  deliveryStatus,
  deliveryError,
  createdAt,
}: {
  isSent: boolean;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
  createdAt: string;
}) {
  const statusLabel = deliveryError ? "Failed" : deliveryStatus ? deliveryStatus.toLowerCase() : isSent ? "sent" : "";
  return (
    <div className={cn("crm-contact-sms-meta flex items-center gap-1", isSent ? "justify-end" : "justify-start")}>
      <span>{isSent ? "outgoing" : "incoming"}</span>
      <span aria-hidden>·</span>
      <span>{formatMessageTime(createdAt)}</span>
      {statusLabel ? (
        <>
          <span aria-hidden>·</span>
          <span className={cn("crm-contact-sms-delivery", deliveryError ? "text-crm-danger" : "text-crm-muted")}>
            {statusLabel}
          </span>
        </>
      ) : null}
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
      <div className="flex items-center gap-2 text-xs text-crm-muted">
        {!smsMessage.trim() ? <span>⌘↵ to send</span> : null}
        {smsSuccess ? <span className="font-semibold text-crm-success">✓ Sent</span> : null}
        {smsError ? <span className="text-crm-danger">{smsError}</span> : null}
      </div>
    </div>
  );
}
