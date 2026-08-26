"use client";

/**
 * Route shell only. ⛔ A Next.js App Router page may only export a default
 * component — a named export fails the production build and tsc does NOT
 * catch it. Everything lives in ./OrdersDesk.tsx.
 */

import { Suspense } from "react";
import { PermissionGate } from "../../../components/PermissionGate";
import { OrdersInner } from "./OrdersDesk";

export default function SupermarketOrdersPage() {
  return (
    <PermissionGate
      permission={"can_view_supermarket_orders" as never}
      fallback={<div className="card" style={{ margin: 24, padding: 24 }}><p>This screen is switched off for your account.</p></div>}
    >
      <Suspense fallback={null}>
        <OrdersInner />
      </Suspense>
    </PermissionGate>
  );
}
