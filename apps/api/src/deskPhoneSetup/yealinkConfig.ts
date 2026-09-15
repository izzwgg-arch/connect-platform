import { DeviceError } from "./yealinkRps";

// Deliberately a qualified subset of the existing inventory catalog. Firmware
// qualification is unknown until a handset is tested; never invent a minimum.
export const YEALINK_MANAGED_MODELS = [
  { model: "T31P", family: "T3", accounts: 2, lineKeys: 2, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T33G", family: "T3", accounts: 4, lineKeys: 4, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T43U", family: "T4", accounts: 12, lineKeys: 8, wifi: "usb", bluetooth: "usb", expansion: "EXP43" },
  { model: "T46U", family: "T4", accounts: 16, lineKeys: 10, wifi: "usb", bluetooth: "usb", expansion: "EXP43" },
  { model: "T53W", family: "T5", accounts: 12, lineKeys: 8, wifi: "built-in", bluetooth: "built-in", expansion: "EXP50" },
  { model: "T54W", family: "T5", accounts: 16, lineKeys: 10, wifi: "built-in", bluetooth: "built-in", expansion: "EXP50" },
  { model: "T57W", family: "T5", accounts: 16, lineKeys: 29, wifi: "built-in", bluetooth: "built-in", expansion: "EXP50" },
  // 2026-09-15 (Izzy: "there's a lot more than that" — his own T42S had no row). Every model
  // below has a template on the PBX (vendorCatalog.generated) and its lineKeys value is the
  // programmable-key range read from the vendor's own template header (buttonLayout
  // YEALINK_KEY_COUNTS). lineKeys is the only field the generator consumes (the BLF cap;
  // under-filling is invisible, over-cap keys are silently dropped by the phone). accounts is
  // informational. All stay pending_handset_validation until a real handset registers.
  { model: "T48U", family: "T4", accounts: 16, lineKeys: 29, wifi: "usb", bluetooth: "usb", expansion: "EXP43" },
  { model: "T48G", family: "T4", accounts: 16, lineKeys: 29, wifi: "none", bluetooth: "none", expansion: "EXP40" },
  { model: "T48S", family: "T4", accounts: 16, lineKeys: 29, wifi: "usb", bluetooth: "usb", expansion: "EXP40" },
  { model: "T53", family: "T5", accounts: 12, lineKeys: 27, wifi: "usb", bluetooth: "usb", expansion: "EXP50" },
  { model: "T54S", family: "T5", accounts: 16, lineKeys: 27, wifi: "usb", bluetooth: "usb", expansion: "EXP50" },
  { model: "T46G", family: "T4", accounts: 16, lineKeys: 27, wifi: "none", bluetooth: "none", expansion: "EXP40" },
  { model: "T46S", family: "T4", accounts: 16, lineKeys: 27, wifi: "usb", bluetooth: "usb", expansion: "EXP40" },
  { model: "T29G", family: "T2", accounts: 16, lineKeys: 27, wifi: "none", bluetooth: "none", expansion: "EXP20" },
  { model: "T58A", family: "T5", accounts: 16, lineKeys: 27, wifi: "built-in", bluetooth: "built-in", expansion: "EXP50" },
  { model: "T52S", family: "T5", accounts: 12, lineKeys: 21, wifi: "usb", bluetooth: "usb", expansion: "EXP50" },
  { model: "T27P", family: "T2", accounts: 6, lineKeys: 21, wifi: "none", bluetooth: "none", expansion: "EXP20" },
  { model: "T27G", family: "T2", accounts: 6, lineKeys: 21, wifi: "none", bluetooth: "none", expansion: "EXP20" },
  { model: "T42G", family: "T4", accounts: 12, lineKeys: 15, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T42S", family: "T4", accounts: 12, lineKeys: 15, wifi: "usb", bluetooth: "none", expansion: null },
  { model: "T41P", family: "T4", accounts: 6, lineKeys: 15, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T41S", family: "T4", accounts: 6, lineKeys: 15, wifi: "usb", bluetooth: "none", expansion: null },
  { model: "T41U", family: "T4", accounts: 6, lineKeys: 15, wifi: "usb", bluetooth: "usb", expansion: null },
  { model: "T42U", family: "T4", accounts: 12, lineKeys: 15, wifi: "usb", bluetooth: "usb", expansion: null },
  { model: "T44U", family: "T4", accounts: 12, lineKeys: 15, wifi: "usb", bluetooth: "usb", expansion: null },
  { model: "T44W", family: "T4", accounts: 12, lineKeys: 15, wifi: "built-in", bluetooth: "built-in", expansion: null },
  { model: "T34W", family: "T3", accounts: 4, lineKeys: 4, wifi: "built-in", bluetooth: "none", expansion: null },
  { model: "T31G", family: "T3", accounts: 2, lineKeys: 4, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T31W", family: "T3", accounts: 2, lineKeys: 4, wifi: "built-in", bluetooth: "none", expansion: null },
  { model: "T30", family: "T3", accounts: 1, lineKeys: 4, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T30P", family: "T3", accounts: 1, lineKeys: 4, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T40P", family: "T4", accounts: 3, lineKeys: 3, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T40G", family: "T4", accounts: 3, lineKeys: 3, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T23P", family: "T2", accounts: 3, lineKeys: 3, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T23G", family: "T2", accounts: 3, lineKeys: 3, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T21P_E2", family: "T2", accounts: 2, lineKeys: 2, wifi: "none", bluetooth: "none", expansion: null },
  { model: "T21P", family: "T2", accounts: 2, lineKeys: 2, wifi: "none", bluetooth: "none", expansion: null },
].map(m => ({ ...m, manufacturer: "yealink", poe: true, minimumFirmware: null,
  recommendedFirmware: null, templateVersion: 1, qualification: "pending_handset_validation",
  capabilities: { config: true, rps: true, reboot: false, factoryReset: false, firmwareUpdate: false, ymcs: false } }));

export function managedModel(name: string) {
  const model = YEALINK_MANAGED_MODELS.find(m => m.model === name.toUpperCase());
  if (!model) throw new DeviceError("unsupported_model", 400);
  return model;
}
export type SipConfig = {
  endpoint: string; username: string; authName: string; password: string;
  server: string; port: number; transport: "UDP" | "TCP" | "TLS";
  displayName: string; label: string;
  outboundProxy?: string; outboundPort?: number;
  blf: { extension: string; label: string }[];
};
export type DeviceConfigOptions = { refreshMinutes?: number; vlan?: number; callWaiting?: boolean };
const value = (v: unknown) => {
  const s = String(v);
  if (/[\r\n\x00-\x1f\x7f#]/.test(s) || s.length > 512) throw new DeviceError("configuration_value_not_supported", 400);
  return s;
};
export function yealinkConfig(modelName: string, sip: SipConfig,
  secret: { adminPassword: string; provisioningPassword: string }, url: string, mac: string,
  options: DeviceConfigOptions = {}) {
  const model = managedModel(modelName);
  if (!sip.password || !sip.server || !sip.username || !sip.authName) throw new DeviceError("desk_endpoint_credentials_unavailable", 503);
  const interval = options.refreshMinutes ?? 1440;
  if (!Number.isInteger(interval) || interval < 60 || interval > 10080) throw new DeviceError("invalid_refresh_interval", 400);
  if (options.vlan !== undefined && (!Number.isInteger(options.vlan) || options.vlan < 1 || options.vlan > 4094)) throw new DeviceError("invalid_vlan", 400);
  const p: Record<string, unknown> = {
    "account.1.enable": 1, "account.1.label": sip.label, "account.1.display_name": sip.displayName,
    "account.1.user_name": sip.username, "account.1.auth_name": sip.authName, "account.1.password": sip.password,
    "account.1.sip_server.1.address": sip.server, "account.1.sip_server.1.port": sip.port,
    "account.1.sip_server.1.transport_type": { UDP: 0, TCP: 1, TLS: 2 }[sip.transport],
    "account.1.outbound_proxy_enable": sip.outboundProxy ? 1 : 0,
    "account.1.outbound_host": sip.outboundProxy ?? "", "account.1.outbound_port": sip.outboundPort ?? 5060,
    "voice_mail.number.1": "*97", "local_time.time_zone": "-5", "local_time.time_zone_name": "United States-Eastern Time",
    "local_time.time_format": 0, "local_time.date_format": 0, "local_time.summer_time": 2,
    "local_time.ntp_server1": "pool.ntp.org", "phone_setting.backlight_time": 0,
    "account.1.dtmf.type": 1, "account.1.dtmf.dtmf_payload": 101,
    "features.call_waiting.enable": options.callWaiting === false ? 0 : 1,
    "auto_provision.server.url": url, "auto_provision.server.username": mac,
    "auto_provision.server.password": secret.provisioningPassword,
    "auto_provision.power_on": 1, "auto_provision.repeat.enable": 1, "auto_provision.repeat.minutes": interval,
    "security.user_password": `admin:${secret.adminPassword}`, "network.web_server_type": 3,
  };
  if (options.vlan !== undefined) { p["network.vlan.internet_port_enable"] = 1; p["network.vlan.internet_port_vid"] = options.vlan; }
  // House BLF policy: primary line, then colleagues, within physical/model key capacity.
  p["linekey.1.type"] = 15; p["linekey.1.line"] = 1;
  sip.blf.slice(0, model.lineKeys - 1).forEach((b, i) => {
    const key = `linekey.${i + 2}`;
    p[`${key}.type`] = 16; p[`${key}.line`] = 1; p[`${key}.value`] = b.extension;
    p[`${key}.extension`] = b.extension; p[`${key}.label`] = b.label;
  });
  return "#!version:1.0.0.1\n" + Object.entries(p).map(([k, v]) => `${k} = ${value(v)}`).join("\n") + "\n";
}

/** Optional management channel; RPS implements none of these operations. */
export interface YealinkManagement {
  capabilities(): { reboot: boolean; factoryReset: boolean; firmwareUpdate: boolean; diagnostics: boolean };
  execute(deviceId: string, action: "reboot" | "factoryReset" | "firmwareUpdate" | "diagnostics"): Promise<void>;
}
