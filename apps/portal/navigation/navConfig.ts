import type { Permission } from "../types/app";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  section: "dashboard" | "pbx" | "reports" | "settings" | "admin" | "billing" | "apps";
  permission: Permission;
};

export const navItems: NavItem[] = [
  { href: "/dashboard",          label: "Overview",          icon: "OV", section: "dashboard", permission: "can_view_dashboard" },
  { href: "/dashboard/presence", label: "Extension Presence",icon: "EP", section: "dashboard", permission: "can_view_live_calls" },
  { href: "/team",               label: "Team Directory",    icon: "TM", section: "dashboard", permission: "can_view_team" },
  { href: "/calls",              label: "Call History",      icon: "CL", section: "dashboard", permission: "can_view_calls" },
  { href: "/voicemail",          label: "Voicemail",         icon: "VM", section: "dashboard", permission: "can_view_voicemail" },
  { href: "/sms",                label: "SMS Inbox",         icon: "SM", section: "dashboard", permission: "can_view_sms" },
  { href: "/chat",               label: "Chat",              icon: "CH", section: "dashboard", permission: "can_view_chat" },
  { href: "/contacts",           label: "Contacts",          icon: "CO", section: "dashboard", permission: "can_view_contacts" },

  { href: "/pbx",                label: "PBX Overview",      icon: "PB", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/extensions",     label: "Extensions",        icon: "EX", section: "pbx", permission: "can_view_team" },
  { href: "/pbx/ring-groups",    label: "Ring Groups",       icon: "RG", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/queues",         label: "Queues",            icon: "QU", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/ivr",            label: "IVR Builder",       icon: "IV", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/ivr/override",   label: "IVR Override",      icon: "IO", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/time-conditions",label: "Time Conditions",   icon: "TC", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/announcements",  label: "Announcements",     icon: "AN", section: "pbx", permission: "can_view_recordings" },
  { href: "/pbx/trunks",         label: "Trunks",            icon: "TR", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/inbound-routes", label: "Inbound Routes",    icon: "IR", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/outbound-routes",label: "Outbound Routes",   icon: "OR", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/provisioning",   label: "Provisioning",      icon: "PR", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/softphone",      label: "WebRTC Softphone",  icon: "SP", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/sbc-connectivity",label: "SBC Connectivity", icon: "SB", section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/call-recordings",label: "Call Recordings",   icon: "CR", section: "pbx", permission: "can_view_recordings" },
  { href: "/pbx/call-reports",   label: "Call Reports",      icon: "CP", section: "pbx", permission: "can_view_reports" },
  { href: "/pbx/events-jobs",    label: "PBX Events & Jobs", icon: "EV", section: "pbx", permission: "can_view_admin" },

  { href: "/reports",             label: "Operations Reports",icon: "RP", section: "reports", permission: "can_view_reports" },
  { href: "/reports/cdr",         label: "CDR",               icon: "CD", section: "reports", permission: "can_view_reports" },
  { href: "/reports/queues",      label: "Queue Reports",     icon: "QR", section: "reports", permission: "can_view_reports" },
  { href: "/reports/performance", label: "Agent Performance", icon: "AP", section: "reports", permission: "can_view_reports" },

  { href: "/settings",             label: "Tenant Settings",  icon: "TS", section: "settings", permission: "can_view_settings" },
  { href: "/settings/voice",       label: "Voice Settings",   icon: "VS", section: "settings", permission: "can_view_settings" },
  { href: "/settings/providers",   label: "Provider Settings",icon: "PS", section: "settings", permission: "can_view_settings" },
  { href: "/settings/email",       label: "Email Settings",   icon: "EM", section: "settings", permission: "can_view_settings" },
  { href: "/settings/billing",     label: "Billing Settings", icon: "BS", section: "settings", permission: "can_view_settings" },
  { href: "/settings/messaging",   label: "Messaging Settings",icon: "MS", section: "settings", permission: "can_view_settings" },
  { href: "/settings/webrtc",      label: "WebRTC Policy",    icon: "WP", section: "settings", permission: "can_view_settings" },

  { href: "/admin",              label: "Admin Console",      icon: "AD", section: "admin", permission: "can_view_admin" },
  { href: "/admin/tenants",      label: "Tenants",            icon: "TN", section: "admin", permission: "can_view_admin" },
  { href: "/admin/pbx",          label: "PBX Instances",      icon: "PI", section: "admin", permission: "can_view_admin" },
  { href: "/admin/pbx/events",   label: "PBX Events",         icon: "PE", section: "admin", permission: "can_view_admin" },
  { href: "/admin/permissions",  label: "Permissions",        icon: "PM", section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/billing",      label: "Admin Billing",      icon: "AB", section: "admin", permission: "can_view_admin" },

  { href: "/billing",            label: "Billing Overview",   icon: "BL", section: "billing", permission: "can_view_reports" },
  { href: "/billing/invoices",   label: "Invoices",           icon: "IN", section: "billing", permission: "can_view_reports" },
  { href: "/billing/payments",   label: "Payments",           icon: "PM", section: "billing", permission: "can_view_reports" },
  { href: "/billing/receipts",   label: "Receipts",           icon: "RC", section: "billing", permission: "can_view_reports" },

  { href: "/apps",               label: "Apps",               icon: "AP", section: "apps", permission: "can_view_apps" },
  { href: "/apps/sms-campaigns", label: "SMS Campaigns",      icon: "SC", section: "apps", permission: "can_view_sms" },
  { href: "/apps/whatsapp",      label: "WhatsApp Inbox",     icon: "WA", section: "apps", permission: "can_view_sms" },
  { href: "/apps/customers",     label: "Customer Hub",       icon: "CU", section: "apps", permission: "can_view_contacts" }
];

export const navSectionMeta: Record<NavItem["section"], { label: string; railIcon: string }> = {
  dashboard: { label: "Workspace",  railIcon: "WS" },
  pbx:       { label: "PBX",        railIcon: "PB" },
  reports:   { label: "Reports",    railIcon: "RP" },
  settings:  { label: "Settings",   railIcon: "ST" },
  admin:     { label: "Admin",      railIcon: "AD" },
  billing:   { label: "Billing",    railIcon: "BL" },
  apps:      { label: "Apps",       railIcon: "AP" }
};
