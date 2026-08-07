"use client";

import "./_components/billingPhase3.css";
import "./_components/billingPhase4.css";
import "./_components/billingPhase5.css";
import "./_components/billingPhase6.css";
import "./_components/billingPhase7.css";
import "./_components/billingPhase8.css";
import "./_components/billingPhase9.css";
import "./_components/billingPricing.css";
import "./_components/billingTaxFees.css";
import "./_components/billingInvoices.css";
import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AdminBillingShell } from "./_components/AdminBillingShell";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";

/* The rebuilt billing screens carry their own layout and their own chrome.
   Wrapping them in AdminBillingShell stapled the old nine-tab workspace toolbar
   on top of every one of them, which is why they did not look like the design.
   These paths render bare; everything else keeps the original shell untouched. */
const REBUILT = [
  "/admin/billing/month",
  "/admin/billing/customers",
  "/admin/billing/customer",
  "/admin/billing/invoice",
  "/admin/billing/money",
  "/admin/billing/needs-you",
  "/admin/billing/catalog",
];

function isRebuilt(pathname: string | null): boolean {
  if (!pathname) return false;
  return REBUILT.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function AdminBillingLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isRebuilt(pathname)) {
    return <Suspense fallback={<LoadingSkeleton rows={6} />}>{children}</Suspense>;
  }

  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <AdminBillingShell>{children}</AdminBillingShell>
    </Suspense>
  );
}
