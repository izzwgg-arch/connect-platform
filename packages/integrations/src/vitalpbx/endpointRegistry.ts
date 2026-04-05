import type { VitalPbxEndpointDefinition } from "./types";

// Source: VitalPBX 4 public Postman collection (publishedId 2s935hQmgP).
// Keep this registry documentation-driven: only documented routes are listed.
export const VITALPBX_ENDPOINTS: VitalPbxEndpointDefinition[] = [
  { key: "accountCodes.list", folder: "Account Codes", method: "GET", path: "/api/v2/account_codes", tenantAware: true, capability: "accountCodes.read" },

  { key: "authorizationCodes.list", folder: "Authorization Codes", method: "GET", path: "/api/v2/auth_codes", tenantAware: true, capability: "authorizationCodes.crud" },
  { key: "authorizationCodes.get", folder: "Authorization Codes", method: "GET", path: "/api/v2/auth_codes/:id", tenantAware: true, capability: "authorizationCodes.crud" },
  { key: "authorizationCodes.create", folder: "Authorization Codes", method: "POST", path: "/api/v2/auth_codes", tenantAware: true, capability: "authorizationCodes.crud" },
  { key: "authorizationCodes.updatePut", folder: "Authorization Codes", method: "PUT", path: "/api/v2/auth_codes/:id", tenantAware: true, capability: "authorizationCodes.crud" },
  { key: "authorizationCodes.updatePatch", folder: "Authorization Codes", method: "PATCH", path: "/api/v2/auth_codes/:id", tenantAware: true, capability: "authorizationCodes.crud" },
  { key: "authorizationCodes.delete", folder: "Authorization Codes", method: "DELETE", path: "/api/v2/auth_codes/:id", tenantAware: true, capability: "authorizationCodes.crud" },

  { key: "aiApiKeys.list", folder: "AI API Keys", method: "GET", path: "/api/v2/ai_api_keys", tenantAware: true, capability: "aiApiKeys.crud" },
  { key: "aiApiKeys.get", folder: "AI API Keys", method: "GET", path: "/api/v2/ai_api_keys/:id", tenantAware: true, capability: "aiApiKeys.crud" },
  { key: "aiApiKeys.create", folder: "AI API Keys", method: "POST", path: "/api/v2/ai_api_keys", tenantAware: true, capability: "aiApiKeys.crud" },
  { key: "aiApiKeys.update", folder: "AI API Keys", method: "PUT", path: "/api/v2/ai_api_keys/:id", tenantAware: true, capability: "aiApiKeys.crud" },
  { key: "aiApiKeys.delete", folder: "AI API Keys", method: "DELETE", path: "/api/v2/ai_api_keys/:id", tenantAware: true, capability: "aiApiKeys.crud" },

  { key: "core.currentPlan", folder: "Core", method: "GET", path: "/api/v2/core/current_plan", capability: "core.read" },
  { key: "core.extensionsLimit", folder: "Core", method: "GET", path: "/api/v2/core/extensions_limit", capability: "core.read" },
  { key: "core.externalAddons", folder: "Core", method: "GET", path: "/api/v2/core/external_addons", capability: "core.read" },
  { key: "core.clickToCall", folder: "Core", method: "POST", path: "/api/v2/core/click_to_call", tenantAware: true, capability: "core.callControl" },
  { key: "core.dialerCall", folder: "Core", method: "POST", path: "/api/v2/core/dialer_call", tenantAware: true, capability: "core.callControl" },

  { key: "conferences.list", folder: "Conferences", method: "GET", path: "/api/v2/conferences", tenantAware: true, capability: "conferences.read" },
  { key: "conferences.get", folder: "Conferences", method: "GET", path: "/api/v2/conferences/:id", tenantAware: true, capability: "conferences.read" },
  { key: "classesOfServices.list", folder: "Classes of Services", method: "GET", path: "/api/v2/classes_of_services", tenantAware: true, capability: "classesOfServices.read" },
  { key: "classesOfServices.get", folder: "Classes of Services", method: "GET", path: "/api/v2/classes_of_services/:id", tenantAware: true, capability: "classesOfServices.read" },

  { key: "customerCodes.list", folder: "Customer Codes", method: "GET", path: "/api/v2/customer_codes", tenantAware: true, capability: "customerCodes.crud" },
  { key: "customerCodes.get", folder: "Customer Codes", method: "GET", path: "/api/v2/customer_codes/:id", tenantAware: true, capability: "customerCodes.crud" },
  { key: "customerCodes.create", folder: "Customer Codes", method: "POST", path: "/api/v2/customer_codes", tenantAware: true, capability: "customerCodes.crud" },
  { key: "customerCodes.updatePut", folder: "Customer Codes", method: "PUT", path: "/api/v2/customer_codes/:id", tenantAware: true, capability: "customerCodes.crud" },
  { key: "customerCodes.updatePatch", folder: "Customer Codes", method: "PATCH", path: "/api/v2/customer_codes/:id", tenantAware: true, capability: "customerCodes.crud" },
  { key: "customerCodes.delete", folder: "Customer Codes", method: "DELETE", path: "/api/v2/customer_codes/:id", tenantAware: true, capability: "customerCodes.crud" },

  { key: "cdr.list", folder: "CDR", method: "GET", path: "/api/v2/cdr", tenantAware: true, capability: "cdr.read" },

  { key: "devices.list", folder: "Devices", method: "GET", path: "/api/v2/devices", tenantAware: true, capability: "devices.read" },
  { key: "devices.get", folder: "Devices", method: "GET", path: "/api/v2/devices/:deviceId", tenantAware: true, capability: "devices.read" },
  { key: "devices.vitxiList", folder: "Devices", method: "GET", path: "/api/v2/devices/vitxi", tenantAware: true, capability: "devices.read" },
  { key: "devices.vitxiGet", folder: "Devices", method: "GET", path: "/api/v2/devices/vitxi/:deviceId", tenantAware: true, capability: "devices.read" },
  { key: "devices.queues", folder: "Devices", method: "GET", path: "/api/v2/devices/:deviceId/queues", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesStatus", folder: "Devices", method: "GET", path: "/api/v2/devices/:deviceId/queues/status", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesDynamic", folder: "Devices", method: "GET", path: "/api/v2/devices/:deviceId/queues/dynamic", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesStatic", folder: "Devices", method: "GET", path: "/api/v2/devices/:deviceId/queues/static", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesLogin", folder: "Devices", method: "POST", path: "/api/v2/devices/:deviceId/queues-login", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesPause", folder: "Devices", method: "POST", path: "/api/v2/devices/:deviceId/queues-pause", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesUnpause", folder: "Devices", method: "POST", path: "/api/v2/devices/:deviceId/queues-unpause", tenantAware: true, capability: "queues.agentControl" },
  { key: "devices.queuesLogout", folder: "Devices", method: "POST", path: "/api/v2/devices/:deviceId/queues-logout", tenantAware: true, capability: "queues.agentControl" },

  { key: "deviceProfiles.list", folder: "Device Profiles", method: "GET", path: "/api/v2/device_profiles", tenantAware: true, capability: "devices.read" },
  { key: "deviceProfiles.get", folder: "Device Profiles", method: "GET", path: "/api/v2/device_profiles/:id", tenantAware: true, capability: "devices.read" },
  { key: "deviceProfiles.devices", folder: "Device Profiles", method: "GET", path: "/api/v2/device_profiles/:id/devices", tenantAware: true, capability: "devices.read" },
  { key: "deviceProfiles.webrtc", folder: "Device Profiles", method: "GET", path: "/api/v2/device_profiles/webrtc", tenantAware: true, capability: "devices.read" },

  { key: "destinations.list", folder: "Destinations", method: "GET", path: "/api/v2/destinations", tenantAware: true, capability: "routing.read" },
  { key: "destinations.get", folder: "Destinations", method: "GET", path: "/api/v2/destinations/:id", tenantAware: true, capability: "routing.read" },

  { key: "extensions.list", folder: "Extensions", method: "GET", path: "/api/v2/extensions", tenantAware: true, capability: "extensions.read" },
  { key: "extensions.get", folder: "Extensions", method: "GET", path: "/api/v2/extensions/:extensionId", tenantAware: true, capability: "extensions.read" },
  { key: "extensions.devices", folder: "Extensions", method: "GET", path: "/api/v2/extensions/:extensionId/devices", tenantAware: true, capability: "extensions.read" },
  { key: "extensions.queues", folder: "Extensions", method: "GET", path: "/api/v2/extensions/:extensionId/queues", tenantAware: true, capability: "extensions.read" },
  { key: "extensions.cdrSummary", folder: "Extensions", method: "GET", path: "/api/v2/extensions/:extensionId/cdr_summary", tenantAware: true, capability: "extensions.read" },
  { key: "extensions.voicemailRecords", folder: "Extensions", method: "GET", path: "/api/v2/extensions/:extensionId/voicemail_records", tenantAware: true, capability: "voicemail.read" },

  { key: "outboundRoutes.list", folder: "Outbound Routes", method: "GET", path: "/api/v2/outbound_routes", tenantAware: true, capability: "routing.read" },
  { key: "outboundRoutes.get", folder: "Outbound Routes", method: "GET", path: "/api/v2/outbound_routes/:id", tenantAware: true, capability: "routing.read" },

  { key: "parkingLots.list", folder: "Parking Lots", method: "GET", path: "/api/v2/parking_lots", tenantAware: true, capability: "parking.read" },
  { key: "parkingLots.get", folder: "Parking Lots", method: "GET", path: "/api/v2/parking_lots/:id", tenantAware: true, capability: "parking.read" },

  { key: "phonebooks.list", folder: "Phone Books", method: "GET", path: "/api/v2/phonebooks", tenantAware: true, capability: "phonebooks.read" },
  { key: "phonebooks.get", folder: "Phone Books", method: "GET", path: "/api/v2/phonebooks/:id", tenantAware: true, capability: "phonebooks.read" },
  { key: "phonebooks.contacts", folder: "Phone Books", method: "GET", path: "/api/v2/phonebooks/:id/contacts", tenantAware: true, capability: "phonebooks.read" },

  { key: "queues.list", folder: "Queues", method: "GET", path: "/api/v2/queues", tenantAware: true, capability: "queues.crud" },
  { key: "queues.listInbound", folder: "Queues", method: "GET", path: "/api/v2/queues/inbound", tenantAware: true, capability: "queues.crud" },
  { key: "queues.listOutbound", folder: "Queues", method: "GET", path: "/api/v2/queues/outbound", tenantAware: true, capability: "queues.crud" },
  { key: "queues.get", folder: "Queues", method: "GET", path: "/api/v2/queues/:queueId", tenantAware: true, capability: "queues.crud" },
  { key: "queues.create", folder: "Queues", method: "POST", path: "/api/v2/queues", tenantAware: true, capability: "queues.crud" },
  { key: "queues.update", folder: "Queues", method: "PUT", path: "/api/v2/queues/:queueId", tenantAware: true, capability: "queues.crud" },
  { key: "queues.delete", folder: "Queues", method: "DELETE", path: "/api/v2/queues/:queueId", tenantAware: true, capability: "queues.crud" },

  { key: "routeSelections.list", folder: "Route Selections", method: "GET", path: "/api/v2/route_selections", tenantAware: true, capability: "routing.read" },
  { key: "routeSelections.get", folder: "Route Selections", method: "GET", path: "/api/v2/route_selections/:id", tenantAware: true, capability: "routing.read" },

  { key: "roles.list", folder: "Roles", method: "GET", path: "/api/v2/roles", tenantAware: true, capability: "roles.read" },
  { key: "roles.get", folder: "Roles", method: "GET", path: "/api/v2/roles/:id", tenantAware: true, capability: "roles.read" },
  { key: "roles.modules", folder: "Roles", method: "GET", path: "/api/v2/roles/:id/modules", tenantAware: true, capability: "roles.read" },

  { key: "sms.phoneNumbers", folder: "SMS", method: "GET", path: "/api/v2/sms/phone_numbers", tenantAware: true, capability: "sms.send" },
  { key: "sms.send", folder: "SMS", method: "POST", path: "/api/v2/sms/phone_numbers/:smsPhoneNumberId/send_sms", tenantAware: true, capability: "sms.send" },
  { key: "sms.message", folder: "SMS", method: "GET", path: "/api/v2/sms/messages/:messageId", tenantAware: true, capability: "sms.send" },

  { key: "tenants.list", folder: "Tenants", method: "GET", path: "/api/v2/tenants", capability: "tenants.crud" },
  { key: "tenants.get", folder: "Tenants", method: "GET", path: "/api/v2/tenants/:tenantId", capability: "tenants.crud" },
  { key: "tenants.create", folder: "Tenants", method: "POST", path: "/api/v2/tenants", capability: "tenants.crud" },
  { key: "tenants.update", folder: "Tenants", method: "PUT", path: "/api/v2/tenants/:tenantId", capability: "tenants.crud" },
  { key: "tenants.delete", folder: "Tenants", method: "DELETE", path: "/api/v2/tenants/:tenantId", capability: "tenants.crud" },
  { key: "tenants.changeState", folder: "Tenants", method: "PATCH", path: "/api/v2/tenants/:tenantId/:state", capability: "tenants.crud", notes: "state: enable|disable" },
  { key: "tenants.applyChanges", folder: "Tenants", method: "PUT", path: "/api/v2/tenants/:tenantId/apply_changes", capability: "tenants.crud" },
  { key: "tenants.listInboundNumbers", folder: "Tenants", method: "GET", path: "/api/v2/tenants/:tenantId/inbound_numbers", capability: "tenants.crud" },
  { key: "tenants.addInboundNumbers", folder: "Tenants", method: "PATCH", path: "/api/v2/tenants/:tenantId/inbound_numbers", capability: "tenants.crud" },
  { key: "tenants.removeInboundNumbers", folder: "Tenants", method: "DELETE", path: "/api/v2/tenants/:tenantId/inbound_numbers", capability: "tenants.crud" },

  { key: "trunks.list", folder: "Trunks", method: "GET", path: "/api/v2/trunks", tenantAware: true, capability: "trunks.read" },
  { key: "trunks.get", folder: "Trunks", method: "GET", path: "/api/v2/trunks/:id", tenantAware: true, capability: "trunks.read" },

  { key: "users.list", folder: "Users", method: "GET", path: "/api/v2/users", tenantAware: true, capability: "users.read" },
  { key: "users.get", folder: "Users", method: "GET", path: "/api/v2/users/:id", tenantAware: true, capability: "users.read" },

  { key: "virtualFaxes.list", folder: "Virtual Faxes", method: "GET", path: "/api/v2/virtual_faxes", tenantAware: true, capability: "virtualFaxes.read" },
  { key: "virtualFaxes.get", folder: "Virtual Faxes", method: "GET", path: "/api/v2/virtual_faxes/:faxId", tenantAware: true, capability: "virtualFaxes.read" },
  { key: "virtualFaxes.send", folder: "Virtual Faxes", method: "POST", path: "/api/v2/virtual_faxes/:faxId/send", tenantAware: true, capability: "virtualFaxes.send" },
  { key: "virtualFaxes.log", folder: "Virtual Faxes", method: "GET", path: "/api/v2/virtual_faxes/log/:faxLogId", tenantAware: true, capability: "virtualFaxes.read" },

  { key: "voicemail.delete", folder: "Voicemail", method: "DELETE", path: "/api/v2/voicemail/:mailbox/:folder/:messageName", tenantAware: true, capability: "voicemail.delete" },
  { key: "voicemail.markListened", folder: "Voicemail", method: "POST", path: "/api/v2/voicemail/:mailbox/:folder/:messageName", tenantAware: true, capability: "voicemail.update" },

  { key: "whatsapp.numbers", folder: "Whatsapp", method: "GET", path: "/api/v2/whatsapp/numbers", tenantAware: true, capability: "whatsapp.messaging" },
  { key: "whatsapp.sendMessage", folder: "Whatsapp", method: "POST", path: "/api/v2/whatsapp/numbers/:waNumberId/messages", tenantAware: true, capability: "whatsapp.messaging" },
  { key: "whatsapp.sendMedia", folder: "Whatsapp", method: "POST", path: "/api/v2/whatsapp/numbers/:waNumberId/media", tenantAware: true, capability: "whatsapp.messaging" },
  { key: "whatsapp.messageMedia", folder: "Whatsapp", method: "GET", path: "/api/v2/whatsapp/messages/:waMessageId/media", tenantAware: true, capability: "whatsapp.messaging" }
];

const endpointMap = new Map(VITALPBX_ENDPOINTS.map((row) => [row.key, row]));

export function getVitalPbxEndpoint(key: string): VitalPbxEndpointDefinition {
  const entry = endpointMap.get(key);
  if (!entry) throw new Error(`Unknown VitalPBX endpoint key: ${key}`);
  return entry;
}

export function listVitalPbxEndpoints(): VitalPbxEndpointDefinition[] {
  return [...VITALPBX_ENDPOINTS];
}
