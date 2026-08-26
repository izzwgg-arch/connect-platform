"use client";

/**
 * The ORDER TWIN — the second little window that pops beside the mini dialer
 * the moment somebody answers (mockup screen 3, v9). Same content as
 * /orders/new but laid out for a mini-dialer-sized window: single column,
 * compact paddings, and it deliberately never navigates away — it stays on
 * screen until the order is put through (or saved as a draft on purpose).
 */

import "../supermarket.css";
import { Suspense } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { TwinInner } from "./TwinInner";

export default function OrderTwinPage() {
  return (
    <PermissionGate
      permission={"can_view_supermarket_orders" as never}
      fallback={<div className="card" style={{ margin: 16, padding: 16 }}><p>This screen is switched off for your account.</p></div>}
    >
      <Suspense fallback={null}>
        <TwinInner />
      </Suspense>
    </PermissionGate>
  );
}
