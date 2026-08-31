"use client";

/**
 * The Support Desk — the shell that holds the screens.
 *
 * Built to the approved redesign:
 * https://claude.ai/code/artifact/6f514701-4e37-4dea-a80f-2366ed600030
 *
 *   Desk         — the work: cases, the conversation, the customer (SupportDesk)
 *   Workbench    — the IDE, with a browser (SupportWorkbench)
 *   Ground rules — the rulebook + the Watchman (SupportRules)
 *
 * ⛔⛔ FIVE TABS BECAME THREE, AND THE SUBTRACTIONS ARE THE POINT — measured
 * against production 2026-08-24, not guessed:
 *
 *   - **Inbox is DELETED.** `GET /admin/support/threads` browsed every
 *     company's private text conversations — 679 threads, 2,477 messages — with
 *     no case attached to the reading. It was the one screen on the platform
 *     where one person could read thirty companies' customers for no stated
 *     reason. The capability survives; the browse surface does not. A
 *     customer's threads are now reachable ONLY from their case, and the
 *     header of that screen names the case it was opened for.
 *
 *   - **Assistant stopped being a destination.** 0 take-overs, ever, against
 *     114 conversations — because taking over is something you do INSIDE a
 *     case, and it was already a button in the desk's composer. Watching every
 *     assistant conversation is still reachable, from the desk's own header,
 *     but it is no longer one of five equal doors.
 *
 *   - **Escalations IS the desk.** ~2 real cases a week arrive; that is the
 *     whole job, and it sat behind a tab bar as though it were one option among
 *     five.
 *
 * ⛔ This file holds NO screen logic on purpose. Each view owns its own data,
 * so a change to one can never quietly break another.
 *
 * ⛔ SUPER_ADMIN only. The nav item is forced to SUPER_ADMIN in
 * navConfig.isNavItemVisibleForUser and every API handler checks again
 * server-side; the PermissionGate below is presentation, not the fence.
 */
import { useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import SupportDesk from "./SupportDesk";
import SupportWorkbench from "./SupportWorkbench";
import SupportRules from "./SupportRules";
import SupportAgentRuns from "./SupportAgentRuns";
import "./supportDesk.css";

type View = "desk" | "agent" | "workbench" | "rules";

const BLURB: Record<View, string> = {
  desk: "Everything the assistant passed to a person — as the conversation it came from, with the customer beside it.",
  workbench: "Read the code, run read-only commands, open a page, and ask the agent — every command checked against your ground rules.",
  agent: "What the automatic agent is doing right now, ticket by ticket — and whether it is running at all.",
  rules: "What the agent may do, may never do, and must ask you about first.",
};

const TABS: Array<{ id: View; label: string }> = [
  { id: "desk", label: "Desk" },
  { id: "agent", label: "Agent runs" },
  { id: "workbench", label: "Workbench" },
  { id: "rules", label: "Ground rules" },
];

function SupportDeskShell() {
  const [view, setView] = useState<View>("desk");

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

      {view === "desk" ? <SupportDesk /> : null}
      {view === "agent" ? <SupportAgentRuns /> : null}
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
      <SupportDeskShell />
    </PermissionGate>
  );
}
