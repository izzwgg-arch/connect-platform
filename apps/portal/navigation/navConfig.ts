import type { LucideIcon } from "lucide-react";
import type { PortalSidebarSectionKey } from "@connect/shared";
import {
  Activity,
  AlertTriangle,
  AudioLines,
  Bot,
  BarChart3,
  Building,
  Building2,
  Clock,
  Contact,
  CreditCard,
  Disc,
  Download,
  FileText,
  FileSignature,
  GitBranch,
  Grid3X3,
  HardDrive,
  GraduationCap,
  Hash,
  Headphones,
  History,
  CheckSquare,
  FileUp,
  PhoneCall,
  ClipboardList,
  HandCoins,
  CalendarCheck,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  Mail,
  Map,
  ListOrdered,
  Megaphone,
  MessageCircle,
  AtSign,
  MessagesSquare,
  LifeBuoy,
  Mic2,
  Music,
  Network,
  Phone,
  PhoneForwarded,
  Radio,
  Plane,
  Receipt,
  Rocket,
  Route,
  Send,
  Server,
  SlidersHorizontal,
  Settings2,
  Shield,
  Stethoscope,
  UserCog,
  Users,
  UsersRound,
  Video,
  Voicemail,
  Wallet,
  Zap,
  KeyRound,
  Package,
  Tag,
  Truck
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
  /** Key used to look up a numeric unread badge from the badges map in SidebarNav. */
  badgeKey?: "chat" | "voicemail";
};

export const navItems: NavItem[] = [
  { id: "workspace.overview", href: "/dashboard", label: "Overview", icon: "OV", lucide: LayoutDashboard, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_overview" },
  { id: "workspace.team", href: "/team", label: "Team Directory", icon: "TM", lucide: Users, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_team_directory" },
  { id: "workspace.calls", href: "/calls", label: "Call History", icon: "CL", lucide: Phone, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_call_history" },
  { id: "workspace.voicemail", href: "/voicemail", label: "Voicemail", icon: "VM", lucide: Voicemail, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_voicemail", badgeKey: "voicemail" },
  { id: "workspace.chat", href: "/chat", label: "Chat", icon: "CH", lucide: MessagesSquare, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_chat", badgeKey: "chat" },
  { id: "workspace.contacts", href: "/contacts", label: "Contacts", icon: "CO", lucide: Contact, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_contacts" },
  // Loopcom Direct (2026-08-21) — cross-company chat by phone number. Rides the
  // SAME key as Chat: anybody who may use Workspace chat may use Direct, and the
  // real gate is that a person has verified their own mobile number (with no
  // verified identity every screen shows the "verify to get started" state).
  // ⛔ A dedicated key would not reach TENANT_ADMIN without a live permission
  // snapshot refresh — see the Meetings note below.
  { id: "workspace.direct", href: "/direct", label: "Direct", icon: "DR", lucide: AtSign, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_chat" },
  // Loopcom Meetings (2026-08-20). Reuses the overview key on purpose — a
  // dedicated can_view_workspace_meetings key needs the live permission
  // snapshot updated (custom-roles-are-authoritative: code defaults do NOT
  // reach the live PlatformRolePermissionSnapshot row), which is a follow-up
  // with Izzy. Same precedent as the Install link reusing the contacts key.
  { id: "workspace.meetings", href: "/meetings", label: "Meetings", icon: "VC", lucide: Video, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_overview" },
  // Desk phone setup — Izzy, 2026-08-22: "add an option in the workspace sidebar
  // to connect my desk phones … only system owners should see it". Placed
  // ABOVE Conference: Conference's slot "immediately before Install" is
  // Izzy's exact recorded placement (2026-08-20) and a guard pins it.
  // ⛔ The permission is the SAME key the page's PermissionGate and every api
  // route already gate on ([[a-gate-must-agree-with-the-gate-behind-it]]): a
  // different nav key here is either a visible door that refuses on click or an
  // invisible page that works. can_setup_desk_phones is in NO default bucket,
  // so only SUPER_ADMIN (the force-add bucket) sees this until it is granted —
  // and because it is an ACTION key, the custom-roles editor already offers it,
  // and this nav entry is what makes it appear in /admin/permissions too.
  { id: "workspace.desk_phones", href: "/settings/desk-phones", label: "Desk Phones", icon: "DP", lucide: PhoneCall, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_setup_desk_phones" },
  // Supermarket mode (Gesheft plan). All four keys are in NO default bucket, so
  // only supermarket reps who were granted them (and SUPER_ADMIN via force-add)
  // ever see these — classic tenants keep an unchanged sidebar. The nav key IS
  // the page + api key (a-gate-must-agree-with-the-gate-behind-it).
  { id: "store.orders", href: "/orders", label: "Orders", icon: "OR", lucide: Package, section: "store", sectionPermission: "can_view_section_store", permission: "can_view_supermarket_orders" },
  { id: "store.deliveries", href: "/orders/deliveries", label: "Deliveries", icon: "DL", lucide: Truck, section: "store", sectionPermission: "can_view_section_store", permission: "can_view_supermarket_orders" },
  { id: "store.drivers", href: "/orders/drivers", label: "Drivers", icon: "DR", lucide: Users, section: "store", sectionPermission: "can_view_section_store", permission: "can_view_supermarket_orders" },
  { id: "store.specials", href: "/orders/specials", label: "Specials", icon: "SP", lucide: Tag, section: "store", sectionPermission: "can_view_section_store", permission: "can_view_supermarket_orders" },
  { id: "store.teach", href: "/orders/teach", label: "Teach the Agent", icon: "TA", lucide: GraduationCap, section: "store", sectionPermission: "can_view_section_store", permission: "can_view_supermarket_orders" },
  // Conference rooms — right before Install, per Izzy (2026-08-20). Visible to
  // whoever holds can_view_conferences (TENANT_ADMIN by default): the nav key
  // rides that action key's expansion in @connect/shared.
  { id: "workspace.conference", href: "/conference", label: "Conference", icon: "CN", lucide: UsersRound, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_conference" },
  // Stable alias (server keeps it pointing at the newest installer) so this
  // link never goes stale when a new version is published.
  { id: "workspace.install", href: "/desktop/Connect-Setup-latest.exe", label: "Install", icon: "IN", lucide: Download, section: "workspace", sectionPermission: "can_view_section_workspace", permission: "can_view_workspace_contacts", download: true },

  { id: "pbx.extensions", href: "/pbx/extensions", label: "Extensions", icon: "EX", lucide: UserCog, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_extensions" },
  { id: "pbx.time_conditions", href: "/pbx/time-conditions", label: "Time Conditions", icon: "TC", lucide: Clock, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_time_conditions" },
  { id: "pbx.softphone", href: "/pbx/softphone", label: "WebRTC Softphone", icon: "SP", lucide: Headphones, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_softphone" },
  { id: "pbx.sbc_connectivity", href: "/pbx/sbc-connectivity", label: "SBC Connectivity", icon: "SB", lucide: Network, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_sbc_connectivity" },
  { id: "pbx.ivr_routing", href: "/pbx/ivr-studio", label: "IVR Studio", icon: "IR", lucide: GitBranch, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_ivr_routing" },
  { id: "pbx.ivr_migration", href: "/pbx/ivr-migration", label: "IVR Migration", icon: "IM", lucide: GitBranch, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_ivr_routing" },
  { id: "pbx.did_routing", href: "/pbx/did-routing", label: "DID Routing", icon: "DR", lucide: Route, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_did_routing" },
  { id: "pbx.moh_scheduling", href: "/pbx/moh-scheduling", label: "MOH Scheduling", icon: "MH", lucide: Music, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_moh_scheduling" },
  { id: "pbx.call_recordings", href: "/pbx/call-recordings", label: "Call Recordings", icon: "CR", lucide: Disc, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_call_recordings" },
  { id: "pbx.call_reports", href: "/pbx/call-reports", label: "Call Reports", icon: "CP", lucide: BarChart3, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_call_reports" },
  { id: "pbx.queues", href: "/queues", label: "Queues", icon: "QU", lucide: ListOrdered, section: "pbx", sectionPermission: "can_view_section_pbx", permission: "can_view_pbx_queues" },

  { id: "crm.dashboard", href: "/crm/dashboard", label: "CRM Dashboard", icon: "CD", lucide: LayoutDashboard, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_dashboard" },
  { id: "crm.queue", href: "/crm/queue", label: "My Queue", icon: "CQ", lucide: ListOrdered, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_queue" },
  { id: "crm.contacts", href: "/crm/contacts", label: "Contacts", icon: "CC", lucide: UsersRound, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_contacts" },
  { id: "crm.forms", href: "/crm/forms", label: "Forms", icon: "CF", lucide: FileSignature, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_forms" },
  { id: "crm.funders", href: "/crm/funders", label: "Funders", icon: "FU", lucide: HandCoins, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_funders" },
  { id: "crm.email", href: "/crm/email", label: "Email", icon: "CE", lucide: Mail, section: "crm", sectionPermission: "can_view_section_crm", permission: "can_view_crm_email" },
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

  // Support Desk (2026-08-20) — FIRST in the Admin section, per Izzy: it is the
  // daily-driver screen (escalations + every company's chats + the assistant
  // take-over), and it was unfindable at position 9 of 25.
  // ⛔ SUPER_ADMIN-only in isNavItemVisibleForUser (the pbx-console pattern):
  // it shows every company's escalations, so it shares an owner-held key and
  // there is deliberately no grantable one yet.
  { id: "admin.support", href: "/admin/support", label: "Support Desk", icon: "SD", lucide: LifeBuoy, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_assistant" },
  // Compliance calendar (2026-08-23, Izzy): the regulatory deadlines page —
  // RMD recert, CPNI, 499-A, CVAA, BDC. SUPER_ADMIN only (forced below), keyed
  // on can_manage_global_settings so the nav key and the api's
  // /admin/compliance PORTAL_API_PERMISSION_RULES entry say the same thing.
  { id: "admin.compliance", href: "/admin/compliance", label: "Compliance", icon: "CO", lucide: CalendarCheck, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_manage_global_settings" },
  { id: "admin.console", href: "/admin", label: "Admin Console", icon: "AD", lucide: Shield, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_console" },
  { id: "admin.users", href: "/admin/users", label: "Users", icon: "US", lucide: Users, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_users" },
  { id: "admin.tenants", href: "/admin/tenants", label: "Tenants", icon: "TN", lucide: Building, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_tenants" },
  { id: "admin.pbx_instances", href: "/admin/pbx", label: "PBX Instances", icon: "PI", lucide: Server, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_pbx_instances" },
  // PBX Console (2026-08-19) — replaces the VitalPBX panel for tenants /
  // extensions / provisioning / geo once the licence lapses. SUPER_ADMIN only
  // (forced below), reuses the PBX-instances view key; no grantable key.
  // ⛔ These three carry `can_manage_global_settings`, NOT the PBX-instances
  // key, and the difference is the whole point (2026-08-20 tenant-leak sweep):
  // the live snapshot gives TENANT_ADMIN `can_view_admin_pbx_instances` (10
  // active tenant admins hold it), so keying the console off it made the
  // SUPER_ADMIN force line below the ONLY thing hiding a platform-wide console
  // from customers — one refactor away from advertising every company's trunks
  // and dial plans in a customer's sidebar. `can_manage_global_settings` is
  // held by SUPER_ADMIN alone and is exactly what the api's
  // PORTAL_API_PERMISSION_RULES entry for /admin/pbx-console already demands,
  // so the nav key and the server gate now say the same thing.
  { id: "admin.pbx_console", href: "/admin/pbx-console", label: "PBX Console", icon: "PC", lucide: SlidersHorizontal, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_manage_global_settings" },
  // Per-tenant integration keys + CRM modes (supermarket plan Phase 5) —
  // SUPER_ADMIN only, forced in isNavItemVisibleForUser like the console.
  { id: "admin.integrations", href: "/admin/integrations", label: "Integrations", icon: "IK", lucide: KeyRound, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_manage_global_settings" },
  // Conversational order-taking voice agent settings (2026-08-26) — SUPER_ADMIN
  // only, forced in isNavItemVisibleForUser like the console. The OpenAI key
  // itself is entered on admin.integrations (one writer, one ProviderCredential
  // row); this screen is voice/greeting/caps/enable + per-call history.
  { id: "admin.voice_agent", href: "/admin/voice-agent", label: "Voice Agent", icon: "VA", lucide: Bot, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_manage_global_settings" },
  // Trunks & Routing + Ring Groups & Queues (2026-08-20, Izzy: "add them all
  // to the sidebar with permissions off for everybody but me") — direct doors
  // into the console's routing and teams modules. SUPER_ADMIN only, forced in
  // isNavItemVisibleForUser like admin.pbx_console; deliberately NO grantable
  // key (the ivr_migration pattern): these screens carry every customer's
  // trunks and dial plans, and a permission that could grant them would be one
  // ticked box away from handing a tenant admin the whole platform's routing.
  { id: "admin.pbx_routing", href: "/admin/pbx-console?mod=routing", label: "Trunks & Routing", icon: "TR", lucide: Server, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_manage_global_settings" },
  { id: "admin.pbx_teams", href: "/admin/pbx-console?mod=teams", label: "Ring Groups & Queues", icon: "RQ", lucide: Users, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_manage_global_settings" },
  { id: "admin.pbx_events", href: "/admin/pbx/events", label: "PBX Events", icon: "PE", lucide: Zap, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_pbx_events" },
  { id: "admin.permissions", href: "/admin/permissions", label: "Permissions", icon: "PM", lucide: Lock, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_permissions" },
  { id: "admin.billing", href: "/admin/billing", label: "Admin Billing", icon: "AB", lucide: Wallet, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_billing" },
  { id: "admin.cdr_tenant_map", href: "/admin/cdr-tenant-map", label: "CDR Tenant Map", icon: "CM", lucide: Map, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_cdr_tenant_map" },
  { id: "admin.ops_center", href: "/admin/ops-center", label: "Ops Center", icon: "OC", lucide: LayoutGrid, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_ops_center" },
  { id: "admin.server_health", href: "/admin/server-health", label: "Server Health", icon: "SH", lucide: Server, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_server_health" },
  { id: "admin.storage_health", href: "/admin/storage-health", label: "Storage Health", icon: "ST", lucide: HardDrive, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_storage_health" },
  { id: "admin.incidents", href: "/admin/incidents", label: "Incident Center", icon: "IC", lucide: AlertTriangle, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_incidents" },
  { id: "admin.audio_intelligence", href: "/admin/audio-intelligence", label: "Audio Intelligence", icon: "AI", lucide: Mic2, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_audio_intelligence" },
  { id: "admin.call_timeline", href: "/admin/call-timeline", label: "Call Timeline", icon: "CT", lucide: History, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_call_timeline" },
  { id: "admin.call_flight", href: "/admin/call-flight", label: "Call Flight Recorder", icon: "CF", lucide: Plane, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_call_flight" },
  { id: "admin.deploy_center", href: "/admin/deploy-center", label: "Deploy Center", icon: "DC", lucide: Rocket, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_deploy_center" },
  { id: "admin.roles", href: "/admin/roles", label: "Custom Roles", icon: "RO", lucide: Shield, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_roles" },
  { id: "admin.phone_numbers", href: "/admin/phone-numbers", label: "Phone Numbers", icon: "PN", lucide: Hash, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_phone_numbers" },
  { id: "admin.onboarding", href: "/admin/onboarding", label: "Onboarding", icon: "OB", lucide: ClipboardList, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_onboarding" },
  { id: "admin.assistant", href: "/assistant", label: "AI Assistant", icon: "AS", lucide: Bot, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_assistant" },
  { id: "admin.ai_trainer", href: "/ai-trainer", label: "AI Trainer", icon: "TR", lucide: GraduationCap, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_assistant" },
  { id: "admin.elevenlabs", href: "/elevenlabs", label: "ElevenLabs", icon: "EL", lucide: Mic2, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_assistant" },
  { id: "admin.polly", href: "/polly", label: "Amazon Polly", icon: "PY", lucide: AudioLines, section: "admin", sectionPermission: "can_view_section_admin", permission: "can_view_admin_assistant" },

  { id: "billing.overview", href: "/billing", label: "Billing Overview", icon: "BL", lucide: Receipt, section: "billing", sectionPermission: "can_view_section_billing", permission: "can_view_billing_overview" },

  { id: "apps.home", href: "/apps", label: "Apps", icon: "AP", lucide: Grid3X3, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_home" },
  { id: "apps.sms_campaigns", href: "/apps/sms-campaigns", label: "SMS Campaigns", icon: "SC", lucide: Megaphone, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_sms_campaigns" },
  { id: "apps.whatsapp", href: "/apps/whatsapp", label: "WhatsApp Inbox", icon: "WA", lucide: MessageCircle, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_whatsapp_inbox" },
  { id: "apps.voip_ms", href: "/apps/voip-ms", label: "VoIP.ms", icon: "VP", lucide: PhoneForwarded, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_voip_ms" },
  // SignalWire evaluation console (2026-08-18) — the carrier being tested to
  // replace VoIP.ms. Shares VoIP.ms's view key in the catalog, but is forced
  // SUPER_ADMIN-only in isNavItemVisibleForUser (like pbx.ivr_migration): it
  // spends the platform's own money and there is deliberately no grantable key.
  { id: "apps.signalwire", href: "/apps/signalwire", label: "SignalWire", icon: "SW", lucide: Radio, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_voip_ms" },
  { id: "apps.customers", href: "/apps/customers", label: "Customer Hub", icon: "CU", lucide: UsersRound, section: "apps", sectionPermission: "can_view_section_apps", permission: "can_view_apps_customer_hub" },

  { id: "tracking.dashboard", href: "/tracking/dashboard", label: "Dashboard", icon: "TD", lucide: LayoutDashboard, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_dashboard" },
  { id: "tracking.orders", href: "/tracking/orders", label: "Orders", icon: "TO", lucide: Package, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_orders" },
  { id: "tracking.map", href: "/tracking/map", label: "Live Map", icon: "TM", lucide: Map, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_map" },
  { id: "tracking.runs", href: "/tracking/runs", label: "Runs", icon: "TR", lucide: Route, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_runs" },
  { id: "tracking.drivers", href: "/tracking/drivers", label: "Drivers", icon: "TV", lucide: Truck, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_drivers" },
  { id: "tracking.exceptions", href: "/tracking/exceptions", label: "Exceptions", icon: "TX", lucide: AlertTriangle, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_exceptions" },
  { id: "tracking.reports", href: "/tracking/reports", label: "Reports", icon: "TP", lucide: BarChart3, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_reports" },
  { id: "tracking.audit", href: "/tracking/audit", label: "Audit Log", icon: "TA", lucide: History, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_audit" },
  { id: "tracking.settings", href: "/tracking/settings", label: "Settings", icon: "TS", lucide: Settings2, section: "tracking", sectionPermission: "can_view_section_tracking", permission: "can_view_tracking_settings" }
];

/** Sidebar section order: Workspace → PBX → CRM → Apps → Billing → Admin → Settings */
export const NAV_SECTION_ORDER: NavItem["section"][] = ["workspace", "store", "pbx", "crm", "apps", "billing", "admin", "settings"];

export const navSectionMeta: Record<NavItem["section"], { label: string; railIcon: string }> = {
  workspace: { label: "Workspace", railIcon: "WS" },
  store: { label: "Store", railIcon: "SO" },
  pbx: { label: "PBX", railIcon: "PB" },
  crm: { label: "CRM", railIcon: "CR" },
  settings: { label: "Settings", railIcon: "ST" },
  admin: { label: "Admin", railIcon: "AD" },
  billing: { label: "Billing", railIcon: "BL" },
  apps: { label: "Apps", railIcon: "AP" },
  tracking: { label: "Tracking", railIcon: "TR" }
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
  // Migration copies a customer's live PBX call flow into Connect — a wrong
  // click can overwrite a real business's routing (it happened once, to A plus
  // center). It shares the Studio's view permission in the catalog, so without
  // this line ANY role granted "IVR Studio" also saw Migration. Super admin
  // only, always; there is deliberately no permission that can grant it.
  if (item.id === "pbx.ivr_migration" && backendJwtRole !== "SUPER_ADMIN") return false;
  // The SignalWire test bench spends the platform owner's money; owner only.
  if (item.id === "apps.signalwire" && backendJwtRole !== "SUPER_ADMIN") return false;
  if (item.id === "admin.pbx_console" && backendJwtRole !== "SUPER_ADMIN") return false;
  if (item.id === "admin.integrations" && backendJwtRole !== "SUPER_ADMIN") return false;
  if (item.id === "admin.voice_agent" && backendJwtRole !== "SUPER_ADMIN") return false;
  // Meetings: Izzy only, by his instruction 2026-08-21 ("Permissions off for
  // everybody but me"). Only STARTING a meeting is restricted — anyone with a
  // link still joins, which is the whole point of the feature.
  // ⛔ Hiding the nav item is presentation, NOT access: the /meetings page
  // refuses to render for anyone else, and the create/list routes refuse
  // server-side. All three must agree.
  if (item.id === "workspace.meetings" && backendJwtRole !== "SUPER_ADMIN") return false;
  // Loopcom Direct: SUPER_ADMIN only for now, the same precedent as Meetings —
  // Izzy looks at a new customer-facing feature before it appears in every
  // customer's sidebar. ⛔ This is the ONLY thing standing between the built
  // feature and every user seeing it, so removing this line IS the launch.
  // ⛔ It is presentation only: the API gates on can_view_workspace_chat and the
  // real protection is that nobody has a verified number, so lifting this alone
  // exposes nothing that was not already refused.
  if (item.id === "workspace.direct" && backendJwtRole !== "SUPER_ADMIN") return false;
  // The routing/teams doors show and change every customer's trunks and dial
  // plans — SUPER_ADMIN only, same as the console they open into.
  if (item.id === "admin.pbx_routing" && backendJwtRole !== "SUPER_ADMIN") return false;
  if (item.id === "admin.pbx_teams" && backendJwtRole !== "SUPER_ADMIN") return false;
  // The Support Desk shows every company's escalations and conversations.
  // Izzy, 2026-08-20: "for now do just super admin" — the support-agent role
  // comes later, with per-feature keys that actually gate.
  if (item.id === "admin.support" && backendJwtRole !== "SUPER_ADMIN") return false;
  // The compliance calendar is the platform's own regulatory ledger — owner
  // only, same pattern as the console items above.
  if (item.id === "admin.compliance" && backendJwtRole !== "SUPER_ADMIN") return false;
  return true;
}
