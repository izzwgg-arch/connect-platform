"use client";

export type ChatThreadType = "SMS" | "DM" | "GROUP" | "TENANT_GROUP";
export type ChatMessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "VOICE_NOTE" | "FILE" | "LOCATION" | "SYSTEM";

export interface ChatThread {
  id: string;
  type: ChatThreadType;
  title?: string | null;
  isDefaultTenantGroup?: boolean;
  tenantSmsE164?: string | null;
  externalSmsE164?: string | null;
  participantName: string;
  participantExtension: string;
  lastMessage: string;
  lastAt: string;
  unread: number;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
}

export interface ChatAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus?: string;
  downloadUrl: string | null;
}

export interface ChatLocation {
  lat: number;
  lng: number;
  label?: string;
  address?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
  mine: boolean;
  type: ChatMessageType;
  editedAt?: string | null;
  deletedForEveryoneAt?: string | null;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
  reactions?: Array<{ emoji: string; userId: string }>;
  mmsUrls?: string[];
  location?: ChatLocation | null;
  replyTo?: { id: string; body: string; type: ChatMessageType; senderName: string } | null;
  attachments?: ChatAttachment[];
}

export interface ChatDirectoryUser {
  id: string;
  name: string;
  email: string;
  role: string;
  extensionId?: string | null;
  extensionNumber?: string | null;
  extensionName?: string | null;
  self?: boolean;
}

export interface PendingAttachment {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
