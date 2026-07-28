/**
 * LLM-first hold-music request understanding (owner directive 2026-07-27:
 * "maybe we should make the agent a little smarter").
 *
 * The frontier model READS the request; deterministic code DECIDES and ACTS.
 * The model receives the client's words plus verified context (their tenant's
 * real profile names, their extension, the current local time) and returns
 * STRUCTURED JSON only. Everything it returns is re-validated here against
 * that same context — an answer naming an unknown profile, a past time, or a
 * malformed shape is discarded and the caller falls back to the deterministic
 * regex parser. The model never executes anything; its output only fills in
 * the same params that then flow through policy gates, approval, snapshots,
 * PBX verification, and the revert scheduler.
 *
 * Live failures this replaces (each was a regex patch before):
 *   - "until eight o'clock"        → parsed as no timing at all
 *   - "till 8 o'clock" at 7:52 PM  → became 8 AM tomorrow
 *   - "into main … back to classic" → set Classic (the revert target) as the goal
 */
import { zonedTimeToUtc, nowInZone, type MohTiming } from "./mohTiming";

export interface MohLlmResult {
  operation: "set" | "restore" | "status";
  /** Canonical profile name from the tenant's own list (null = not stated). */
  profileName: string | null;
  scope: "tenant" | "extension" | null;
  /** Explicitly-mentioned extension number (never inferred by the model). */
  extension: string | null;
  timing: MohTiming;
}

/** Minimal surface of ModelRouter the extractor needs (test-fakeable). */
export interface ExtractorLlm {
  available(): unknown[];
  complete(
    task: "task_extraction",
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    opts?: { maxTokens?: number; conversationId?: string },
  ): Promise<{ text: string }>;
}

export interface ExtractInput {
  text: string;
  profiles: string[];
  ownExt: string | null;
  isAdmin: boolean;
  tz: string;
  now?: Date;
  conversationId?: string;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtLocal(tz: string, d: Date, withDate: boolean): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    ...(withDate ? { month: "numeric", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function buildPrompt(input: ExtractInput, now: Date): string {
  const z = nowInZone(input.tz, now);
  const nowStr = `${WEEKDAY_NAMES[z.dow]} ${z.y}-${String(z.mo).padStart(2, "0")}-${String(z.d).padStart(2, "0")} ${String(z.hh).padStart(2, "0")}:${String(z.mm).padStart(2, "0")}`;
  return [
    `You extract a structured hold-music request from a phone-system client's message.`,
    `CURRENT LOCAL TIME: ${nowStr} (timezone ${input.tz}). All times in your output are LOCAL wall-clock times in this timezone.`,
    `THE CLIENT'S AVAILABLE HOLD-MUSIC PROFILES (the ONLY valid profile names): ${input.profiles.map((p) => `"${p}"`).join(", ") || "(none)"}`,
    `THE CLIENT'S OWN EXTENSION: ${input.ownExt ?? "(none)"} — their role: ${input.isAdmin ? "company admin" : "regular user"}.`,
    ``,
    `Reply with ONE minified JSON object and NOTHING else. Schema:`,
    `{"is_hold_music":boolean,` +
      `"operation":"set"|"restore"|"status",` +
      `"profile":string|null,` +
      `"scope":"tenant"|"extension"|null,` +
      `"extension":string|null,` +
      `"timing":{"kind":"none"}|{"kind":"duration","minutes":number}|{"kind":"until","end":"YYYY-MM-DD HH:MM"}|{"kind":"window","start":"YYYY-MM-DD HH:MM","end":"YYYY-MM-DD HH:MM"}|{"kind":"weekly","weekday":0-6,"startTime":"HH:MM","endTime":"HH:MM"},` +
      `"confidence":number}`,
    ``,
    `Rules:`,
    `- is_hold_music=false when the message is not a hold-music request/question at all.`,
    `- operation: "set" = change the music to a profile; "restore" = back to the regular schedule/default/previous music; "status" = asking what is playing now.`,
    `- profile: the profile the music should CHANGE TO, copied EXACTLY from the list above (match case-insensitively, output the exact listed spelling). null when not stated.`,
    `- CRITICAL: a profile named after "back to"/"return to"/"revert to"/"then back" describes what happens AFTER a timer ends — it is NEVER the "profile" value. In "switch to Main till 8:45 then back to Classic", profile="Main" and the Classic part is the automatic revert (already handled by the system; do not encode it).`,
    `- scope: "tenant" only when the whole company/office/everyone is explicit; "extension" when it's about their own phone/extension or a named extension; null when the message doesn't say.`,
    `- extension: an extension NUMBER only when explicitly mentioned (e.g. "extension 102"); never guess, never copy times or durations here.`,
    `- timing "until": a time with NO am/pm means the EARLIEST FUTURE moment the clock shows that time. Worked examples at 19:52: "until 8" or "until eight o'clock" = today 20:00; "until 9:45" = today 21:45 (NOT tomorrow 09:45); "until 7" = tomorrow 07:00 (19:00 already passed). Spelled-out numbers count ("eight" = 8). Only pick a morning reading when the client says so ("9:45 am", "in the morning") or names a day ("tomorrow at 9:45").`,
    `- timing "duration": "for 20 minutes", "for two hours".`,
    `- timing "window": a future one-time range ("tomorrow 3pm to 5pm"). "weekly": a recurring rule ("every Friday 3-5pm").`,
    `- "change it back in 15 minutes" (no new profile) = operation "restore" with a 15-minute duration.`,
    `- confidence: 0..1, your certainty in the WHOLE extraction. Below 0.6 means unsure.`,
  ].join("\n");
}

/** Parse "YYYY-MM-DD HH:MM" (T or space) as a wall-clock instant in tz. */
function parseLocal(s: unknown, tz: string): Date | null {
  const m = String(s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  return zonedTimeToUtc(tz, y, mo, d, hh, mm);
}

function timingLabel(tz: string, now: Date, t: MohTiming): MohTiming {
  if (t.kind === "duration") {
    const label = t.minutes % 60 === 0 ? `${t.minutes / 60} hour${t.minutes === 60 ? "" : "s"}` : `${t.minutes} minute${t.minutes === 1 ? "" : "s"}`;
    return { ...t, label };
  }
  if (t.kind === "until") {
    const sameDay = fmtLocal(tz, t.endAt, true).split(",")[0] === fmtLocal(tz, now, true).split(",")[0];
    return { ...t, label: `until ${fmtLocal(tz, t.endAt, !sameDay)}` };
  }
  if (t.kind === "window") return { ...t, label: `from ${fmtLocal(tz, t.startAt, true)} to ${fmtLocal(tz, t.endAt, true)}` };
  if (t.kind === "weekly") return { ...t, label: `every ${WEEKDAY_NAMES[t.weekday]} from ${t.startTime} to ${t.endTime}` };
  return t;
}

/** Validate the model's raw JSON against the verified context. Null = unusable. */
export function validateMohExtraction(rawText: string, input: ExtractInput, now: Date): MohLlmResult | null {
  let j: any;
  try {
    j = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  if (j.is_hold_music !== true) return null;
  if (typeof j.confidence !== "number" || j.confidence < 0.6) return null;
  const operation = j.operation;
  if (operation !== "set" && operation !== "restore" && operation !== "status") return null;

  let profileName: string | null = null;
  if (j.profile != null) {
    const want = String(j.profile).trim().toLowerCase();
    profileName = input.profiles.find((p) => p.toLowerCase() === want) ?? null;
    // The model named a profile that doesn't exist for this tenant — the whole
    // extraction is suspect (hallucination guard): fall back to deterministic.
    if (!profileName) return null;
  }

  const scope = j.scope === "tenant" || j.scope === "extension" ? j.scope : null;
  let extension: string | null = null;
  if (j.extension != null) {
    const e = String(j.extension).trim();
    if (!/^\d{2,5}$/.test(e)) return null;
    extension = e;
  }

  const tRaw = j.timing;
  let timing: MohTiming = { kind: "none" };
  if (tRaw && typeof tRaw === "object" && tRaw.kind !== "none") {
    if (tRaw.kind === "duration") {
      const minutes = Math.round(Number(tRaw.minutes));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 14 * 24 * 60) return null;
      timing = { kind: "duration", minutes, label: "" };
    } else if (tRaw.kind === "until") {
      const endAt = parseLocal(tRaw.end, input.tz);
      if (!endAt || endAt.getTime() <= now.getTime() || endAt.getTime() > now.getTime() + 366 * 86400_000) return null;
      timing = { kind: "until", endAt, label: "" };
    } else if (tRaw.kind === "window") {
      const startAt = parseLocal(tRaw.start, input.tz);
      const endAt = parseLocal(tRaw.end, input.tz);
      if (!startAt || !endAt || endAt.getTime() <= startAt.getTime() || endAt.getTime() <= now.getTime()) return null;
      timing = { kind: "window", startAt, endAt, label: "" };
    } else if (tRaw.kind === "weekly") {
      const weekday = Number(tRaw.weekday);
      const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
      if (!hhmm.test(String(tRaw.startTime)) || !hhmm.test(String(tRaw.endTime))) return null;
      if (String(tRaw.endTime) <= String(tRaw.startTime)) return null;
      timing = { kind: "weekly", weekday, startTime: String(tRaw.startTime), endTime: String(tRaw.endTime), label: "" };
    } else {
      return null;
    }
  }

  return { operation, profileName, scope, extension, timing: timingLabel(input.tz, now, timing) };
}

/**
 * Ask the model to read the request. Returns null (→ caller uses the
 * deterministic parser) when no provider is configured, the call fails, or
 * the answer doesn't survive validation. Never throws.
 */
export async function extractMohRequest(llm: ExtractorLlm | null, input: ExtractInput): Promise<MohLlmResult | null> {
  if (!llm || llm.available().length === 0) return null;
  const now = input.now ?? new Date();
  try {
    const res = await llm.complete(
      "task_extraction",
      [
        { role: "system", content: buildPrompt(input, now) },
        { role: "user", content: input.text },
      ],
      { maxTokens: 400, conversationId: input.conversationId },
    );
    return validateMohExtraction(res.text ?? "", input, now);
  } catch {
    return null;
  }
}
