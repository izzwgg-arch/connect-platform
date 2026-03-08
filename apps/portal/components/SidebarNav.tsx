"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { canAccessAdminBilling, canAccessAdminSbc, canManageBilling, canManageMessaging, canManageProviders, canViewCustomers, readRoleFromToken } from "../lib/roles";

type NavItem = { href: string; label: string };

const admin: NavItem[] = [
  { href: "/dashboard/admin/tenants", label: "Admin Tenants" },
  { href: "/dashboard/admin/campaigns", label: "Admin Campaigns" },
  { href: "/dashboard/admin/billing/tenants", label: "Admin Billing" },
  { href: "/dashboard/admin/pbx/instances", label: "PBX Instances" },
  { href: "/dashboard/admin/pbx", label: "Admin PBX" },
  { href: "/dashboard/admin/pbx/tenants", label: "PBX Tenants" },
  { href: "/dashboard/admin/pbx/resources", label: "PBX Resources" },
  { href: "/dashboard/admin/sbc/rollout", label: "SBC Rollout" },
  { href: "/dashboard/admin/sbc/config", label: "SBC Config" },
  { href: "/dashboard/voice/settings", label: "Voice Settings" },
  { href: "/dashboard/voice/provisioning", label: "Voice Provisioning" },
  { href: "/dashboard/voice/sbc-test", label: "Voice SBC Test" },
  { href: "/dashboard/voice/calls", label: "Call Logs" }
];

const sections: Array<{
  id: string;
  label: string;
  glyph: string;
  matchPrefix: string;
  groups: Array<{ title: string; items: NavItem[] }>;
}> = [
  {
    id: "dashboard",
    label: "Dashboard",
    glyph: "◫",
    matchPrefix: "/dashboard",
    groups: [
      { title: "Overview", items: [{ href: "/dashboard", label: "Operations Dashboard" }, { href: "/dashboard/search", label: "Global Search" }] },
      { title: "Actions", items: [{ href: "/dashboard/automation", label: "Automation Rules" }, { href: "/dashboard/extensions", label: "Users & Roles" }] }
    ]
  },
  {
    id: "voice",
    label: "Voice",
    glyph: "☎",
    matchPrefix: "/dashboard/voice",
    groups: [
      { title: "Softphone", items: [{ href: "/dashboard/voice/phone", label: "Operator Console" }, { href: "/dashboard/voice/sbc-test", label: "SBC Test" }, { href: "/dashboard/voice/settings", label: "Voice Settings" }, { href: "/dashboard/voice/provisioning", label: "Provisioning" }] },
      { title: "PBX Objects", items: [{ href: "/dashboard/voice/extensions", label: "Extensions" }, { href: "/dashboard/voice/ring-groups", label: "Ring Groups" }, { href: "/dashboard/voice/queues", label: "Queues" }, { href: "/dashboard/voice/ivr", label: "IVR" }, { href: "/dashboard/voice/ivr/schedules", label: "IVR Schedules" }, { href: "/dashboard/voice/trunks", label: "Trunks" }, { href: "/dashboard/voice/routes", label: "Routes" }] },
      { title: "Records", items: [{ href: "/dashboard/voice/recordings", label: "Recordings" }, { href: "/dashboard/voice/call-recordings", label: "Call Recordings" }, { href: "/dashboard/voice/call-reports", label: "Call Reports" }, { href: "/dashboard/voice/calls", label: "Call Logs" }] }
    ]
  },
  {
    id: "messaging",
    label: "Messaging",
    glyph: "✉",
    matchPrefix: "/dashboard/sms",
    groups: [
      { title: "SMS", items: [{ href: "/dashboard/sms", label: "SMS Hub" }, { href: "/dashboard/sms/campaigns", label: "Campaigns" }, { href: "/dashboard/sms/campaigns/new", label: "New Campaign" }] },
      { title: "WhatsApp", items: [{ href: "/dashboard/whatsapp", label: "WhatsApp Ops" }] }
    ]
  },
  {
    id: "crm",
    label: "Customers",
    glyph: "⌂",
    matchPrefix: "/dashboard/customers",
    groups: [
      { title: "Customer Hub", items: [{ href: "/dashboard/customers", label: "All Customers" }, { href: "/dashboard/numbers", label: "Numbers" }] }
    ]
  },
  {
    id: "billing",
    label: "Billing",
    glyph: "$",
    matchPrefix: "/dashboard/billing",
    groups: [
      { title: "Billing Ops", items: [{ href: "/dashboard/billing", label: "Billing Home" }, { href: "/dashboard/billing/invoices", label: "Invoices" }, { href: "/dashboard/billing/settings", label: "Billing Settings" }, { href: "/dashboard/settings/email", label: "Email Settings" }] }
    ]
  },
  {
    id: "integrations",
    label: "Integrations",
    glyph: "⇄",
    matchPrefix: "/dashboard/settings",
    groups: [
      { title: "Providers", items: [{ href: "/dashboard/settings/providers", label: "SMS Providers" }, { href: "/dashboard/settings/providers/whatsapp", label: "WhatsApp Provider" }, { href: "/dashboard/10dlc", label: "10DLC Compliance" }] }
    ]
  },
  {
    id: "admin",
    label: "Admin",
    glyph: "⚙",
    matchPrefix: "/dashboard/admin",
    groups: [
      { title: "Admin Console", items: admin }
    ]
  }
];

function NavGroup({ title, items, pathname }: { title: string; items: NavItem[]; pathname: string }) {
  return (
    <nav className="nav-group">
      <div className="nav-group-title">{title}</div>
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

  const isAllowed = (item: NavItem) => {
    if (item.href === "/dashboard") return true;
    if (item.href === "/dashboard/customers") return canViewCustomers(role);
    if (item.href.startsWith("/dashboard/billing")) return canManageBilling(role);
    if (item.href === "/dashboard/settings/email") return canManageBilling(role);
    if (item.href.startsWith("/dashboard/sms")) return canManageMessaging(role);
    if (item.href.startsWith("/dashboard/whatsapp")) return canManageMessaging(role) || canViewCustomers(role);
    if (item.href.startsWith("/dashboard/settings/providers")) return canManageProviders(role);
    if (item.href === "/dashboard/10dlc") return canManageMessaging(role) || canManageProviders(role);
    if (item.href === "/dashboard/automation") return !["READ_ONLY"].includes(role || "");
    if (item.href === "/dashboard/extensions" || item.href.startsWith("/dashboard/voice/") || item.href === "/dashboard/numbers") {
      return !["READ_ONLY"].includes(role || "");
    }
    return true;
  };

  const filteredAdmin = admin.filter((item) => {
    if (item.href.startsWith("/dashboard/admin/sbc")) return canAccessAdminSbc(role);
    if (item.href.startsWith("/dashboard/admin/billing")) return canAccessAdminBilling(role);
    return canAccessAdminSbc(role);
  });

  const availableSections = sections.map((s) => ({
    ...s,
    groups: s.groups.map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        if (item.href.startsWith("/dashboard/admin/")) return filteredAdmin.some((x) => x.href === item.href);
        return isAllowed(item);
      })
    })).filter((g) => g.items.length > 0)
  })).filter((s) => s.groups.length > 0);

  const activeSection = availableSections.find((s) => pathname === s.matchPrefix || pathname.startsWith(`${s.matchPrefix}/`)) ?? availableSections[0];

  return (
    <>
      <aside className="rail">
        <div className="brand-mark">CC</div>
        <div className="rail-list">
          {availableSections.map((section) => {
            const active = activeSection?.id === section.id;
            const href = section.groups[0]?.items[0]?.href || "/dashboard";
            return (
              <Link
                key={section.id}
                href={href}
                className={`rail-dot${active ? " active" : ""}`}
                aria-label={section.label}
                title={section.label}
              >
                {section.glyph}
              </Link>
            );
          ))}
        </div>
        <div className="rail-foot">●</div>
      </aside>
      <aside className="side-panel">
        <div className="side-head">{activeSection?.label || "Navigation"}</div>
        {(activeSection?.groups || []).map((group) => (
          <NavGroup key={group.title} title={group.title} items={group.items} pathname={pathname} />
        ))}
      </aside>
    </>
  );
}