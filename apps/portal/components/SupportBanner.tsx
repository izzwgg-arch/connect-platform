"use client";

import { RoleGate } from "./RoleGate";

export function SupportBanner() {
  return (
    <RoleGate allow={["SUPER_ADMIN"]}>
      <div className="support-banner">Support Mode: You can impersonate tenant admins from Admin tools.</div>
    </RoleGate>
  );
}
