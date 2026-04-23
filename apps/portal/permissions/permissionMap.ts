import type { Permission, Role } from "../types/app";

const END_USER_PERMISSIONS: Permission[] = [
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

const TENANT_ADMIN_PERMISSIONS: Permission[] = [
  ...END_USER_PERMISSIONS,
  "can_edit_team",
  "can_delete_voicemail",
  "can_manage_contacts",
  "can_view_reports",
  "can_view_admin",
  "can_manage_integrations",
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
];

const SUPER_ADMIN_PERMISSIONS: Permission[] = [
  ...TENANT_ADMIN_PERMISSIONS,
  "can_switch_tenants",
  "can_manage_global_settings"
];

export const ROLE_PERMISSION_MAP: Record<Role, Permission[]> = {
  END_USER: END_USER_PERMISSIONS,
  TENANT_ADMIN: TENANT_ADMIN_PERMISSIONS,
  SUPER_ADMIN: SUPER_ADMIN_PERMISSIONS
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSION_MAP[role].includes(permission);
}
