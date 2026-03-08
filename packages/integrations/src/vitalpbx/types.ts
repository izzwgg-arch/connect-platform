export type VitalPbxHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type VitalPbxConfig = {
  baseUrl?: string;
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
  logger?: (entry: VitalPbxLogEntry) => void;
};

export type VitalPbxErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "PBX_AUTH_FAILED"
  | "PBX_UNAVAILABLE"
  | "PBX_VALIDATION_FAILED"
  | "PBX_RATE_LIMIT"
  | "PBX_TENANT_CONTEXT_ERROR"
  | "PBX_TIMEOUT"
  | "PBX_PARSE_ERROR"
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
