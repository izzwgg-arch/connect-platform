"use client";

/**
 * The Support Desk — the shell that holds the five screens.
 *
 * Built to the approved mockups:
 * https://claude.ai/code/artifact/cf13e7b7-ebbf-414e-a1a6-f22dee7a2eaa
 *
 *   Escalations — the escalation IS the chat (SupportEscalationChats)
 *   Inbox       — every company's texts in one list (SupportInbox)
 *   Assistant   — watch and take over (SupportConversations)
 *   Workbench   — the IDE (SupportWorkbench)
 *   Ground rules— the rulebook + the Watchman (SupportRules)
 *
 * ⛔ This file holds NO screen logic on purpose. Each view owns its own data,
 * so a change to one can never quietly break another — the old version kept
 * every escalation's state here and it made the file impossible to reason
 * about once the desk grew past one screen.
 *
 * ⛔ SUPER_ADMIN only (Izzy, 2026-08-20). The nav item is forced to SUPER_ADMIN
 * in navConfig.isNavItemVisibleForUser and every API handler checks again
 * server-side; the PermissionGate below is presentation, not the fence.
 */
import { useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import SupportEscalationChats from "./SupportEscalationChats";
import SupportInbox from "./SupportInbox";
import SupportConversations from "./SupportConversations";
import SupportWorkbench from "./SupportWorkbench";
import SupportRules from "./SupportRules";
import "./supportDesk.css";

type View = "escalations" | "inbox" | "assistant" | "workbench" | "rules";

const BLURB: Record<View, string> = {
  escalations: "Everything the assistant passed to the team — as the conversation it came from, with its report inside the thread.",
  inbox: "Every company's text conversations in one place. Replies go out from the company's own number.",
  assistant: "Watch the assistant work — and take over when a person should talk.",
  workbench: "Read the code, run read-only commands, and ask the agent — every command checked against your ground rules.",
  rules: "What the agent may do, may never do, and must ask you about first.",
};

const TABS: Array<{ id: View; label: string }> = [
  { id: "escalations", label: "Escalations" },
  { id: "inbox", label: "Inbox" },
  { id: "assistant", label: "Assistant" },
  { id: "workbench", label: "Workbench" },
  { id: "rules", label: "Ground rules" },
];

function SupportDesk() {
  const [view, setView] = useState<View>("escalations");

  return (
    <div className="sd-page">
      <header className="sd-head">
        <div>
          <h1>Support Desk</h1>
          <p>{BLURB[view]}</p>
        </div>
        <div className="sd-view-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={view === t.id}
              className={view === t.id ? "on" : ""}
              onClick={() => setView(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {view === "escalations" ? <SupportEscalationChats /> : null}
      {view === "inbox" ? <SupportInbox /> : null}
      {view === "assistant" ? <SupportConversations /> : null}
      {view === "workbench" ? <SupportWorkbench /> : null}
      {view === "rules" ? <SupportRules /> : null}
    </div>
  );
}

export default function SupportDeskPage() {
  return (
    <PermissionGate
      permission={"can_manage_global_settings" as never}
      fallback={<div className="sd-state">This page is for the platform owner.</div>}
    >
      <SupportDesk />
    </PermissionGate>
  );
}
