export const PORTAL_ROLE_BUCKETS = ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const;
export type PortalRoleBucket = (typeof PORTAL_ROLE_BUCKETS)[number];

export type PortalSidebarSectionKey =
  | "workspace"
  | "pbx"
  | "crm"
  | "apps"
  | "tracking"
  | "billing"
  | "admin"
  | "settings";

export const SIDEBAR_SECTIONS = [
  { id: "workspace", label: "Workspace", permission: "can_view_section_workspace" },
  { id: "pbx", label: "PBX", permission: "can_view_section_pbx" },
  { id: "crm", label: "CRM", permission: "can_view_section_crm" },
  { id: "apps", label: "Apps", permission: "can_view_section_apps" },
  { id: "tracking", label: "Tracking", permission: "can_view_section_tracking" },
  { id: "billing", label: "Billing", permission: "can_view_section_billing" },
  { id: "admin", label: "Admin", permission: "can_view_section_admin" },
  { id: "settings", label: "Settings", permission: "can_view_section_settings" },
] as const;

export const SIDEBAR_ITEMS = [
  { id: "workspace.overview", section: "workspace", label: "Overview", href: "/dashboard", permission: "can_view_workspace_overview" },
  { id: "workspace.team", section: "workspace", label: "Team Directory", href: "/team", permission: "can_view_workspace_team_directory" },
  { id: "workspace.calls", section: "workspace", label: "Call History", href: "/calls", permission: "can_view_workspace_call_history" },
  { id: "workspace.voicemail", section: "workspace", label: "Voicemail", href: "/voicemail", permission: "can_view_workspace_voicemail" },
  { id: "workspace.chat", section: "workspace", label: "Chat", href: "/chat", permission: "can_view_workspace_chat" },
  { id: "workspace.contacts", section: "workspace", label: "Contacts", href: "/contacts", permission: "can_view_workspace_contacts" },

  { id: "pbx.extensions", section: "pbx", label: "Extensions", href: "/pbx/extensions", permission: "can_view_pbx_extensions" },
  { id: "pbx.time_conditions", section: "pbx", label: "Time Conditions", href: "/pbx/time-conditions", permission: "can_view_pbx_time_conditions" },
  { id: "pbx.softphone", section: "pbx", label: "WebRTC Softphone", href: "/pbx/softphone", permission: "can_view_pbx_softphone" },
  { id: "pbx.sbc_connectivity", section: "pbx", label: "SBC Connectivity", href: "/pbx/sbc-connectivity", permission: "can_view_pbx_sbc_connectivity" },
  // Label and href follow the page: the Studio replaced the old IVR Routing
  // screen (whose /pbx/ivr-routing route no longer exists). The permission KEY
  // deliberately keeps its old name — renaming it would silently strip the
  // page from every custom role that already grants it.
  { id: "pbx.ivr_routing", section: "pbx", label: "IVR Studio", href: "/pbx/ivr-studio", permission: "can_view_pbx_ivr_routing" },
  { id: "pbx.did_routing", section: "pbx", label: "DID Routing", href: "/pbx/did-routing", permission: "can_view_pbx_did_routing" },
  { id: "pbx.moh_scheduling", section: "pbx", label: "MOH Scheduling", href: "/pbx/moh-scheduling", permission: "can_view_pbx_moh_scheduling" },
  { id: "pbx.call_recordings", section: "pbx", label: "Call Recordings", href: "/pbx/call-recordings", permission: "can_view_pbx_call_recordings" },
  { id: "pbx.call_reports", section: "pbx", label: "Call Reports", href: "/pbx/call-reports", permission: "can_view_pbx_call_reports" },
  // Queue status, the live wallboard and queue reporting. One nav entry for
  // all three because they are one feature seen at three distances; the wall
  // display is reached from the page rather than the sidebar, since it is
  // meant for a TV and not for the person browsing the app.
  { id: "pbx.queues", section: "pbx", label: "Queues", href: "/queues", permission: "can_view_pbx_queues" },

  { id: "crm.dashboard", section: "crm", label: "CRM Dashboard", href: "/crm/dashboard", permission: "can_view_crm_dashboard" },
  { id: "crm.contacts", section: "crm", label: "Contacts", href: "/crm/contacts", permission: "can_view_crm_contacts" },
  { id: "crm.forms", section: "crm", label: "Forms", href: "/crm/forms", permission: "can_view_crm_forms" },
  { id: "crm.tasks", section: "crm", label: "Tasks", href: "/crm/tasks", permission: "can_view_crm_tasks" },
  { id: "crm.live_call", section: "crm", label: "Live Call Workspace", href: "/crm/live-call", permission: "can_view_crm_live_call" },
  { id: "crm.scripts", section: "crm", label: "Scripts", href: "/crm/scripts", permission: "can_view_crm_scripts" },
  { id: "crm.voicemail_drops", section: "crm", label: "Voicemail Drops", href: "/crm/voicemail-drops", permission: "can_view_crm_voicemail_drops" },
  { id: "crm.checklists", section: "crm", label: "Checklists", href: "/crm/checklists", permission: "can_view_crm_checklists" },
  { id: "crm.campaigns", section: "crm", label: "Campaigns", href: "/crm/campaigns", permission: "can_view_crm_campaigns" },
  { id: "crm.queue", section: "crm", label: "My Queue", href: "/crm/queue", permission: "can_view_crm_queue" },
  { id: "crm.reports", section: "crm", label: "Reports", href: "/crm/reports", permission: "can_view_crm_reports" },
  { id: "crm.import", section: "crm", label: "Import Leads", href: "/crm/import", permission: "can_view_crm_import" },
  { id: "crm.funders", section: "crm", label: "Funders", href: "/crm/funders", permission: "can_view_crm_funders" },
  { id: "crm.wallboard", section: "crm", label: "Live Wallboard", href: "/crm/wallboard", permission: "can_view_crm_wallboard" },
  { id: "crm.settings", section: "crm", label: "CRM Settings", href: "/crm/settings", permission: "can_view_crm_settings" },

  { id: "apps.home", section: "apps", label: "Apps", href: "/apps", permission: "can_view_apps_home" },
  { id: "apps.sms_campaigns", section: "apps", label: "SMS Campaigns", href: "/apps/sms-campaigns", permission: "can_view_apps_sms_campaigns" },
  { id: "apps.whatsapp", section: "apps", label: "WhatsApp Inbox", href: "/apps/whatsapp", permission: "can_view_apps_whatsapp_inbox" },
  { id: "apps.voip_ms", section: "apps", label: "VoIP.ms", href: "/apps/voip-ms", permission: "can_view_apps_voip_ms" },
  { id: "apps.customers", section: "apps", label: "Customer Hub", href: "/apps/customers", permission: "can_view_apps_customer_hub" },

  { id: "tracking.dashboard", section: "tracking", label: "Dashboard", href: "/tracking/dashboard", permission: "can_view_tracking_dashboard" },
  { id: "tracking.orders", section: "tracking", label: "Orders", href: "/tracking/orders", permission: "can_view_tracking_orders" },
  { id: "tracking.map", section: "tracking", label: "Live Map", href: "/tracking/map", permission: "can_view_tracking_map" },
  { id: "tracking.runs", section: "tracking", label: "Runs", href: "/tracking/runs", permission: "can_view_tracking_runs" },
  { id: "tracking.drivers", section: "tracking", label: "Drivers", href: "/tracking/drivers", permission: "can_view_tracking_drivers" },
  { id: "tracking.exceptions", section: "tracking", label: "Exceptions", href: "/tracking/exceptions", permission: "can_view_tracking_exceptions" },
  { id: "tracking.reports", section: "tracking", label: "Reports", href: "/tracking/reports", permission: "can_view_tracking_reports" },
  { id: "tracking.notifications", section: "tracking", label: "Notifications", href: "/tracking/notifications", permission: "can_view_tracking_audit" },
  { id: "tracking.audit", section: "tracking", label: "Audit Log", href: "/tracking/audit", permission: "can_view_tracking_audit" },
  { id: "tracking.integrations", section: "tracking", label: "Integrations", href: "/tracking/integrations", permission: "can_view_tracking_settings" },
  { id: "tracking.health", section: "tracking", label: "System Health", href: "/tracking/health", permission: "can_view_tracking_settings" },
  { id: "tracking.settings", section: "tracking", label: "Settings", href: "/tracking/settings", permission: "can_view_tracking_settings" },

  { id: "billing.overview", section: "billing", label: "Billing Overview", href: "/billing", permission: "can_view_billing_overview" },
  { id: "billing.invoices", section: "billing", label: "Invoices", href: "/billing/invoices", permission: "can_view_billing_invoices" },
  { id: "billing.payments", section: "billing", label: "Payments", href: "/billing/payments", permission: "can_view_billing_payments" },
  { id: "billing.receipts", section: "billing", label: "Receipts", href: "/billing/receipts", permission: "can_view_billing_receipts" },

  { id: "admin.console", section: "admin", label: "Admin Console", href: "/admin", permission: "can_view_admin_console" },
  { id: "admin.users", section: "admin", label: "Users", href: "/admin/users", permission: "can_view_admin_users" },
  { id: "admin.tenants", section: "admin", label: "Tenants", href: "/admin/tenants", permission: "can_view_admin_tenants" },
  { id: "admin.pbx_instances", section: "admin", label: "PBX Instances", href: "/admin/pbx", permission: "can_view_admin_pbx_instances" },
  { id: "admin.pbx_events", section: "admin", label: "PBX Events", href: "/admin/pbx/events", permission: "can_view_admin_pbx_events" },
  { id: "admin.permissions", section: "admin", label: "Permissions", href: "/admin/permissions", permission: "can_view_admin_permissions" },
  { id: "admin.billing", section: "admin", label: "Admin Billing", href: "/admin/billing", permission: "can_view_admin_billing" },
  { id: "admin.cdr_tenant_map", section: "admin", label: "CDR Tenant Map", href: "/admin/cdr-tenant-map", permission: "can_view_admin_cdr_tenant_map" },
  { id: "admin.ops_center", section: "admin", label: "Ops Center", href: "/admin/ops-center", permission: "can_view_admin_ops_center" },
  { id: "admin.server_health", section: "admin", label: "Server Health", href: "/admin/server-health", permission: "can_view_admin_server_health" },
  { id: "admin.storage_health", section: "admin", label: "Storage Health", href: "/admin/storage-health", permission: "can_view_admin_storage_health" },
  { id: "admin.incidents", section: "admin", label: "Incident Center", href: "/admin/incidents", permission: "can_view_admin_incidents" },
  { id: "admin.audio_intelligence", section: "admin", label: "Audio Intelligence", href: "/admin/audio-intelligence", permission: "can_view_admin_audio_intelligence" },
  { id: "admin.call_timeline", section: "admin", label: "Call Timeline", href: "/admin/call-timeline", permission: "can_view_admin_call_timeline" },
  { id: "admin.call_flight", section: "admin", label: "Call Flight Recorder", href: "/admin/call-flight", permission: "can_view_admin_call_flight" },
  { id: "admin.deploy_center", section: "admin", label: "Deploy Center", href: "/admin/deploy-center", permission: "can_view_admin_deploy_center" },
  { id: "admin.roles", section: "admin", label: "Custom Roles", href: "/admin/roles", permission: "can_view_admin_roles" },
  { id: "admin.phone_numbers", section: "admin", label: "Phone Numbers", href: "/admin/phone-numbers", permission: "can_view_admin_phone_numbers" },
  { id: "admin.onboarding", section: "admin", label: "Onboarding", href: "/admin/onboarding", permission: "can_view_admin_onboarding" },
  { id: "admin.assistant", section: "admin", label: "AI Assistant", href: "/assistant", permission: "can_view_admin_assistant" },

  { id: "settings.tenant", section: "settings", label: "Tenant Settings", href: "/settings", permission: "can_view_settings_tenant" },
  { id: "settings.email", section: "settings", label: "Email Settings", href: "/settings/email", permission: "can_view_settings_email" },
  { id: "settings.system_health", section: "settings", label: "System Health", href: "/calls/health", permission: "can_view_settings_system_health" },
  { id: "settings.billing", section: "settings", label: "Billing Settings", href: "/settings/billing", permission: "can_view_settings_billing" },
  { id: "settings.messaging", section: "settings", label: "Messaging Settings", href: "/settings/messaging", permission: "can_view_settings_messaging" },
] as const;

export const ACTION_PERMISSION_KEYS = [
  "can_view_dashboard",
  "can_view_team",
  "can_edit_team",
  "can_view_chat",
  "can_view_sms",
  "can_send_sms",
  "can_view_calls",
  "can_view_live_calls",
  "can_view_voicemail",
  "can_delete_voicemail",
  "can_view_contacts",
  "can_manage_contacts",
  "can_view_recordings",
  "can_download_recordings",
  "can_view_reports",
  "can_view_settings",
  "can_manage_call_forwarding",
  "can_manage_blfs",
  "can_view_admin",
  "can_manage_integrations",
  "can_manage_voip_ms",
  "can_assign_sms_numbers",
  "can_sync_voip_ms_numbers",
  "can_switch_tenants",
  "can_manage_tenant_settings",
  "can_manage_global_settings",
  "can_view_apps",
  "can_download_apk",
  "can_view_ivr_routing",
  "can_manage_ivr_routing",
  "can_publish_ivr_routing",
  "can_override_ivr_routing",
  "can_manage_ivr_prompts",
  // Amazon Polly as a second voice source for IVR recordings. Deliberately
  // absent from BOTH default buckets below — including TENANT_ADMIN. Polly is
  // billed per character against Connect's own AWS account, so it is opened to
  // specific people through a custom role rather than handed to everyone who
  // can manage prompts. Someone without it sees the ElevenLabs flow exactly as
  // before; the Polly option simply isn't offered.
  "can_use_amazon_polly",
  // ── Queues ────────────────────────────────────────────────────────────────
  // Three keys rather than one, because these are genuinely different jobs and
  // an owner may well want a supervisor on the live board but nowhere near the
  // per-agent history:
  //   can_view_queues          — the live status page: who is waiting, who is
  //                              free, and how each queue is coping right now.
  //   can_view_queue_wallboard — TV mode, the full-screen wall display.
  //   can_view_queue_reports   — the historical reports, which include a
  //                              per-agent league table. That is performance
  //                              data about named people, so it is separable
  //                              from watching the queue and is deliberately
  //                              NOT granted to an ordinary user by default.
  //   can_create_queues        — make a NEW queue. This is a PBX write, so it
  //                              is separate from merely watching one: plenty
  //                              of supervisors should see the board and never
  //                              create anything. ⛔ The /voice/teams route
  //                              accepts this key OR the IVR-management key,
  //                              so the button and the endpoint always agree.
  "can_view_queues",
  "can_view_queue_wallboard",
  "can_view_queue_reports",
  "can_create_queues",
  // Lets a person switch the customer-facing screens into Yiddish. Separate
  // from the tenant-level switch: the tenant chooses at sign-up whether
  // Yiddish is offered at all, this decides who inside it may use it.
  "can_use_yiddish",
  "can_view_moh",
  "can_manage_moh",
  "can_publish_moh",
  "can_override_moh",
  "can_upload_moh",
  "can_view_did_routing",
  "can_manage_did_routing",
  "can_publish_did_routing",
  "can_manage_deploys",
  "can_view_admin_storage_health",
  "can_approve_storage_cleanup",
  "can_view_crm",
  "can_manage_crm",
  "can_manage_crm_admin",
  "can_view_crm_forms",
  "can_view_crm_tasks",
  "can_view_crm_import",
  "can_view_crm_live_call",
  "can_view_crm_scripts",
  "can_view_crm_voicemail_drops",
  "can_view_crm_checklists",
  "can_view_crm_reports",
  "can_view_crm_campaigns",
  "can_view_crm_queue",
  "can_view_crm_email",
  // Tenant-wide communications access (custom role grantable)
  "can_view_tenant_call_history",
  "can_view_tenant_voicemails",
  "can_view_tenant_chats",
  "can_view_tenant_call_recordings",
  // ── Remote support ────────────────────────────────────────────────────────
  // Watching a customer's screen and driving their mouse are the two most
  // invasive things this platform can do, so they are deliberately absent from
  // BOTH default buckets below — including TENANT_ADMIN — exactly like
  // can_use_amazon_polly. They are opened to named people through a custom
  // role. SUPER_ADMIN still receives them automatically via the force-add
  // bucket, so no snapshot migration is needed.
  //
  // ⛔ Two keys, not one, and the split is load-bearing: watching is how you
  // diagnose, controlling is how you change someone's machine. Plenty of staff
  // should be able to look at a screen and never touch it, and revoking
  // control must leave viewing intact. The API enforces this per session —
  // a session opened without can_control_remote_support can never be upgraded
  // to control without a fresh consent from the customer.
  "can_remote_support",
  "can_control_remote_support",
  // The desk-phone inventory the Windows app discovers on a customer's own
  // network (MAC, IP, model). Separate from remote support because reading an
  // inventory is not the same as watching somebody work, and the people who
  // provision phones are not necessarily the people who do support calls.
  "can_view_lan_phones",
  // Delivery/order tracking (supermarket delivery feature)
  "can_view_tracking",
  "can_manage_tracking",
  "can_dispatch_tracking",
  "can_manage_tracking_drivers",
  "can_access_tracking_proof",
  "can_manage_tracking_settings",
] as const;

export type SidebarSectionPermissionKey = (typeof SIDEBAR_SECTIONS)[number]["permission"];
export type SidebarItemPermissionKey = (typeof SIDEBAR_ITEMS)[number]["permission"];
export type ActionPermissionKey = (typeof ACTION_PERMISSION_KEYS)[number];
export type PortalPermissionKey = SidebarSectionPermissionKey | SidebarItemPermissionKey | ActionPermissionKey;

export type PortalSidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type PortalSidebarItem = (typeof SIDEBAR_ITEMS)[number];

export const PORTAL_PERMISSION_KEYS = [
  ...SIDEBAR_SECTIONS.map((section) => section.permission),
  ...SIDEBAR_ITEMS.map((item) => item.permission),
  ...ACTION_PERMISSION_KEYS,
] as PortalPermissionKey[];

const WORKSPACE_SECTION = ["can_view_section_workspace"] as PortalPermissionKey[];
const PBX_SECTION = ["can_view_section_pbx"] as PortalPermissionKey[];
const CRM_SECTION = ["can_view_section_crm"] as PortalPermissionKey[];
const APPS_SECTION = ["can_view_section_apps"] as PortalPermissionKey[];
const TRACKING_SECTION = ["can_view_section_tracking"] as PortalPermissionKey[];
const BILLING_SECTION = ["can_view_section_billing"] as PortalPermissionKey[];
const ADMIN_SECTION = ["can_view_section_admin"] as PortalPermissionKey[];
const SETTINGS_SECTION = ["can_view_section_settings"] as PortalPermissionKey[];

export const LEGACY_PERMISSION_EXPANSIONS: Record<string, PortalPermissionKey[]> = {
  can_view_dashboard: [...WORKSPACE_SECTION, "can_view_workspace_overview"],
  can_view_team: [...WORKSPACE_SECTION, ...PBX_SECTION, "can_view_workspace_team_directory", "can_view_pbx_extensions"],
  can_view_calls: [
    ...WORKSPACE_SECTION,
    ...PBX_SECTION,
    ...SETTINGS_SECTION,
    "can_view_workspace_call_history",
    "can_view_pbx_time_conditions",
    "can_view_pbx_softphone",
    "can_view_pbx_sbc_connectivity",
    "can_view_settings_system_health",
  ],
  can_view_voicemail: [...WORKSPACE_SECTION, "can_view_workspace_voicemail"],
  can_view_chat: [...WORKSPACE_SECTION, "can_view_workspace_chat"],
  can_view_contacts: [...WORKSPACE_SECTION, ...APPS_SECTION, "can_view_workspace_contacts", "can_view_apps_customer_hub"],
  can_view_recordings: [...PBX_SECTION, "can_view_pbx_call_recordings"],
  can_view_reports: [
    ...PBX_SECTION,
    ...BILLING_SECTION,
    "can_view_pbx_call_reports",
    // The Queues nav item hangs off "can view reports", NOT "can view calls".
    // ⛔ It was on can_view_calls first, and that was wrong: END_USER holds
    // can_view_calls, so every ordinary user would have seen a Queues menu
    // item that then denied them at the page — the worst of both, a visible
    // door that doesn't open. can_view_reports is a TENANT_ADMIN key, so nav
    // visibility and the action keys below now switch on together.
    "can_view_pbx_queues",
    "can_view_billing_overview",
    "can_view_billing_invoices",
    "can_view_billing_payments",
    "can_view_billing_receipts",
  ],
  can_view_settings: [
    ...SETTINGS_SECTION,
    "can_view_settings_tenant",
    "can_view_settings_email",
    "can_view_settings_billing",
    "can_view_settings_messaging",
  ],
  can_view_apps: [...APPS_SECTION, "can_view_apps_home"],
  can_view_sms: [...APPS_SECTION, "can_view_apps_sms_campaigns", "can_view_apps_whatsapp_inbox"],
  can_manage_voip_ms: [...APPS_SECTION, "can_view_apps_voip_ms"],
  can_view_ivr_routing: [...PBX_SECTION, "can_view_pbx_ivr_routing"],
  can_view_moh: [...PBX_SECTION, "can_view_pbx_moh_scheduling"],
  can_view_did_routing: [...PBX_SECTION, "can_view_pbx_did_routing"],
  // Delivery/order tracking — expands the umbrella capability to the section + all pages.
  can_view_tracking: [
    ...TRACKING_SECTION,
    "can_view_tracking_dashboard",
    "can_view_tracking_orders",
    "can_view_tracking_map",
    "can_view_tracking_runs",
    "can_view_tracking_drivers",
    "can_view_tracking_exceptions",
    "can_view_tracking_reports",
    "can_view_tracking_audit",
    "can_view_tracking_settings",
  ],
  can_manage_tracking: [
    ...TRACKING_SECTION,
    "can_view_tracking_dashboard",
    "can_view_tracking_orders",
    "can_view_tracking_map",
    "can_view_tracking_runs",
    "can_view_tracking_drivers",
    "can_view_tracking_exceptions",
    "can_view_tracking_reports",
    "can_view_tracking_audit",
    "can_view_tracking_settings",
    "can_view_tracking",
    "can_dispatch_tracking",
    "can_manage_tracking_drivers",
    "can_access_tracking_proof",
    "can_manage_tracking_settings",
  ],
  can_view_admin: [
    ...ADMIN_SECTION,
    "can_view_admin_console",
    "can_view_admin_users",
    "can_view_admin_tenants",
    "can_view_admin_pbx_instances",
    "can_view_admin_pbx_events",
    "can_view_admin_billing",
    "can_view_admin_cdr_tenant_map",
    "can_view_admin_roles",
    "can_view_admin_phone_numbers",
    "can_view_admin_onboarding",
  ],
  can_manage_global_settings: [
    ...ADMIN_SECTION,
    "can_view_admin_permissions",
    "can_view_admin_ops_center",
    "can_view_admin_incidents",
    "can_view_admin_audio_intelligence",
    "can_view_admin_call_timeline",
    "can_view_admin_call_flight",
    "can_view_admin_server_health",
    "can_view_admin_storage_health",
  ],
  can_manage_deploys: [...ADMIN_SECTION, "can_view_admin_deploy_center"],
  // CRM — expanded for role buckets; API /me strips these unless CrmUserAccess.enabled
  // AGENT  → can_view_crm  (read-only CRM access, no settings/wallboard)
  // MANAGER → can_manage_crm (manage campaigns/import, still no settings/wallboard)
  // ADMIN  → can_manage_crm + can_manage_crm_admin (full CRM access incl. settings + wallboard)
  can_view_crm: [...CRM_SECTION, "can_view_crm_dashboard", "can_view_crm_contacts", "can_view_crm_forms", "can_view_crm_tasks", "can_view_crm_live_call", "can_view_crm_scripts", "can_view_crm_voicemail_drops", "can_view_crm_checklists", "can_view_crm_import", "can_view_crm_campaigns", "can_view_crm_queue", "can_view_crm_reports", "can_view_crm_funders", "can_view_crm_email"],
  can_manage_crm: [...CRM_SECTION, "can_view_crm_dashboard", "can_view_crm_contacts", "can_view_crm_forms", "can_view_crm_tasks", "can_view_crm_live_call", "can_view_crm_scripts", "can_view_crm_voicemail_drops", "can_view_crm_checklists", "can_view_crm_import", "can_view_crm_campaigns", "can_view_crm_queue", "can_view_crm_reports", "can_view_crm_funders", "can_view_crm_email"],
  can_manage_crm_admin: [...CRM_SECTION, "can_view_crm_dashboard", "can_view_crm_contacts", "can_view_crm_forms", "can_view_crm_tasks", "can_view_crm_live_call", "can_view_crm_scripts", "can_view_crm_voicemail_drops", "can_view_crm_checklists", "can_view_crm_import", "can_view_crm_settings", "can_view_crm_wallboard", "can_view_crm_campaigns", "can_view_crm_queue", "can_view_crm_reports", "can_view_crm_funders", "can_view_crm_email"],
};

const END_USER_ACTIONS: PortalPermissionKey[] = [
  "can_view_dashboard",
  "can_view_team",
  "can_view_chat",
  "can_view_sms",
  "can_send_sms",
  "can_view_calls",
  "can_view_live_calls",
  "can_view_voicemail",
  "can_view_contacts",
  "can_view_recordings",
  "can_download_recordings",
  "can_view_settings",
  "can_manage_call_forwarding",
  "can_manage_blfs",
  "can_view_apps",
  "can_download_apk",
  "can_view_ivr_routing",
  "can_view_moh",
  "can_view_did_routing",
  // Granted to everyone by default: reading your own phone system in your own
  // language is not a privilege to be rationed. The tenant-level switch, set
  // at sign-up, still decides whether Yiddish is offered at all — this only
  // says that if it IS offered, an ordinary user may use it. Revoke per-user
  // or per-role like any other permission.
  "can_use_yiddish",
];

const TENANT_ADMIN_EXTRA_ACTIONS: PortalPermissionKey[] = [
  "can_edit_team",
  "can_delete_voicemail",
  "can_manage_contacts",
  "can_view_reports",
  // Queues: on for a tenant admin, off for an ordinary user, and every one of
  // the four individually revocable from a custom role.
  "can_view_queues",
  "can_view_queue_wallboard",
  "can_view_queue_reports",
  "can_create_queues",
  "can_view_admin",
  "can_manage_integrations",
  "can_manage_voip_ms",
  "can_assign_sms_numbers",
  "can_manage_tenant_settings",
  "can_manage_ivr_routing",
  "can_publish_ivr_routing",
  "can_override_ivr_routing",
  "can_manage_ivr_prompts",
  "can_manage_moh",
  "can_publish_moh",
  "can_override_moh",
  "can_upload_moh",
  "can_manage_did_routing",
  "can_publish_did_routing",
  "can_manage_crm",
  "can_manage_tracking",
];

const SUPER_ADMIN_EXTRA_ACTIONS: PortalPermissionKey[] = [
  "can_switch_tenants",
  "can_manage_global_settings",
  "can_sync_voip_ms_numbers",
  "can_manage_deploys",
];

export function expandLegacyPortalPermissions(input: readonly string[]): PortalPermissionKey[] {
  const out = new Set<PortalPermissionKey>();
  const allowed = new Set<string>(PORTAL_PERMISSION_KEYS);
  for (const raw of input) {
    const key = String(raw || "").trim();
    if (!key) continue;
    if (allowed.has(key)) out.add(key as PortalPermissionKey);
    for (const expanded of LEGACY_PERMISSION_EXPANSIONS[key] || []) out.add(expanded);
  }
  return [...out];
}

/**
 * Hidden legacy "page-visibility" keys.
 *
 * These keys are NOT shown in the custom-role editor's Action Permissions panel
 * (they live in HIDDEN_ACTION_KEYS there) because they are pure page-shell
 * visibility flags, not capabilities. For built-in role buckets they are kept in
 * sync with the granular sidebar section/item keys via expandLegacyPortalPermissions.
 *
 * Custom roles, however, are resolved LITERALLY (no expansion), so a role built by
 * toggling only the granular nav items would have e.g. can_view_workspace_call_history
 * but NOT can_view_calls — and every page still gated on the legacy can_view_calls
 * would 403 even though the sidebar link shows. backfillLegacyPageVisibility re-derives
 * ONLY these page-visibility keys from the granular nav items the admin actually
 * granted. It deliberately excludes privileged action keys (can_manage_*,
 * can_view_reports, etc.), and actual data access remains independently enforced by
 * the granular PORTAL_API_PERMISSION_RULES server-side — so this can never widen
 * capability or data access, only whether the page chrome renders.
 */
export const PAGE_VISIBILITY_LEGACY_KEYS = [
  "can_view_dashboard",
  "can_view_team",
  "can_view_calls",
  "can_view_voicemail",
  "can_view_chat",
  "can_view_contacts",
  "can_view_settings",
  "can_view_apps",
  "can_view_admin",
  "can_view_ivr_routing",
  "can_view_moh",
  "can_view_did_routing",
] as const;

/**
 * Re-derive hidden page-visibility legacy keys from the granular nav keys present
 * in an (already literal) custom-role permission set. Adds a legacy page key only
 * when the set contains one of that page's NON-section expansion targets (its own
 * nav item/companion). Section keys are never used as triggers (too broad), and
 * only the curated PAGE_VISIBILITY_LEGACY_KEYS are ever added.
 */
export function backfillLegacyPageVisibility(input: readonly string[]): PortalPermissionKey[] {
  const set = new Set<string>(input.map((k) => String(k || "").trim()).filter(Boolean));
  for (const legacy of PAGE_VISIBILITY_LEGACY_KEYS) {
    if (set.has(legacy)) continue;
    const targets = LEGACY_PERMISSION_EXPANSIONS[legacy] || [];
    for (const t of targets) {
      if (String(t).startsWith("can_view_section_")) continue;
      if (set.has(t)) {
        set.add(legacy);
        break;
      }
    }
  }
  return [...set] as PortalPermissionKey[];
}

/** Legacy + expanded keys for CRM sidebar/pages (role buckets must not grant CRM without CrmUserAccess). */
export const CRM_PORTAL_PERMISSION_KEYS: PortalPermissionKey[] = [
  ...new Set<PortalPermissionKey>([
    "can_view_crm",
    "can_manage_crm",
    "can_manage_crm_admin",
    ...expandLegacyPortalPermissions(["can_view_crm"]),
    ...expandLegacyPortalPermissions(["can_manage_crm"]),
    ...expandLegacyPortalPermissions(["can_manage_crm_admin"]),
  ]),
];

export function isCrmPortalPermissionKey(key: string): boolean {
  return (CRM_PORTAL_PERMISSION_KEYS as string[]).includes(key);
}

/** Legacy keys to expand when CrmUserAccess is enabled for the user. */
export function crmLegacyPermissionKeysForAccess(role: string | null | undefined): ("can_view_crm" | "can_manage_crm" | "can_manage_crm_admin")[] {
  const normalized = String(role || "").trim().toUpperCase();
  if (normalized === "ADMIN") return ["can_manage_crm", "can_manage_crm_admin"];
  if (normalized === "MANAGER") return ["can_manage_crm"];
  return ["can_view_crm"];
}

export const DEFAULT_ROLE_PERMISSIONS: Record<PortalRoleBucket, PortalPermissionKey[]> = {
  END_USER: expandLegacyPortalPermissions(END_USER_ACTIONS),
  TENANT_ADMIN: expandLegacyPortalPermissions([...END_USER_ACTIONS, ...TENANT_ADMIN_EXTRA_ACTIONS]),
  SUPER_ADMIN: [...PORTAL_PERMISSION_KEYS],
};

export const PROTECTED_PLATFORM_ADMIN_PERMISSIONS: PortalPermissionKey[] = [
  "can_view_section_admin",
  "can_view_admin_permissions",
  "can_view_admin_roles",
  "can_manage_global_settings",
];

export function isPortalPermissionKey(value: string): value is PortalPermissionKey {
  return (PORTAL_PERMISSION_KEYS as string[]).includes(value);
}
