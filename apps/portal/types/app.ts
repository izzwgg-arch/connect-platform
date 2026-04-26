export type Role = "END_USER" | "TENANT_ADMIN" | "SUPER_ADMIN";
export type AdminScope = "TENANT" | "GLOBAL";

export type Permission =
  | "can_view_dashboard"
  | "can_view_team"
  | "can_edit_team"
  | "can_view_chat"
  | "can_view_sms"
  | "can_send_sms"
  | "can_view_calls"
  | "can_view_live_calls"
  | "can_view_voicemail"
  | "can_delete_voicemail"
  | "can_view_contacts"
  | "can_manage_contacts"
  | "can_view_recordings"
  | "can_download_recordings"
  | "can_view_reports"
  | "can_view_settings"
  | "can_manage_call_forwarding"
  | "can_manage_blfs"
  | "can_view_admin"
  | "can_manage_integrations"
  | "can_manage_voip_ms"
  | "can_assign_sms_numbers"
  | "can_sync_voip_ms_numbers"
  | "can_switch_tenants"
  | "can_manage_tenant_settings"
  | "can_manage_global_settings"
  | "can_view_apps"
  | "can_download_apk"
  | "can_view_ivr_routing"
  | "can_manage_ivr_routing"
  | "can_publish_ivr_routing"
  | "can_override_ivr_routing"
  | "can_manage_ivr_prompts"
  | "can_view_moh"
  | "can_manage_moh"
  | "can_publish_moh"
  | "can_override_moh"
  | "can_upload_moh"
  | "can_view_did_routing"
  | "can_manage_did_routing"
  | "can_publish_did_routing";

export type Presence = "AVAILABLE" | "ON_CALL" | "AWAY" | "DND" | "OFFLINE";

export type Tenant = {
  id: string;
  name: string;
  plan: "Starter" | "Business" | "Enterprise";
  status: "ACTIVE" | "SUSPENDED";
};

export type User = {
  id: string;
  name: string;
  email: string;
  extension: string;
  role: Role;
  tenantId: string;
  presence: Presence;
};
