import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  Banknote,
  BarChart3,
  Building,
  Building2,
  Clock,
  Contact,
  CreditCard,
  Disc,
  FileCheck,
  FileText,
  GitBranch,
  Grid3X3,
  Headphones,
  History,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  Mail,
  Map,
  Megaphone,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Mic2,
  Music,
  Network,
  Phone,
  PhoneForwarded,
  Plane,
  Receipt,
  Rocket,
  Route,
  Send,
  Server,
  Shield,
  UserCog,
  Users,
  UsersRound,
  Voicemail,
  Wallet,
  Zap
} from "lucide-react";
import type { Permission } from "../types/app";

export type NavItem = {
  href: string;
  label: string;
  /** @deprecated two-letter rail fallback; prefer `lucide` */
  icon: string;
  lucide: LucideIcon;
  section: "dashboard" | "pbx" | "settings" | "admin" | "billing" | "apps";
  permission: Permission;
};

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: "OV", lucide: LayoutDashboard, section: "dashboard", permission: "can_view_dashboard" },
  { href: "/team", label: "Team Directory", icon: "TM", lucide: Users, section: "dashboard", permission: "can_view_team" },
  { href: "/calls", label: "Call History", icon: "CL", lucide: Phone, section: "dashboard", permission: "can_view_calls" },
  { href: "/calls/health", label: "System Health", icon: "SH", lucide: Activity, section: "dashboard", permission: "can_view_calls" },
  { href: "/voicemail", label: "Voicemail", icon: "VM", lucide: Voicemail, section: "dashboard", permission: "can_view_voicemail" },
  { href: "/sms", label: "SMS Inbox", icon: "SM", lucide: MessageSquare, section: "dashboard", permission: "can_view_sms" },
  { href: "/chat", label: "Chat", icon: "CH", lucide: MessagesSquare, section: "dashboard", permission: "can_view_chat" },
  { href: "/contacts", label: "Contacts", icon: "CO", lucide: Contact, section: "dashboard", permission: "can_view_contacts" },

  { href: "/pbx/extensions", label: "Extensions", icon: "EX", lucide: UserCog, section: "pbx", permission: "can_view_team" },
  { href: "/pbx/time-conditions", label: "Time Conditions", icon: "TC", lucide: Clock, section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/softphone", label: "WebRTC Softphone", icon: "SP", lucide: Headphones, section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/sbc-connectivity", label: "SBC Connectivity", icon: "SB", lucide: Network, section: "pbx", permission: "can_view_calls" },
  { href: "/pbx/ivr-routing", label: "IVR Routing", icon: "IR", lucide: GitBranch, section: "pbx", permission: "can_view_ivr_routing" },
  { href: "/pbx/did-routing", label: "DID Routing", icon: "DR", lucide: Route, section: "pbx", permission: "can_view_did_routing" },
  { href: "/pbx/moh-scheduling", label: "MOH Scheduling", icon: "MH", lucide: Music, section: "pbx", permission: "can_view_moh" },
  { href: "/pbx/call-recordings", label: "Call Recordings", icon: "CR", lucide: Disc, section: "pbx", permission: "can_view_recordings" },
  { href: "/pbx/call-reports", label: "Call Reports", icon: "CP", lucide: BarChart3, section: "pbx", permission: "can_view_reports" },

  { href: "/settings", label: "Tenant Settings", icon: "TS", lucide: Building2, section: "settings", permission: "can_view_settings" },
  { href: "/settings/email", label: "Email Settings", icon: "EM", lucide: Mail, section: "settings", permission: "can_view_settings" },
  { href: "/settings/billing", label: "Billing Settings", icon: "BS", lucide: CreditCard, section: "settings", permission: "can_view_settings" },
  { href: "/settings/messaging", label: "Messaging Settings", icon: "MS", lucide: Send, section: "settings", permission: "can_view_settings" },

  { href: "/admin", label: "Admin Console", icon: "AD", lucide: Shield, section: "admin", permission: "can_view_admin" },
  { href: "/admin/tenants", label: "Tenants", icon: "TN", lucide: Building, section: "admin", permission: "can_view_admin" },
  { href: "/admin/pbx", label: "PBX Instances", icon: "PI", lucide: Server, section: "admin", permission: "can_view_admin" },
  { href: "/admin/pbx/events", label: "PBX Events", icon: "PE", lucide: Zap, section: "admin", permission: "can_view_admin" },
  { href: "/admin/permissions", label: "Permissions", icon: "PM", lucide: Lock, section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/billing", label: "Admin Billing", icon: "AB", lucide: Wallet, section: "admin", permission: "can_view_admin" },
  { href: "/admin/cdr-tenant-map", label: "CDR Tenant Map", icon: "CM", lucide: Map, section: "admin", permission: "can_view_admin" },
  { href: "/admin/ops-center", label: "Ops Center", icon: "OC", lucide: LayoutGrid, section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/incidents", label: "Incident Center", icon: "IC", lucide: AlertTriangle, section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/audio-intelligence", label: "Audio Intelligence", icon: "AI", lucide: Mic2, section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/call-timeline", label: "Call Timeline", icon: "CT", lucide: History, section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/call-flight", label: "Call Flight Recorder", icon: "CF", lucide: Plane, section: "admin", permission: "can_manage_global_settings" },
  { href: "/admin/deploy-center", label: "Deploy Center", icon: "DC", lucide: Rocket, section: "admin", permission: "can_manage_deploys" },

  { href: "/billing", label: "Billing Overview", icon: "BL", lucide: Receipt, section: "billing", permission: "can_view_reports" },
  { href: "/billing/invoices", label: "Invoices", icon: "IN", lucide: FileText, section: "billing", permission: "can_view_reports" },
  { href: "/billing/payments", label: "Payments", icon: "PM", lucide: Banknote, section: "billing", permission: "can_view_reports" },
  { href: "/billing/receipts", label: "Receipts", icon: "RC", lucide: FileCheck, section: "billing", permission: "can_view_reports" },

  { href: "/apps", label: "Apps", icon: "AP", lucide: Grid3X3, section: "apps", permission: "can_view_apps" },
  { href: "/apps/sms-campaigns", label: "SMS Campaigns", icon: "SC", lucide: Megaphone, section: "apps", permission: "can_view_sms" },
  { href: "/apps/whatsapp", label: "WhatsApp Inbox", icon: "WA", lucide: MessageCircle, section: "apps", permission: "can_view_sms" },
  { href: "/apps/voip-ms", label: "VoIP.ms", icon: "VP", lucide: PhoneForwarded, section: "apps", permission: "can_manage_voip_ms" },
  { href: "/apps/customers", label: "Customer Hub", icon: "CU", lucide: UsersRound, section: "apps", permission: "can_view_contacts" }
];

/** Sidebar section order: Workspace → PBX → Apps → Billing → Admin → Settings */
export const NAV_SECTION_ORDER: NavItem["section"][] = ["dashboard", "pbx", "apps", "billing", "admin", "settings"];

export const navSectionMeta: Record<NavItem["section"], { label: string; railIcon: string }> = {
  dashboard: { label: "Workspace", railIcon: "WS" },
  pbx: { label: "PBX", railIcon: "PB" },
  settings: { label: "Settings", railIcon: "ST" },
  admin: { label: "Admin", railIcon: "AD" },
  billing: { label: "Billing", railIcon: "BL" },
  apps: { label: "Apps", railIcon: "AP" }
};
