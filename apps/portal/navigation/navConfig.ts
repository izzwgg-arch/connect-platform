import type { Permission } from "../types/app";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  section: "operations" | "communications" | "crm" | "platform";
  permission: Permission;
};

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "DB", section: "operations", permission: "can_view_dashboard" },
  { href: "/calls", label: "Calls", icon: "CL", section: "operations", permission: "can_view_calls" },
  { href: "/dashboard/voice/phone", label: "Voice Phone", icon: "VP", section: "operations", permission: "can_view_calls" },
  { href: "/dashboard/voice/provisioning", label: "Provisioning", icon: "PV", section: "operations", permission: "can_view_calls" },
  { href: "/dashboard/voice/sbc-test", label: "SBC Test", icon: "SB", section: "operations", permission: "can_view_calls" },
  { href: "/reports", label: "Reports", icon: "RP", section: "operations", permission: "can_view_reports" },
  { href: "/team", label: "Team", icon: "TM", section: "operations", permission: "can_view_team" },
  { href: "/chat", label: "Chat", icon: "CH", section: "communications", permission: "can_view_chat" },
  { href: "/sms", label: "SMS", icon: "SM", section: "communications", permission: "can_view_sms" },
  { href: "/voicemail", label: "Voicemail", icon: "VM", section: "communications", permission: "can_view_voicemail" },
  { href: "/recordings", label: "Recordings", icon: "RC", section: "communications", permission: "can_view_recordings" },
  { href: "/contacts", label: "Customers", icon: "CU", section: "crm", permission: "can_view_contacts" },
  { href: "/apps", label: "Apps", icon: "AP", section: "crm", permission: "can_view_apps" },
  { href: "/settings", label: "Settings", icon: "ST", section: "platform", permission: "can_view_settings" },
  { href: "/dashboard/admin/pbx/instances", label: "PBX Instances", icon: "PI", section: "platform", permission: "can_view_admin" },
  { href: "/dashboard/admin/pbx/events", label: "PBX Events", icon: "PE", section: "platform", permission: "can_view_admin" },
  { href: "/admin", label: "Admin", icon: "AD", section: "platform", permission: "can_view_admin" }
];

export const navSectionMeta: Record<NavItem["section"], { label: string; railIcon: string }> = {
  operations: { label: "Operations", railIcon: "OP" },
  communications: { label: "Messaging", railIcon: "MS" },
  crm: { label: "CRM", railIcon: "CR" },
  platform: { label: "Platform", railIcon: "PL" }
};
