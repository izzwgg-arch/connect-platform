/**
 * Quick replies for incoming calls ("decline with message").
 *
 * The user picks (or types) a short message on the incoming-call screen or the
 * heads-up notification's Reply action; we send it as an SMS from the user's
 * own number (via the existing chat SMS pipeline) and decline the call.
 *
 * Storage: AsyncStorage, one JSON array of strings. Defaults below apply when
 * the user never customized the list (editable in Settings).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createChatThread, sendChatMessage } from "../api/client";

const STORAGE_KEY = "cc_call_quick_replies_v1";

export const DEFAULT_QUICK_REPLIES: string[] = [
  "I'll call you right back",
  "Can't talk now — what's up?",
  "In a meeting, call you in 30 min",
];

export const MAX_QUICK_REPLIES = 5;

export async function getQuickReplies(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUICK_REPLIES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_QUICK_REPLIES;
    const cleaned = parsed
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .slice(0, MAX_QUICK_REPLIES);
    return cleaned.length > 0 ? cleaned : DEFAULT_QUICK_REPLIES;
  } catch {
    return DEFAULT_QUICK_REPLIES;
  }
}

export async function setQuickReplies(replies: string[]): Promise<void> {
  const cleaned = replies
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_QUICK_REPLIES);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}

/**
 * True when the caller can receive an SMS reply — a real PSTN number (10+
 * digits). Internal extensions (2–6 digits) can't receive SMS, so the Reply
 * button is hidden for them.
 */
export function canSmsReply(callerNumber: string | null | undefined): boolean {
  const digits = String(callerNumber ?? "").replace(/\D/g, "");
  return digits.length >= 10;
}

/**
 * Send the reply text as an SMS to the caller via the chat SMS pipeline
 * (server sends from the user's own number). Reuses/creates the SMS thread —
 * the message also shows up in the SMS tab like any other text.
 */
export async function sendQuickReplySms(
  token: string,
  callerNumber: string,
  message: string,
): Promise<void> {
  const digits = String(callerNumber).replace(/\D/g, "");
  const externalPhone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const { threadId } = await createChatThread(token, { type: "sms", externalPhone });
  await sendChatMessage(token, threadId, message);
}
