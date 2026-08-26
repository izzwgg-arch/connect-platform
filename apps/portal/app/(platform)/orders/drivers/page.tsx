"use client";

/**
 * Drivers — logins and the setup email (mockup screen 5, v9). Three fields
 * make a driver: name, cell, email. Creating one sends the setup email
 * (screen 7's design on the real Loopcom shell) with the choose-your-password
 * link; "Invited — not set up" shows until first sign-in.
 */

import "../supermarket.css";
import { Suspense } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { DriversInner } from "./DriversInner";

export default function SupermarketDriversPage() {
  return (
    <PermissionGate
      permission={"can_view_supermarket_orders" as never}
      fallback={<div className="card" style={{ margin: 24, padding: 24 }}><p>This screen is switched off for your account.</p></div>}
    >
      <Suspense fallback={null}>
        <DriversInner />
      </Suspense>
    </PermissionGate>
  );
}
