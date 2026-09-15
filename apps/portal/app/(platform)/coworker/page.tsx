"use client";
/**
 * Coworker — the full page (sidebar → Workspace → Coworker). The IDE-style
 * workspace Izzy approved on 2026-09-15: tasks, the live conversation with every
 * step shown, what it is doing right now, everything it did, and its settings.
 *
 * ⛔ One key per page: can_view_workspace_coworker, in NO default bucket — granting
 * it is the launch (Permissions screen role columns, or a custom role). The bubble's
 * chat itself (/desktop/coworker) is not gated by this key.
 */
import { PermissionGate } from "../../../components/PermissionGate";
import { CoworkerWorkspace } from "../../../components/coworker/CoworkerWorkspace";

export default function CoworkerPage() {
  return (
    <PermissionGate
      permission="can_view_workspace_coworker"
      fallback={<div style={{ padding: 24, color: "var(--text-dim)" }}>The Coworker page isn't turned on for your account. Ask your administrator to turn it on.</div>}
    >
      <CoworkerWorkspace />
    </PermissionGate>
  );
}
