export type VoicemailFolder = "inbox" | "old" | "urgent";

export type VoicemailTab = "inbox" | "new" | "urgent" | "old";

export interface VoicemailRow {
  id: string;
  callerId: string;
  callerName?: string | null;
  receivedAt: string;
  durationSec: number;
  folder: VoicemailFolder;
  listened: boolean;
  extension: string;
  tenantId: string | null;
  tenantName?: string | null;
  /** AI / PBX transcript when API provides it */
  transcription?: string | null;
  streamUrl?: string;
  pbxMessageId?: string;
  readAt?: string | null;
}

export interface VoicemailListResponse {
  voicemails: VoicemailRow[];
  total: number;
  page: number;
}
