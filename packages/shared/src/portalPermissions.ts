export const PORTAL_ROLE_BUCKETS = ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const;
export type PortalRoleBucket = (typeof PORTAL_ROLE_BUCKETS)[number];

export type PortalSidebarSectionKey =
  | "workspace"
  | "pbx"
  | "crm"
  | "apps"
  | "billing"
  | "admin"
  | "settings";

export const SIDEBAR_SECTIONS = [
  { id: "workspace", label: "Workspace", permission: "can_view_section_workspace" },
  { id: "pbx", label: "PBX", permission: "can_view_section_pbx" },
  { id: "crm", label: "CRM", permission: "can_view_section_crm" },
  { id: "apps", label: "Apps", permission: "can_view_section_apps" },
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
  { id: "pbx.ivr_routing", section: "pbx", label: "IVR Routing", href: "/pbx/ivr-routing", permission: "can_view_pbx_ivr_routing" },
  { id: "pbx.did_routing", section: "pbx", label: "DID Routing", href: "/pbx/did-routing", permission: "can_view_pbx_did_routing" },
  { id: "pbx.moh_scheduling", section: "pbx", label: "MOH Scheduling", href: "/pbx/moh-scheduling", permission: "can_view_pbx_moh_scheduling" },
  { id: "pbx.call_recordings", section: "pbx", label: "Call Recordings", href: "/pbx/call-recordings", permission: "can_view_pbx_call_recordings" },
  { id: "pbx.call_reports", section: "pbx", label: "Call Reports", href: "/pbx/call-reports", permission: "can_view_pbx_call_reports" },

  { id: "crm.dashboard", section: "crm", label: "CRM Dashboard", href: "/crm/dashboard", permission: "can_view_crm_dashboard" },
  { id: "crm.contacts", section: "crm", label: "Contacts", href: "/crm/contacts", permission: "can_view_crm_contacts" },
  { id: "crm.tasks", section: "crm", label: "Tasks", href: "/crm/tasks", permission: "can_view_crm_tasks" },
  { id: "crm.live_call", section: "crm", label: "Live Call Workspace", href: "/crm/live-call", permission: "can_view_crm_live_call" },
  { id: "crm.scripts", section: "crm", label: "Scripts", href: "/crm/scripts", permission: "can_view_crm_scripts" },
  { id: "crm.checklists", section: "crm", label: "Checklists", href: "/crm/checklists", permission: "can_view_crm_checklists" },
  { id: "crm.campaigns", section: "crm", label: "Campaigns", href: "/crm/campaigns", permission: "can_view_crm_campaigns" },
  { id: "crm.queue", section: "crm", label: "My Queue", href: "/crm/queue", permission: "can_view_crm_queue" },
  { id: "crm.reports", section: "crm", label: "Reports", href: "/crm/reports", permission: "can_view_crm_reports" },
  { id: "crm.import", section: "crm", label: "Import Leads", href: "/crm/import", permission: "can_view_crm_import" },
  { id: "crm.settings", section: "crm", label: "CRM Settings", href: "/crm/settings", permission: "can_view_crm_settings" },

  { id: "apps.home", section: "apps", label: "Apps", href: "/apps", permission: "can_view_apps_home" },
  { id: "apps.sms_campaigns", section: "apps", label: "SMS Campaigns", href: "/apps/sms-campaigns", permission: "can_view_apps_sms_campaigns" },
  { id: "apps.whatsapp", section: "apps", label: "WhatsApp Inbox", href: "/apps/whatsapp", permission: "can_view_apps_whatsapp_inbox" },
  { id: "apps.voip_ms", section: "apps", label: "VoIP.ms", href: "/apps/voip-ms", permission: "can_view_apps_voip_ms" },
  { id: "apps.customers", section: "apps", label: "Customer Hub", href: "/apps/customers", permission: "can_view_apps_customer_hub" },

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
  { id: "admin.incidents", section: "admin", label: "Incident Center", href: "/admin/incidents", permission: "can_view_admin_incidents" },
  { id: "admin.audio_intelligence", section: "admin", label: "Audio Intelligence", href: "/admin/audio-intelligence", permission: "can_view_admin_audio_intelligence" },
  { id: "admin.call_timeline", section: "admin", label: "Call Timeline", href: "/admin/call-timeline", permission: "can_view_admin_call_timeline" },
  { id: "admin.call_flight", section: "admin", label: "Call Flight Recorder", href: "/admin/call-flight", permission: "can_view_admin_call_flight" },
  { id: "admin.deploy_center", section: "admin", label: "Deploy Center", href: "/admin/deploy-center", permission: "can_view_admin_deploy_center" },
  { id: "admin.roles", section: "admin", label: "Custom Roles", href: "/admin/roles", permission: "can_view_admin_roles" },

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
  "can_view_moh",
  "can_manage_moh",
  "can_publish_moh",
  "can_override_moh",
  "can_upload_moh",
  "can_view_did_routing",
  "can_manage_did_routing",
  "can_publish_did_routing",
  "can_manage_deploys",
  "can_view_crm",
  "can_manage_crm",
  "can_view_crm_tasks",
  "can_view_crm_import",
  "can_view_crm_live_call",
  "can_view_crm_scripts",
  "can_view_crm_checklists",
  "can_view_crm_reports",
  "can_view_crm_campaigns",
  "can_view_crm_queue",
  // Tenant-wide communications access (custom role grantable)
  "can_view_tenant_call_history",
  "can_view_tenant_voicemails",
  "can_view_tenant_chats",
  "can_view_tenant_call_recordings",
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
  ],
  can_manage_global_settings: [
    ...ADMIN_SECTION,
    "can_view_admin_permissions",
    "can_view_admin_ops_center",
    "can_view_admin_incidents",
    "can_view_admin_audio_intelligence",
    "can_view_admin_call_timeline",
    "can_view_admin_call_flight",
  ],
  can_manage_deploys: [...ADMIN_SECTION, "can_view_admin_deploy_center"],
  // CRM — expanded for role buckets; API /me strips these unless CrmUserAccess.enabled
  can_view_crm: [...CRM_SECTION, "can_view_crm_dashboard", "can_view_crm_contacts", "can_view_crm_tasks", "can_view_crm_live_call", "can_view_crm_scripts", "can_view_crm_checklists", "can_view_crm_campaigns", "can_view_crm_queue", "can_view_crm_reports"],
  can_manage_crm: [...CRM_SECTION, "can_view_crm_dashboard", "can_view_crm_contacts", "can_view_crm_tasks", "can_view_crm_live_call", "can_view_crm_scripts", "can_view_crm_checklists", "can_view_crm_import", "can_view_crm_settings", "can_view_crm_campaigns", "can_view_crm_queue", "can_view_crm_reports"],
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
];

const TENANT_ADMIN_EXTRA_ACTIONS: PortalPermissionKey[] = [
  "can_edit_team",
  "can_delete_voicemail",
  "can_manage_contacts",
  "can_view_reports",
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

/** Legacy + expanded keys for CRM sidebar/pages (role buckets must not grant CRM without CrmUserAccess). */
export const CRM_PORTAL_PERMISSION_KEYS: PortalPermissionKey[] = [
  ...new Set<PortalPermissionKey>([
    "can_view_crm",
    "can_manage_crm",
    ...expandLegacyPortalPermissions(["can_view_crm"]),
    ...expandLegacyPortalPermissions(["can_manage_crm"]),
  ]),
];

export function isCrmPortalPermissionKey(key: string): boolean {
  return (CRM_PORTAL_PERMISSION_KEYS as string[]).includes(key);
}

/** Legacy keys to expand when CrmUserAccess is enabled for the user. */
export function crmLegacyPermissionKeysForAccess(role: string | null | undefined): ("can_view_crm" | "can_manage_crm")[] {
  const normalized = String(role || "").trim().toUpperCase();
  if (normalized === "ADMIN" || normalized === "MANAGER") return ["can_manage_crm"];
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
