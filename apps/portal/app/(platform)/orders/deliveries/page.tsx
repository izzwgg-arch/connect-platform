"use client";

/**
 * Deliveries — the live map (mockup screen 4, v9). Driver cards on the left
 * (state pill, stop progress, CALL-HIS-REAL-CELL button — drivers don't carry
 * the Loopcom phone app), the map on the right. A driver whose location went
 * dark gets the amber banner + last-known position, exactly as drawn.
 *
 * Honest state: live GPS arrives only once the Loopcom Driver app ships its
 * tracking (its own project) — until then positions are empty and the map
 * says so instead of pretending.
 */

import "../supermarket.css";
import { Suspense } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { DeliveriesInner } from "./DeliveriesInner";

export default function SupermarketDeliveriesPage() {
  return (
    <PermissionGate
      permission={"can_view_store_deliveries" as never}
      fallback={<div className="card" style={{ margin: 24, padding: 24 }}><p>This screen is switched off for your account.</p></div>}
    >
      <Suspense fallback={null}>
        <DeliveriesInner />
      </Suspense>
    </PermissionGate>
  );
}
