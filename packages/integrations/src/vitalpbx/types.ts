export type VitalPbxHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type VitalPbxConfig = {
  baseUrl?: string;
  /** Optional. Base URL for Asterisk ARI (e.g. http://pbxhost:8088). If not set, ARI uses baseUrl. */
  ariBaseUrl?: string;
  appKey?: string;
  apiToken?: string;
  apiSecret?: string;
  timeoutMs?: number;
  simulate?: boolean;
  tenantHeaderName?: string;
  tenantQueryName?: string;
  tenantTransport?: "header" | "query" | "both";
  retryCount?: number;
  userAgent?: string;
  /**
   * PBX WRITE SAFEGUARD. When false (the default), this client REFUSES every
   * config-mutating VitalPBX endpoint (`pbxConfigMutation: true`) — tenant
   * create/update/delete, inbound-number add/remove, apply_changes, queue and
   * code CRUD, etc. — and throws `PBX_MUTATION_BLOCKED` instead of issuing the
   * request. This exists because an automatic tenant re-save silently wiped
   * tenants' inbound DIDs (June 2026). Connect must NOT modify the PBX without
   * explicit, human-granted permission. Set to true ONLY for a specific,
   * operator-authorized operation. Defaults from env `PBX_ALLOW_CONFIG_MUTATIONS`
   * ("1"/"true"/"yes"/"on") when not passed explicitly.
   */
  allowConfigMutations?: boolean;
  logger?: (entry: VitalPbxLogEntry) => void;
};

export type VitalPbxErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "INVALID_API_KEY"
  | "PERMISSION_DENIED"
  | "PBX_UNAVAILABLE"
  | "PBX_VALIDATION_FAILED"
  | "PBX_RATE_LIMIT"
  | "PBX_TENANT_CONTEXT_ERROR"
  | "PBX_UNREACHABLE"
  | "PBX_PARSE_ERROR"
  | "PBX_MUTATION_BLOCKED"
  | "PBX_UNKNOWN_ERROR";

export type VitalPbxApiError = Error & {
  code: VitalPbxErrorCode;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type VitalPbxApiEnvelope<T> = {
  status?: string;
  message?: string | null;
  data?: T;
};

export type VitalPbxCallParams = {
  tenant?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: Record<string, unknown> | Array<unknown>;
  headers?: Record<string, string | undefined>;
  correlationId?: string;
};

export type VitalPbxLogEntry = {
  direction: "request" | "response" | "error";
  method?: string;
  path?: string;
  status?: number;
  correlationId?: string;
  elapsedMs?: number;
  errorCode?: string;
  message?: string;
};

export type VitalPbxEndpointDefinition = {
  key: string;
  folder: string;
  method: VitalPbxHttpMethod;
  path: string;
  tenantAware?: boolean;
  capability?: string;
  notes?: string;
  /**
   * True for endpoints that CHANGE PBX CONFIGURATION (tenant lifecycle, inbound
   * numbers/DIDs, apply_changes/regenerate, queue & code CRUD). The client
   * blocks these unless `allowConfigMutations` is explicitly enabled. Runtime
   * call/message actions (click-to-call, SMS, WhatsApp, fax, voicemail message
   * ops, agent queue login/pause) are intentionally NOT flagged — they are
   * operational, not configuration changes.
   */
  pbxConfigMutation?: boolean;
};

export type VitalPbxCapabilityMatrix = {
  supportsAuthorizationCodesCrud: boolean;
  supportsCustomerCodesCrud: boolean;
  supportsAiApiKeysCrud: boolean;
  supportsAccountCodesRead: boolean;
  supportsExtensionAccountCodesRead: boolean;
  supportsTenantsCrud: boolean;
  supportsQueuesCrud: boolean;
  supportsRecordingsRead: boolean;
  supportsVoicemailDelete: boolean;
  supportsVoicemailMarkListened: boolean;
  supportsWhatsappMessaging: boolean;
  supportsSmsSending: boolean;
  supportsCdrRead: boolean;
  supportsRecordingUrlInCdr: boolean;
};
