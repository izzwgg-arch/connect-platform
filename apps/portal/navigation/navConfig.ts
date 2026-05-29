import type { LucideIcon } from "lucide-react";
import type { PortalSidebarSectionKey } from "@connect/shared";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building,
  Building2,
  Clock,
  Contact,
  CreditCard,
  Disc,
  Download,
  FileText,
  GitBranch,
  Grid3X3,
  Hash,
  Headphones,
  History,
  CheckSquare,
  FileUp,
  PhoneCall,
  ClipboardList,
  HandCoins,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  Mail,
  Map,
  ListOrdered,
  Megaphone,
  MessageCircle,
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
  Settings2,
  Shield,
  Stethoscope,
  UserCog,
  Users,
  UsersRound,
  Voicemail,
  Wallet,
  Zap
} from "lucide-react";
import type { Permission } from "../types/app";

export type NavItem = {
  id: string;
  href: string;
  label: string;
  /** @deprecated two-letter rail fallback; prefer `lucide` */
  icon: string;
  lucide: LucideIcon;
  section: PortalSidebarSectionKey;
  sectionPermission: Permission;
  permission: Permission;
  download?: boolean;
};

export const navItems: NavItem[] = [
  { id: "workspace.overview", href: "/dashboard", label: "Overview", icon: "OV", lucide: LayoutDashboard, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_overview" },
  { id: "workspace.team", href: "/team", label: "Team Directory", icon: "TM", lucide: Users, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_team_directory" },
  { id: "workspace.calls", href: "/calls", label: "Call History", icon: "CL", lucide: Phone, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_call_history" },
  { id: "workspace.voicemail", href: "/voicemail", label: "Voicemail", icon: "VM", lucide: Voicemail, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_voicemail" },
  { id: "workspace.chat", href: "/chat", label: "Chat", icon: "CH", lucide: MessagesSquare, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_chat" },
  { id: "workspace.contacts", href: "/contacts", label: "Contacts", icon: "CO", lucide: Contact, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_contacts" },
  { id: "workspace.install", href: "/downloads/Connect-Setup-0.1.0.exe", label: "Install", icon: "IN", lucide: Download, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_contacts", download: true },

  { id: "pbx.extensions", href: "/pbx/extensions", label: "Extensions", icon: "EX", lucide: UserCog, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_extensions" },
  { id: "pbx.time_conditions", href: "/pbx/time-conditions", label: "Time Conditions", icon: "TC", lucide: Clock, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_time_conditions" },
  { id: "pbx.softphone", href: "/pbx/softphone", label: "WebRTC Softphone", icon: "SP", lucide: Headphones, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_softphone" },
  { id: "pbx.sbc_connectivity", href: "/pbx/sbc-connectivity", label: "SBC Connectivity", icon: "SB", lucide: Network, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_sbc_connectivity" },
  { id: "pbx.ivr_routing", href: "/pbx/ivr-routing", label: "IVR Routing", icon: "IR", lucide: GitBranch, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_ivr_routing" },
  { id: "pbx.did_routing", href: "/pbx/did-routing", label: "DID Routing", icon: "DR", lucide: Route, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_did_routing" },
  { id: "pbx.moh_scheduling", href: "/pbx/moh-scheduling", label: "MOH Scheduling", icon: "MH", lucide: Music, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_moh_scheduling" },
  { id: "pbx.call_recordings", href: "/pbx/call-recordings", label: "Call Recordings", icon: "CR", lucide: Disc, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_call_recordings" },
  { id: "pbx.call_reports", href: "/pbx/call-reports", label: "Call Reports", icon: "CP", lucide: BarChart3, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_call_reports" },

  { id: "crm.dashboard", href: "/crm/dashboard", label: "CRM Dashboard", icon: "CD", lucide: LayoutDashboard, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_dashboard" },
  { id: "crm.queue", href: "/crm/queue", label: "My Queue", icon: "CQ", lucide: ListOrdered, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_queue" },
  { id: "crm.contacts", href: "/crm/contacts", label: "Contacts", icon: "CC", lucide: UsersRound, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_contacts" },
  { id: "crm.funders", href: "/crm/funders", label: "Funders", icon: "FU", lucide: HandCoins, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_funders" },
  { id: "crm.email", href: "/crm/email", label: "Email", icon: "CE", lucide: Mail, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_settings" },
  { id: "crm.campaigns", href: "/crm/campaigns", label: "Campaigns", icon: "CA", lucide: Megaphone, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_campaigns" },
  { id: "crm.live_call", href: "/crm/live-call", label: "Live Call Workspace", icon: "CL", lucide: PhoneCall, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_live_call" },
  { id: "crm.tasks", href: "/crm/tasks", label: "Tasks", icon: "CT", lucide: CheckSquare, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_tasks" },
  { id: "crm.scripts", href: "/crm/scripts", label: "Scripts", icon: "CS", lucide: FileText, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_scripts" },
  { id: "crm.voicemail_drops", href: "/crm/voicemail-drops", label: "Voicemail Drops", icon: "VM", lucide: Voicemail, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_voicemail_drops" },
  { id: "crm.checklists", href: "/crm/checklists", label: "Checklists", icon: "CC", lucide: ClipboardList, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_checklists" },
  { id: "crm.reports", href: "/crm/reports", label: "Reports", icon: "CR", lucide: BarChart3, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_reports" },
  { id: "crm.wallboard", href: "/crm/wallboard", label: "Live Wallboard", icon: "CW", lucide: LayoutGrid, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_wallboard" },
  { id: "crm.settings", href: "/crm/settings", label: "CRM Settings", icon: "CS", lucide: Settings2, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_settings" },
  { id: "crm.diagnostics", href: "/crm/admin/diagnostics", label: "CRM Diagnostics", icon: "DX", lucide: Stethoscope, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_settings" },

  { id: "settings.tenant", href: "/settings", label: "Tenant Settings", icon: "TS", lucide: Building2, section: "settings", sectionPermission: "can_view_section_settings", permission: "can_view_settings_tenant" },
  { id: "settings.email", href: "/settings/email", label: "Email Settings", icon: "EM", lucide: Mail, section: "settings", sectionPermission: "can_view_section_settings", permission: "can_view_settings_email" },
  { id: "settings.system_health", href: "/calls/health", label: "System Health", icon: "SH", lucide: Activity, section: "settings", sectionPermission: "can_view_section_settings", permission: "can_view_settings_system_health" },
  { id: "settings.billing", href: "/billing/settings", label: "Billing Settings", icon: "BS", lucide: CreditCard, section: "settings", sectionPermission: "can_view_section_settings", permission: "can_view_settings_billing" },
  { id: "settings.messaging", href: "/settings/messaging", label: "Messaging Settings", icon: "MS", lucide: Send, section: "settings", sectionPermission: "can_view_section_settings", permission: "can_view_settings_messaging" },

  { id: "admin.console", href: "/admin", label: "Admin Console", icon: "AD", lucide: Shield, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_console" },
  { id: "admin.users", href: "/admin/users", label: "Users", icon: "US", lucide: Users, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_users" },
  { id: "admin.tenants", href: "/admin/tenants", label: "Tenants", icon: "TN", lucide: Building, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_tenants" },
  { id: "admin.pbx_instances", href: "/admin/pbx", label: "PBX Instances", icon: "PI", lucide: Server, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_pbx_instances" },
  { id: "admin.pbx_events", href: "/admin/pbx/events", label: "PBX Events", icon: "PE", lucide: Zap, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_pbx_events" },
  { id: "admin.permissions", href: "/admin/permissions", label: "Permissions", icon: "PM", lucide: Lock, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_permissions" },
  { id: "admin.billing", href: "/admin/billing", label: "Admin Billing", icon: "AB", lucide: Wallet, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_billing" },
  { id: "admin.cdr_tenant_map", href: "/admin/cdr-tenant-map", label: "CDR Tenant Map", icon: "CM", lucide: Map, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_cdr_tenant_map" },
  { id: "admin.ops_center", href: "/admin/ops-center", label: "Ops Center", icon: "OC", lucide: LayoutGrid, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_ops_center" },
  { id: "admin.incidents", href: "/admin/incidents", label: "Incident Center", icon: "IC", lucide: AlertTriangle, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_incidents" },
  { id: "admin.audio_intelligence", href: "/admin/audio-intelligence", label: "Audio Intelligence", icon: "AI", lucide: Mic2, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_audio_intelligence" },
  { id: "admin.call_timeline", href: "/admin/call-timeline", label: "Call Timeline", icon: "CT", lucide: History, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_call_timeline" },
  { id: "admin.call_flight", href: "/admin/call-flight", label: "Call Flight Recorder", icon: "CF", lucide: Plane, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_call_flight" },
  { id: "admin.deploy_center", href: "/admin/deploy-center", label: "Deploy Center", icon: "DC", lucide: Rocket, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_deploy_center" },
  { id: "admin.roles", href: "/admin/roles", label: "Custom Roles", icon: "RO", lucide: Shield, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_roles" },
  { id: "admin.phone_numbers", href: "/admin/phone-numbers", label: "Phone Numbers", icon: "PN", lucide: Hash, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_phone_numbers" },
  { id: "admin.onboarding", href: "/admin/onboarding", label: "Onboarding", icon: "OB", lucide: ClipboardList, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_onboarding" },

  { id: "billing.overview", href: "/billing", label: "Billing Overview", icon: "BL", lucide: Receipt, section: "billing", sectionPermission: "can_view_section_billing", permission: "can_view_billing_overview" },

  { id: "apps.home", href: "/apps", label: "Apps", icon: "AP", lucide: Grid3X3, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_home" },
  { id: "apps.sms_campaigns", href: "/apps/sms-campaigns", label: "SMS Campaigns", icon: "SC", lucide: Megaphone, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_sms_campaigns" },
  { id: "apps.whatsapp", href: "/apps/whatsapp", label: "WhatsApp Inbox", icon: "WA", lucide: MessageCircle, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_whatsapp_inbox" },
  { id: "apps.voip_ms", href: "/apps/voip-ms", label: "VoIP.ms", icon: "VP", lucide: PhoneForwarded, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_voip_ms" },
  { id: "apps.customers", href: "/apps/customers", label: "Customer Hub", icon: "CU", lucide: UsersRound, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_customer_hub" }
];

/** Sidebar section order: Workspace → PBX → CRM → Apps → Billing → Admin → Settings */
export const NAV_SECTION_ORDER: NavItem["section"][] = ["workspace", "pbx", "crm", "apps", "billing", "admin", "settings"];

export const navSectionMeta: Record<NavItem["section"], { label: string; railIcon: string }> = {
  workspace: { label: "Workspace", railIcon: "WS" },
  pbx: { label: "PBX", railIcon: "PB" },
  crm: { label: "CRM", railIcon: "CR" },
  settings: { label: "Settings", railIcon: "ST" },
  admin: { label: "Admin", railIcon: "AD" },
  billing: { label: "Billing", railIcon: "BL" },
  apps: { label: "Apps", railIcon: "AP" }
};

/** Admin Billing nav + /admin/billing API require JWT SUPER_ADMIN (platform), not only portal permission. */
export function isNavItemVisibleForUser(
  item: NavItem,
  can: (permission: Permission) => boolean,
  backendJwtRole: string | undefined,
): boolean {
  if (!can(item.sectionPermission) || !can(item.permission)) return false;
  if (item.id === "crm.diagnostics") {
    const jwtAdmin =
      backendJwtRole === "ADMIN" ||
      backendJwtRole === "TENANT_ADMIN" ||
      backendJwtRole === "SUPER_ADMIN";
    if (!jwtAdmin) return false;
  }
  if (item.id === "admin.billing" && backendJwtRole !== "SUPER_ADMIN") return false;
  return true;
}
