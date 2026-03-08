export type TelephonyObjectKind =
  | "tenantContext"
  | "extensions"
  | "trunks"
  | "queues"
  | "ringGroups"
  | "ivr"
  | "recordings"
  | "voicemail";

export type TelephonyDiscoveryResult = {
  kind: TelephonyObjectKind;
  exists: boolean;
  count?: number;
  source: "api";
};

export type TenantTelephonyState = {
  tenantId: string;
  exists: boolean;
  discovered: TelephonyDiscoveryResult[];
};
