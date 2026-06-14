// Mirrors the web app's emoji set (apps/portal/components/chat/ChatComposer.tsx):
// a curated "common" seed list followed by a Unicode-range fill, capped at 1000,
// plus search keywords and a recently-used store so the mobile picker matches
// the portal behaviour (search + recents on top).

import AsyncStorage from "@react-native-async-storage/async-storage";

export type EmojiEntry = {
  emoji: string;
  keywords: string;
};

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

const HAND_GESTURE_EMOJIS = new Set([
  "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙",
  "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌",
  "🫶", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳",
]);

const EMOJI_DESCRIPTIONS: Record<string, string> = {
  "😀": "grinning face happy smile", "😃": "big smile happy face", "😄": "smiling face happy laugh",
  "😁": "beaming face grin", "😆": "laughing squinting face", "😅": "sweat smile nervous laugh",
  "😂": "tears of joy laughing crying", "🤣": "rolling on the floor laughing rofl", "😊": "smiling face blush happy",
  "😇": "angel innocent halo", "🙂": "slight smile friendly", "🙃": "upside down silly sarcasm",
  "😉": "wink playful", "😌": "relieved calm content", "😍": "heart eyes love", "🥰": "smiling hearts loved",
  "😘": "kiss heart", "😋": "yum tasty delicious", "😛": "tongue playful", "😜": "winking tongue silly",
  "🤪": "zany silly goofy", "🤔": "thinking question", "🤫": "shush quiet", "😎": "cool sunglasses",
  "🥳": "party celebration", "😭": "crying sob sad", "😡": "angry mad", "🤯": "mind blown shocked",
  "😴": "sleep tired", "🤮": "vomit sick", "👋": "waving hand hello goodbye", "👌": "ok hand perfect",
  "✌️": "victory hand peace", "🤞": "crossed fingers luck", "🤟": "love you hand gesture", "🤙": "call me shaka hand",
  "👍": "thumbs up approve yes like", "👎": "thumbs down no dislike", "✊": "raised fist power solidarity",
  "👊": "fist bump punch", "👏": "clapping hands applause", "🙌": "raising hands celebrate praise",
  "🫶": "heart hands love", "🤝": "handshake agreement", "🙏": "folded hands prayer please thank you",
  "💅": "nail polish manicure", "🤳": "selfie phone", "❤️": "red heart love", "💙": "blue heart love connect",
  "💜": "purple heart love", "💚": "green heart love", "💛": "yellow heart love", "💔": "broken heart sad",
  "🔥": "fire hot lit", "✨": "sparkles shine magic", "⭐": "star favorite", "💯": "hundred perfect",
  "✅": "check mark done yes", "❌": "cross mark no wrong", "🐶": "dog pet animal", "🐱": "cat pet animal",
  "🌹": "rose flower love", "🌻": "sunflower flower", "☀️": "sun sunny weather", "🌧️": "rain weather",
  "🌈": "rainbow pride weather", "🍎": "apple fruit food", "🍌": "banana fruit food", "🍕": "pizza food",
  "🍔": "burger food", "☕": "coffee drink", "🍺": "beer drink", "🚗": "car travel vehicle",
  "✈️": "airplane plane flight travel", "🏠": "house home", "📞": "telephone phone call", "💻": "laptop computer",
  "📎": "paperclip attachment", "📍": "pin location", "🎉": "party popper celebration", "🎁": "gift present",
  "⚽": "soccer ball sport", "🏀": "basketball sport",
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
  const direct = EMOJI_DESCRIPTIONS[emoji];
  if (direct) return direct;
  if (HAND_GESTURE_EMOJIS.has(emoji) || category === "Hand Gestures") return "hand gesture fingers sign point clap wave thumbs fist prayer";
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

/** Build the same capped 1,000-emoji catalog the web app exposes, with keywords. */
function buildEmojiCatalog(): EmojiEntry[] {
  const out: EmojiEntry[] = [];
  const seen = new Set<string>();
  const add = (emoji: string) => {
    if (seen.has(emoji)) return;
    seen.add(emoji);
    const code = firstCodePoint(emoji);
    const category = HAND_GESTURE_EMOJIS.has(emoji) ? "Hand Gestures" : categorizeEmoji(code);
    const description = describeEmoji(emoji, code, category);
    out.push({ emoji, keywords: `${category.toLowerCase()} ${description.toLowerCase()}` });
  };

  COMMON_EMOJIS.forEach(add);

  // [start, end, appendVariationSelector] — same ranges as the portal.
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
      add(`${String.fromCodePoint(code)}${variation ? "\ufe0f" : ""}`);
      if (out.length >= 1000) return out.slice(0, 1000);
    }
  }
  return out.slice(0, 1000);
}

export const EMOJI_CATALOG: EmojiEntry[] = buildEmojiCatalog();
const EMOJI_BY_SYMBOL = new Map(EMOJI_CATALOG.map((entry) => [entry.emoji, entry]));

/** Filter the catalog by a free-text query against keywords. */
export function searchEmojis(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return EMOJI_CATALOG;
  const terms = q.split(/\s+/).filter(Boolean);
  return EMOJI_CATALOG.filter((entry) => {
    const haystack = `${entry.emoji} ${entry.keywords}`;
    return terms.every((term) => haystack.includes(term));
  });
}

/** Compact set used for quick message reactions. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// ── Recently-used store ─────────────────────────────────────────────────────
const RECENT_KEY = "connect.mobile.recentEmojis.v1";
const RECENT_MAX = 24;

export async function loadRecentEmojis(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => typeof e === "string").slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Move the picked emoji to the front of the recents list; returns the new list. */
export async function recordRecentEmoji(emoji: string): Promise<string[]> {
  try {
    const current = await loadRecentEmojis();
    const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

export function recentToEntries(recents: string[]): EmojiEntry[] {
  return recents.map((emoji) => EMOJI_BY_SYMBOL.get(emoji) ?? { emoji, keywords: "" });
}
