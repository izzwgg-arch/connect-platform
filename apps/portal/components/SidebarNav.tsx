"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { canAccessAdminBilling, canAccessAdminSbc, canManageBilling, canManageMessaging, canManageProviders, canViewCustomers, readRoleFromToken } from "../lib/roles";

type NavItem = { href: string; label: string };

const primary: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/extensions", label: "Users" },
  { href: "/dashboard/voice/phone", label: "Voice & Chat" },
  { href: "/dashboard/numbers", label: "Phones" },
  { href: "/dashboard/sms", label: "Calls" },
  { href: "/dashboard/whatsapp", label: "WhatsApp Ops" },
  { href: "/dashboard/customers", label: "Customers" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/billing/settings", label: "Billing Settings" },
  { href: "/dashboard/billing/invoices", label: "Invoices" },
  { href: "/dashboard/settings/email", label: "Email Settings" },
  { href: "/dashboard/10dlc", label: "Compliance" },
  { href: "/dashboard/settings/providers", label: "Integrations" }
];

const admin: NavItem[] = [
  { href: "/dashboard/admin/tenants", label: "Admin Tenants" },
  { href: "/dashboard/admin/campaigns", label: "Admin Campaigns" },
  { href: "/dashboard/admin/billing/tenants", label: "Admin Billing" },
  { href: "/dashboard/admin/pbx/instances", label: "PBX Instances" },
  { href: "/dashboard/admin/sbc/rollout", label: "SBC Rollout" },
  { href: "/dashboard/admin/sbc/config", label: "SBC Config" },
  { href: "/dashboard/voice/settings", label: "Voice Settings" },
  { href: "/dashboard/voice/provisioning", label: "Voice Provisioning" },
  { href: "/dashboard/voice/sbc-test", label: "Voice SBC Test" },
  { href: "/dashboard/voice/calls", label: "Call Logs" }
];

const railGlyphs = ["D", "U", "V", "C", "P", "R", "S", "I", "A"];

function NavGroup({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <nav className="nav-group">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} className={`side-link${active ? " active" : ""}`}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const [role, setRole] = useState("");
  useEffect(() => {
    setRole(readRoleFromToken());
  }, []);

  const filteredPrimary = primary.filter((item) => {
    if (item.href === "/dashboard") return true;
    if (item.href === "/dashboard/customers") return canViewCustomers(role);
    if (item.href.startsWith("/dashboard/billing")) return canManageBilling(role);
    if (item.href === "/dashboard/settings/email") return canManageBilling(role);
    if (item.href.startsWith("/dashboard/sms")) return canManageMessaging(role);
    if (item.href.startsWith("/dashboard/whatsapp")) return canManageMessaging(role) || canViewCustomers(role);
    if (item.href.startsWith("/dashboard/settings/providers")) return canManageProviders(role);
    if (item.href === "/dashboard/10dlc") return canManageMessaging(role) || canManageProviders(role);
    if (item.href === "/dashboard/extensions" || item.href === "/dashboard/voice/phone" || item.href === "/dashboard/numbers") {
      return !["READ_ONLY"].includes(role || "");
    }
    return true;
  });
  const filteredAdmin = admin.filter((item) => {
    if (item.href.startsWith("/dashboard/admin/sbc")) return canAccessAdminSbc(role);
    if (item.href.startsWith("/dashboard/admin/billing")) return canAccessAdminBilling(role);
    return canAccessAdminSbc(role);
  });

  return (
    <>
      <aside className="rail">
        <div className="brand-mark">CC</div>
        <div className="rail-list">
          {railGlyphs.map((g) => (
            <button key={g} type="button" className="rail-dot" aria-label={g}>{g}</button>
          ))}
        </div>
        <div className="rail-foot">A</div>
      </aside>
      <aside className="side-panel">
        <div className="side-head">Admin Console</div>
        <NavGroup items={filteredPrimary} pathname={pathname} />
        <div className="side-divider" />
        <NavGroup items={filteredAdmin} pathname={pathname} />
      </aside>
    </>
  );
}