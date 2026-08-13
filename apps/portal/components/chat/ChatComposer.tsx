"use client";

import { FileText, Images, MapPin, Mic, Plus, Send, Smile, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatThread, PendingAttachment } from "./types";
import { formatBytes } from "./formatting";
import { isSmsTextOverLimit } from "./SmsCharCounter";

const MEDIA_ACCEPT = ["image/*", "video/mp4", "video/webm"].join(",");
const ACCEPT = [
  "image/*",
  "audio/*",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
].join(",");

const COMMON_EMOJIS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
  "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥸", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "☹️",
  "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓",
  "🤗", "🤔", "🫣", "🤭", "🫢", "🫡", "🤫", "🫠", "🤥", "😶", "🫥", "😐", "🫤", "😑", "😬", "🙄", "😯", "😦", "😧", "😮",
  "😲", "🥱", "😴", "🤤", "😪", "😵", "🫨", "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠", "😈", "👿", "👻",
  "💀", "☠️", "👽", "🤖", "💩", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "👋", "🤚", "🖐️", "✋", "🖖", "👌",
  "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜",
  "👏", "🙌", "🫶", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🫀",
  "🫁", "🦷", "🦴", "👀", "👁️", "👅", "👄", "💋", "🩸", "👶", "🧒", "👦", "👧", "🧑", "👱", "👨", "🧔", "👩", "🧓", "👴",
  "👵", "🙍", "🙎", "🙅", "🙆", "💁", "🙋", "🧏", "🙇", "🤦", "🤷", "👮", "🕵️", "💂", "🥷", "👷", "🫅", "🤴", "👸", "👳",
  "👲", "🧕", "🤵", "👰", "🤰", "🫃", "🫄", "🤱", "👼", "🎅", "🤶", "🧑‍🎄", "🦸", "🦹", "🧙", "🧚", "🧛", "🧜", "🧝", "🧞",
  "🧟", "💆", "💇", "🚶", "🧍", "🧎", "🏃", "💃", "🕺", "🕴️", "👯", "🧖", "🧗", "🤺", "🏇", "⛷️", "🏂", "🏌️", "🏄", "🚣",
  "🏊", "⛹️", "🏋️", "🚴", "🚵", "🤸", "🤼", "🤽", "🤾", "🤹", "🧘", "🛀", "🛌", "👭", "👫", "👬", "💏", "💑", "👪", "🗣️",
  "👤", "👥", "🫂", "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐻‍❄️", "🐨", "🐯", "🦁", "🐮", "🐷", "🐽", "🐸", "🐵",
  "🙈", "🙉", "🙊", "🐒", "🐔", "🐧", "🐦", "🐤", "🐣", "🐥", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🪱",
  "🐛", "🦋", "🐌", "🐞", "🐜", "🪰", "🪲", "🪳", "🦟", "🦗", "🕷️", "🦂", "🐢", "🐍", "🦎", "🦖", "🦕", "🐙", "🦑", "🦐",
  "🦞", "🦀", "🐡", "🐠", "🐟", "🐬", "🐳", "🐋", "🦈", "🦭", "🐊", "🐅", "🐆", "🦓", "🦍", "🦧", "🦣", "🐘", "🦛", "🦏",
  "🐪", "🐫", "🦒", "🦘", "🦬", "🐃", "🐂", "🐄", "🐎", "🐖", "🐏", "🐑", "🦙", "🐐", "🦌", "🐕", "🐩", "🦮", "🐕‍🦺", "🐈",
  "🐈‍⬛", "🪶", "🐓", "🦃", "🦤", "🦚", "🦜", "🦢", "🦩", "🕊️", "🐇", "🦝", "🦨", "🦡", "🦫", "🦦", "🦥", "🐁", "🐀", "🐿️",
  "🦔", "🐾", "🐉", "🐲", "🌵", "🎄", "🌲", "🌳", "🌴", "🪵", "🌱", "🌿", "☘️", "🍀", "🎍", "🪴", "🎋", "🍃", "🍂", "🍁",
  "🍄", "🐚", "🪸", "🌾", "💐", "🌷", "🌹", "🥀", "🪷", "🌺", "🌸", "🌼", "🌻", "🌞", "🌝", "🌛", "🌜", "🌚", "🌕", "🌖",
  "🌗", "🌘", "🌑", "🌒", "🌓", "🌔", "🌙", "🌎", "🌍", "🌏", "🪐", "💫", "⭐", "🌟", "✨", "⚡", "☄️", "💥", "🔥", "🌪️",
  "🌈", "☀️", "🌤️", "⛅", "🌥️", "☁️", "🌦️", "🌧️", "⛈️", "🌩️", "🌨️", "❄️", "☃️", "⛄", "🌬️", "💨", "💧", "💦", "☔", "☂️",
  "🌊", "🌫️", "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅",
  "🍆", "🥑", "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🫒", "🧄", "🧅", "🥔", "🍠", "🥐", "🥯", "🍞", "🥖", "🥨", "🧀",
  "🥚", "🍳", "🧈", "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🦴", "🌭", "🍔", "🍟", "🍕", "🫓", "🥪", "🥙", "🧆", "🌮", "🌯",
  "🫔", "🥗", "🥘", "🫕", "🥫", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟", "🦪", "🍤", "🍙", "🍚", "🍘", "🍥", "🥠", "🥮",
  "🍢", "🍡", "🍧", "🍨", "🍦", "🥧", "🧁", "🍰", "🎂", "🍮", "🍭", "🍬", "🍫", "🍿", "🍩", "🍪", "🌰", "🥜", "🍯", "🥛",
  "🍼", "🫖", "☕", "🍵", "🧃", "🥤", "🧋", "🍶", "🍺", "🍻", "🥂", "🍷", "🥃", "🍸", "🍹", "🧉", "🍾", "🧊", "🥄", "🍴",
  "🍽️", "🥣", "🥡", "🥢", "🧂",
];

type EmojiCategory =
  | "Smileys"
  | "Hand Gestures"
  | "People"
  | "Animals & Nature"
  | "Food & Drink"
  | "Travel & Places"
  | "Activities"
  | "Objects"
  | "Symbols";

type EmojiEntry = {
  emoji: string;
  category: EmojiCategory;
  description: string;
  keywords: string;
};

type EmojiUsage = {
  count: number;
  lastUsed: number;
};

type EmojiGroup = {
  category: "Recent" | EmojiCategory;
  entries: EmojiEntry[];
};

const EMOJI_RECENT_STORAGE_KEY = "connect.chat.recentEmojis.v1";

const EMOJI_CATEGORY_ORDER: EmojiCategory[] = [
  "Smileys",
  "Hand Gestures",
  "People",
  "Animals & Nature",
  "Food & Drink",
  "Travel & Places",
  "Activities",
  "Objects",
  "Symbols",
];

const HAND_GESTURE_EMOJIS = new Set([
  "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙",
  "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌",
  "🫶", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳",
]);

const EMOJI_DESCRIPTIONS: Record<string, string> = {
  "😀": "grinning face happy smile",
  "😃": "big smile happy face",
  "😄": "smiling face happy laugh",
  "😁": "beaming face grin",
  "😆": "laughing squinting face",
  "😅": "sweat smile nervous laugh",
  "😂": "tears of joy laughing crying",
  "🤣": "rolling on the floor laughing rofl",
  "😊": "smiling face blush happy",
  "😇": "angel innocent halo",
  "🙂": "slight smile friendly",
  "🙃": "upside down silly sarcasm",
  "😉": "wink playful",
  "😌": "relieved calm content",
  "😍": "heart eyes love",
  "🥰": "smiling hearts loved",
  "😘": "kiss heart",
  "😋": "yum tasty delicious",
  "😛": "tongue playful",
  "😜": "winking tongue silly",
  "🤪": "zany silly goofy",
  "🤔": "thinking question",
  "🤫": "shush quiet",
  "😎": "cool sunglasses",
  "🥳": "party celebration",
  "😭": "crying sob sad",
  "😡": "angry mad",
  "🤯": "mind blown shocked",
  "😴": "sleep tired",
  "🤮": "vomit sick",
  "👋": "waving hand hello goodbye",
  "🤚": "raised back of hand stop high five",
  "🖐️": "hand with fingers splayed high five",
  "✋": "raised hand stop high five",
  "🖖": "vulcan salute hand live long prosper",
  "👌": "ok hand perfect",
  "🤌": "pinched fingers hand gesture",
  "🤏": "pinching hand small tiny",
  "✌️": "victory hand peace",
  "🤞": "crossed fingers luck",
  "🫰": "hand with index finger and thumb crossed heart money",
  "🤟": "love you hand gesture",
  "🤘": "rock on horns hand",
  "🤙": "call me shaka hand",
  "👈": "backhand index pointing left",
  "👉": "backhand index pointing right",
  "👆": "backhand index pointing up",
  "🖕": "middle finger hand",
  "👇": "backhand index pointing down",
  "☝️": "index finger pointing up",
  "👍": "thumbs up approve yes like",
  "👎": "thumbs down no dislike",
  "✊": "raised fist power solidarity",
  "👊": "fist bump punch",
  "🤛": "left facing fist bump",
  "🤜": "right facing fist bump",
  "👏": "clapping hands applause",
  "🙌": "raising hands celebrate praise",
  "🫶": "heart hands love",
  "👐": "open hands",
  "🤲": "palms up together prayer receive",
  "🤝": "handshake agreement",
  "🙏": "folded hands prayer please thank you",
  "✍️": "writing hand sign",
  "💅": "nail polish manicure",
  "🤳": "selfie phone",
  "❤️": "red heart love",
  "💙": "blue heart love connect",
  "💜": "purple heart love",
  "💚": "green heart love",
  "💛": "yellow heart love",
  "💔": "broken heart sad",
  "🔥": "fire hot lit",
  "✨": "sparkles shine magic",
  "⭐": "star favorite",
  "💯": "hundred perfect",
  "✅": "check mark done yes",
  "❌": "cross mark no wrong",
  "🐶": "dog pet animal",
  "🐱": "cat pet animal",
  "🌹": "rose flower love",
  "🌻": "sunflower flower",
  "☀️": "sun sunny weather",
  "🌧️": "rain weather",
  "🌈": "rainbow pride weather",
  "🍎": "apple fruit food",
  "🍌": "banana fruit food",
  "🍕": "pizza food",
  "🍔": "burger food",
  "☕": "coffee drink",
  "🍺": "beer drink",
  "🚗": "car travel vehicle",
  "✈️": "airplane plane flight travel",
  "🏠": "house home",
  "📞": "telephone phone call",
  "💻": "laptop computer",
  "📎": "paperclip attachment",
  "📍": "pin location",
  "🎉": "party popper celebration",
  "🎁": "gift present",
  "⚽": "soccer ball sport",
  "🏀": "basketball sport",
};

function firstCodePoint(emoji: string): number {
  return emoji.codePointAt(0) ?? 0;
}

function isHandGestureCode(code: number): boolean {
  return (
    (code >= 0x1f44a && code <= 0x1f450) ||
    (code >= 0x1f590 && code <= 0x1f596) ||
    (code >= 0x1f64c && code <= 0x1f64f) ||
    (code >= 0x1f90c && code <= 0x1f91f) ||
    (code >= 0x1faf0 && code <= 0x1faff) ||
    (code >= 0x270a && code <= 0x270d) ||
    code === 0x261d
  );
}

function categorizeEmoji(code: number): EmojiCategory {
  if (isHandGestureCode(code)) return "Hand Gestures";
  if (code >= 0x1f600 && code <= 0x1f64f) return "Smileys";
  if ((code >= 0x1f466 && code <= 0x1f487) || (code >= 0x1f590 && code <= 0x1f5ff) || (code >= 0x1faf0 && code <= 0x1faff)) {
    return "People";
  }
  if ((code >= 0x1f300 && code <= 0x1f5ff) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x1fa70 && code <= 0x1faff)) {
    if ((code >= 0x1f330 && code <= 0x1f37f) || (code >= 0x1f950 && code <= 0x1f96f) || (code >= 0x1fad0 && code <= 0x1fadf)) return "Food & Drink";
    if ((code >= 0x1f3a0 && code <= 0x1f3ff) || (code >= 0x1f93a && code <= 0x1f945)) return "Activities";
    if ((code >= 0x1f680 && code <= 0x1f6ff) || (code >= 0x1f5fa && code <= 0x1f5ff)) return "Travel & Places";
    if ((code >= 0x1f400 && code <= 0x1f43f) || (code >= 0x1f980 && code <= 0x1f9ae) || (code >= 0x1fab0 && code <= 0x1fabf)) return "Animals & Nature";
    if ((code >= 0x1f4a0 && code <= 0x1f5ff) || (code >= 0x1fa80 && code <= 0x1fa9f)) return "Objects";
    return "Animals & Nature";
  }
  if ((code >= 0x2600 && code <= 0x26ff) || (code >= 0x2700 && code <= 0x27bf) || (code >= 0x1f700 && code <= 0x1f8ff)) return "Symbols";
  return "Objects";
}

function describeEmoji(emoji: string, code: number, category: EmojiCategory): string {
  const directDescription = EMOJI_DESCRIPTIONS[emoji];
  if (directDescription) return directDescription;

  if (HAND_GESTURE_EMOJIS.has(emoji) || category === "Hand Gestures") {
    return "hand gesture fingers sign point clap wave thumbs fist prayer";
  }
  if (category === "Smileys") return "face expression emotion smile happy sad laugh cry reaction";
  if (category === "People") return "person people body human role family";
  if (category === "Animals & Nature") return "animal nature plant flower weather earth creature";
  if (category === "Food & Drink") return "food drink meal fruit vegetable beverage dessert";
  if (category === "Travel & Places") return "travel place vehicle transport building map location";
  if (category === "Activities") return "activity sport game celebration event music award";
  if (category === "Objects") return "object tool office phone device clothing household";
  if ((code >= 0x2600 && code <= 0x27bf) || category === "Symbols") return "symbol sign mark arrow shape number zodiac";
  return "emoji";
}

function buildEmojiCatalog(): EmojiEntry[] {
  const out = new Map<string, EmojiEntry>();
  const addEmoji = (emoji: string) => {
    if (out.has(emoji)) return;
    const code = firstCodePoint(emoji);
    const category = HAND_GESTURE_EMOJIS.has(emoji) ? "Hand Gestures" : categorizeEmoji(code);
    const description = describeEmoji(emoji, code, category);
    const codepoint = code ? `u+${code.toString(16)}` : "";
    out.set(emoji, {
      emoji,
      category,
      description,
      keywords: `${emoji} ${category.toLowerCase()} ${description.toLowerCase()} ${codepoint}`,
    });
  };

  COMMON_EMOJIS.forEach(addEmoji);
  const ranges: Array<[number, number, boolean]> = [
    [0x1f300, 0x1f5ff, false],
    [0x1f600, 0x1f64f, false],
    [0x1f680, 0x1f6ff, false],
    [0x1f700, 0x1f77f, false],
    [0x1f780, 0x1f7ff, false],
    [0x1f800, 0x1f8ff, false],
    [0x1f900, 0x1f9ff, false],
    [0x1fa70, 0x1faff, false],
    [0x2600, 0x26ff, true],
    [0x2700, 0x27bf, true],
  ];
  for (const [start, end, variation] of ranges) {
    for (let code = start; code <= end; code += 1) {
      addEmoji(`${String.fromCodePoint(code)}${variation ? "\ufe0f" : ""}`);
      if (out.size >= 1000) return [...out.values()].slice(0, 1000);
    }
  }
  return [...out.values()].slice(0, 1000);
}

const EMOJI_CATALOG = buildEmojiCatalog();
const EMOJI_BY_SYMBOL = new Map(EMOJI_CATALOG.map((entry) => [entry.emoji, entry]));

export function ChatComposer({
  thread,
  draft,
  onDraft,
  replyingTo,
  onCancelReply,
  pendingAttachments,
  onAttachFiles,
  onRemovePending,
  onSend,
  sending,
  disabled = false,
  disabledHint,
}: {
  thread: ChatThread;
  draft: string;
  onDraft: (value: string) => void;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  pendingAttachments: PendingAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemovePending: (index: number) => void;
  onSend: (options?: { type?: string; location?: { lat: number; lng: number; label?: string; address?: string } }) => void;
  sending: boolean;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState("");
  const [emojiUsage, setEmojiUsage] = useState<Record<string, EmojiUsage>>({});
  const hasSendableContent = draft.trim().length > 0 || pendingAttachments.length > 0;
  const sendDisabled = sending || !hasSendableContent || (thread.type === "SMS" && Boolean(draft.trim()) && isSmsTextOverLimit(draft));
  const emojiGroups: EmojiGroup[] = useMemo(() => {
    const query = emojiQuery.trim().toLowerCase();
    const filtered = query
      ? EMOJI_CATALOG.filter((entry) => entry.keywords.includes(query))
      : EMOJI_CATALOG;
    const recentEntries = Object.entries(emojiUsage)
      .map(([emoji, usage]) => ({ entry: EMOJI_BY_SYMBOL.get(emoji), usage }))
      .filter((item): item is { entry: EmojiEntry; usage: EmojiUsage } => Boolean(item.entry))
      .sort((a, b) => b.usage.count - a.usage.count || b.usage.lastUsed - a.usage.lastUsed)
      .map((item) => item.entry)
      .filter((entry) => !query || entry.keywords.includes(query))
      .slice(0, 32);
    const recentSet = new Set(recentEntries.map((entry) => entry.emoji));

    const categoryGroups = EMOJI_CATEGORY_ORDER.map((category) => ({
      category,
      entries: filtered.filter((entry) => entry.category === category && !recentSet.has(entry.emoji)),
    })).filter((group) => group.entries.length > 0);
    return recentEntries.length
      ? [{ category: "Recent", entries: recentEntries }, ...categoryGroups]
      : categoryGroups;
  }, [emojiQuery, emojiUsage]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EMOJI_RECENT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, EmojiUsage>;
      const cleaned = Object.fromEntries(
        Object.entries(parsed).filter(([emoji, usage]) => (
          EMOJI_BY_SYMBOL.has(emoji) &&
          Number.isFinite(usage?.count) &&
          Number.isFinite(usage?.lastUsed)
        ))
      );
      setEmojiUsage(cleaned);
    } catch {
      setEmojiUsage({});
    }
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    if (!attachMenuOpen && !emojiOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target)) setAttachMenuOpen(false);
      if (!emojiRef.current?.contains(target)) setEmojiOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [attachMenuOpen, emojiOpen]);

  if (disabled) {
    return (
      <footer className="cc-composer cc-composer-disabled">
        <p>{disabledHint || "You do not have permission to send messages in this conversation."}</p>
      </footer>
    );
  }

  async function startRecording() {
    // Voice notes upload through the same tenant-scoped attachment pipeline.
    if (recording || recorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
    // ⛔ Ask for voice processing explicitly. A bare `audio: true` leaves
    // automatic gain, noise suppression and echo cancellation to whatever the
    // browser/Electron shell happens to default to, which is how a laptop-mic
    // recording ends up quiet and roomy — "far away" — before the server ever
    // sees it. autoGainControl is the one that makes a voice sound close.
    // 48 kHz mono matches what the server re-encodes to; both are hints and a
    // browser that ignores them still records fine.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
    // Prefer audio/mp4 so the server-side worker converter is fed the same
    // container as the mobile recorder. webm is the cross-browser fallback.
    const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : undefined;
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      const recordedChunks = chunksRef.current.filter((chunk) => chunk.size > 0);
      chunksRef.current = [];
      if (recordedChunks.length === 0) {
        setRecording(false);
        setRecordSeconds(0);
        return;
      }
      const blob = new Blob(recordedChunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size === 0) {
        setRecording(false);
        setRecordSeconds(0);
        return;
      }
      const ext = (rec.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm";
      const file = new File([blob], `voice-note-${Date.now()}.${ext}`, { type: blob.type });
      onAttachFiles([file]);
      setRecording(false);
      setRecordSeconds(0);
    };
    recorderRef.current = rec;
    rec.start();
    setRecordSeconds(0);
    setRecording(true);
  }

  function formatRecordTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function stopRecording(send: boolean) {
    const rec = recorderRef.current;
    if (!rec) return;
    if (!send) {
      rec.onstop = () => {
        rec.stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        chunksRef.current = [];
        setRecording(false);
        setRecordSeconds(0);
      };
    }
    rec.stop();
  }

  function shareLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (thread.type === "SMS") {
        onDraft(`${draft ? `${draft}\n` : ""}Location: https://maps.google.com/?q=${encodeURIComponent(`${lat},${lng}`)}`);
      } else {
        onSend({ type: "LOCATION", location: { lat, lng, label: "Current location" } });
      }
    });
  }

  function trackEmojiUse(emoji: string) {
    setEmojiUsage((current) => {
      const next = {
        ...current,
        [emoji]: {
          count: (current[emoji]?.count ?? 0) + 1,
          lastUsed: Date.now(),
        },
      };
      const compact = Object.fromEntries(
        Object.entries(next)
          .sort((a, b) => b[1].count - a[1].count || b[1].lastUsed - a[1].lastUsed)
          .slice(0, 96)
      );
      try {
        window.localStorage.setItem(EMOJI_RECENT_STORAGE_KEY, JSON.stringify(compact));
      } catch {
        // Local storage can be unavailable in private or locked-down browser modes.
      }
      return compact;
    });
  }

  function insertEmoji(emoji: string) {
    trackEmojiUse(emoji);
    const textarea = textareaRef.current;
    if (!textarea) {
      onDraft(`${draft}${emoji}`);
      return;
    }
    const start = textarea.selectionStart ?? draft.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    onDraft(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + emoji.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  return (
    <footer className="cc-composer">
      {replyingTo ? (
        <div className="cc-composer-reply">
          <span>Replying to {replyingTo.senderName}: {replyingTo.body || replyingTo.type}</span>
          <button type="button" onClick={onCancelReply}><X size={14} /></button>
        </div>
      ) : null}

      {pendingAttachments.length ? (
        <div className="cc-pending">
          {pendingAttachments.map((file, index) => (
            <span key={`${file.storageKey}-${index}`} className="cc-pending-chip">
              {file.fileName} <small>{formatBytes(file.sizeBytes)}</small>
              <button type="button" onClick={() => onRemovePending(index)}><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}

      {recording ? (
        <div className="cc-recording">
          <span className="cc-record-dot" />
          <strong>Recording voice note</strong>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatRecordTime(recordSeconds)}</span>
          {thread.type === "SMS" ? <small>Will send as MMS audio</small> : null}
          <button type="button" onClick={() => stopRecording(false)}><Trash2 size={15} /> Cancel</button>
          <button type="button" onClick={() => stopRecording(true)}><Square size={15} /> Stop</button>
        </div>
      ) : null}

      <div className="cc-compose-row">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files || []).slice(0, 3);
            e.currentTarget.value = "";
            if (files.length) onAttachFiles(files);
          }}
        />
        <input
          ref={mediaRef}
          type="file"
          multiple
          accept={MEDIA_ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files || []).slice(0, 3);
            e.currentTarget.value = "";
            if (files.length) onAttachFiles(files);
          }}
        />
        <div className="cc-compose-bubble">
          <div className="cc-emoji-menu-wrap" ref={emojiRef}>
            <button
              type="button"
              className={`cc-compose-icon ${emojiOpen ? "active" : ""}`}
              title="Emoji"
              aria-haspopup="dialog"
              aria-expanded={emojiOpen}
              onClick={() => {
                setEmojiOpen((open) => !open);
                setAttachMenuOpen(false);
              }}
            >
              <Smile size={19} />
            </button>
            {emojiOpen ? (
              <div className="cc-emoji-menu" role="dialog" aria-label="Emoji picker">
                <div className="cc-emoji-menu-head">
                  <strong>Emoji</strong>
                  <small>{EMOJI_CATALOG.length.toLocaleString()} unique emojis</small>
                </div>
                <label className="cc-emoji-search">
                  <span>Search emojis</span>
                  <input
                    type="search"
                    value={emojiQuery}
                    onChange={(event) => setEmojiQuery(event.currentTarget.value)}
                    placeholder="Search smileys, food, travel..."
                  />
                </label>
                <div className="cc-emoji-results">
                  {emojiGroups.length ? (
                    emojiGroups.map((group) => (
                      <section key={group.category} className="cc-emoji-category" aria-label={group.category}>
                        <div className="cc-emoji-category-title">
                          <strong>{group.category}</strong>
                          <small>{group.entries.length}</small>
                        </div>
                        <div className="cc-emoji-grid">
                          {group.entries.map((entry) => (
                            <button
                              key={entry.emoji}
                              type="button"
                              className="cc-emoji-option"
                              aria-label={`Insert ${entry.category} emoji ${entry.emoji}`}
                              onClick={() => insertEmoji(entry.emoji)}
                            >
                              {entry.emoji}
                            </button>
                          ))}
                        </div>
                      </section>
                    ))
                  ) : (
                    <p className="cc-emoji-empty">No emojis found.</p>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <div className="cc-attach-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className={`cc-compose-icon cc-plus-btn ${attachMenuOpen ? "active" : ""}`}
              title="Add attachment"
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              onClick={() => {
                setAttachMenuOpen((open) => !open);
                setEmojiOpen(false);
              }}
            >
              <Plus size={20} />
            </button>
            {attachMenuOpen ? (
              <div className="cc-attach-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setAttachMenuOpen(false); mediaRef.current?.click(); }}>
                  <Images size={16} />
                  <span>
                    <strong>Photos / videos</strong>
                    <small>Images, MP4, WebM</small>
                  </span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setAttachMenuOpen(false); fileRef.current?.click(); }}>
                  <FileText size={16} />
                  <span>
                    <strong>Files</strong>
                    <small>PDF, docs, sheets, audio</small>
                  </span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setAttachMenuOpen(false); shareLocation(); }}>
                  <MapPin size={16} />
                  <span>
                    <strong>Location</strong>
                    <small>Share current location</small>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder={`Message ${thread.participantName}...`}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!sendDisabled) onSend();
              }
            }}
          />
          {hasSendableContent ? (
            <button
              type="button"
              className="cc-send-btn cc-compose-action"
              disabled={sendDisabled}
              onClick={() => onSend()}
              title="Send"
            >
              <Send size={17} />
            </button>
          ) : (
            <button type="button" className="cc-compose-action cc-mic-btn" title="Voice note" onClick={startRecording}>
              <Mic size={19} />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
