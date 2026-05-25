export type WhatsAppProvider = "WHATSAPP_META" | "WHATSAPP_TWILIO";

export type WaInboundMediaItem = {
  kind: "image" | "video" | "audio" | "file";
  providerId: string;
  mime?: string | null;
};

export type WaInboundMessageEvent = {
  type: "wa_inbound_message";
  tenantId: string;
  provider: WhatsAppProvider;
  accountRef: string; // meta: phoneNumberId; twilio: accountSid or messagingServiceSid/from
  externalMessageId?: string | null;
  from: string;
  to: string;
  bodyText?: string | null;
  media?: WaInboundMediaItem[];
  timestamp: string; // ISO
  providerPayloadRedacted: Record<string, unknown>;
};

export type WaStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED";

export type WaStatusEvent = {
  type: "wa_status";
  tenantId: string;
  provider: WhatsAppProvider;
  accountRef: string; // meta: phoneNumberId; twilio: accountSid
  externalMessageId: string;
  status: WaStatus;
  errorCode?: string | null;
  timestamp: string; // ISO
  providerPayloadRedacted: Record<string, unknown>;
};

export type WaNormalizedEvent = WaInboundMessageEvent | WaStatusEvent;
