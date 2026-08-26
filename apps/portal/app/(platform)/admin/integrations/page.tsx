"use client";

/**
 * Admin → Integrations (mockup screen 6, v9): pick the customer, set their
 * CRM mode, and manage their integration keys — Sola and the Tracking system
 * (POS) — plus the supermarket switches. As many keys across as many
 * customers as needed; every key stored encrypted, shown masked, scoped
 * strictly to its own company (Izzy's multi-tenant directive).
 *
 * SUPER_ADMIN only, three ways: navConfig force line, this PermissionGate
 * (can_manage_global_settings — the key only the owner holds), and the api's
 * requireOwner on every /admin/integrations route.
 */

import "../../orders/supermarket.css";
import { Suspense } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { IntegrationsInner } from "./IntegrationsInner";

export default function AdminIntegrationsPage() {
  return (
    <PermissionGate
      permission={"can_manage_global_settings" as never}
      fallback={<div className="card" style={{ margin: 24, padding: 24 }}><p>This page is for the platform owner.</p></div>}
    >
      <Suspense fallback={null}>
        <IntegrationsInner />
      </Suspense>
    </PermissionGate>
  );
}
