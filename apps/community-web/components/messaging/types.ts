import type { PersonCard } from "@/components/graph/types";

export type ThreadParticipantView = {
  person: PersonCard;
  state: "ACTIVE" | "REQUESTED" | "DECLINED" | "LEFT";
  role: string;
  online: boolean;
  lastReadAt: string | null;
};

export type ThreadListItem = {
  id: string;
  kind: "DIRECT" | "GROUP" | "RFQ" | "EVENT" | "GROUP_CHAT" | "INTRO";
  title: string;
  participants: ThreadParticipantView[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  pinnedAt: string | null;
  mutedUntil: string | null;
  ref: { type: string; id: string } | null;
  requestFromMe: boolean;
};

export type ThreadDetail = {
  id: string;
  kind: ThreadListItem["kind"];
  title: string;
  participants: ThreadParticipantView[];
  myState: ThreadParticipantView["state"];
  myRole: string;
  ref: { type: string; id: string } | null;
  sharedFiles: Array<{ id: string; kind: string; mime: string; url: string; name: string | null }>;
};

export type MessageAsset = { id: string; kind: string; mime: string; url: string; name: string | null };

export type Message = {
  id: string;
  threadId: string;
  sender: PersonCard | null;
  kind: "TEXT" | "IMAGE" | "FILE" | "AUDIO" | "VIDEO" | "SYSTEM" | "QUOTE_CARD";
  body: string | null;
  asset: MessageAsset | null;
  replyTo: { id: string; senderName: string; body: string | null } | null;
  forwardedFrom: string | null;
  refType: string | null;
  refId: string | null;
  reactions: Record<string, number | string[]> & { mine?: string[] };
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "🙏", "🎉"];
