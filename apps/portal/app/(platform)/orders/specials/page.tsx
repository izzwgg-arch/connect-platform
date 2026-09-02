"use client";

/**
 * Specials — the weekly-blast composer (plan Phase 6; drawn as M5 in the
 * mockup language). Write it once, send to the contact list by email.
 * ⛔ Sending refuses in plain English until the dedicated marketing sending
 * lane is configured — specials never ride the platform mailbox.
 */

import "../supermarket.css";
import { Suspense } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { SpecialsInner } from "./SpecialsInner";

export default function SupermarketSpecialsPage() {
  return (
    <PermissionGate
      permission={"can_view_store_specials" as never}
      fallback={<div className="card" style={{ margin: 24, padding: 24 }}><p>This screen is switched off for your account.</p></div>}
    >
      <Suspense fallback={null}>
        <SpecialsInner />
      </Suspense>
    </PermissionGate>
  );
}
