import type { Permission } from "../types/app";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  permission: Permission;
};

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "◫", permission: "can_view_dashboard" },
  { href: "/team", label: "Team", icon: "👥", permission: "can_view_team" },
  { href: "/chat", label: "Chat", icon: "💬", permission: "can_view_chat" },
  { href: "/sms", label: "SMS", icon: "✉", permission: "can_view_sms" },
  { href: "/calls", label: "Calls", icon: "📞", permission: "can_view_calls" },
  { href: "/voicemail", label: "Voicemail", icon: "◉", permission: "can_view_voicemail" },
  { href: "/contacts", label: "Contacts", icon: "⌂", permission: "can_view_contacts" },
  { href: "/recordings", label: "Recordings", icon: "⟲", permission: "can_view_recordings" },
  { href: "/reports", label: "Reports", icon: "▦", permission: "can_view_reports" },
  { href: "/settings", label: "Settings", icon: "⚙", permission: "can_view_settings" },
  { href: "/admin", label: "Admin", icon: "⛭", permission: "can_view_admin" },
  { href: "/apps", label: "Apps", icon: "⬚", permission: "can_view_apps" }
];
