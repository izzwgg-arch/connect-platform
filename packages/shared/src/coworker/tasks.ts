/**
 * The Coworker's HANDS, v1 — the fixed list of things the desktop app may do on a
 * customer's computer when the assistant asks and the person approves.
 *
 * ⛔⛔ THIS IS AN ALLOWLIST, NOT A LANGUAGE. There is no "run this", no path
 * parameter, no command. A task is one of the kinds below with a handful of
 * enumerated arguments; anything else is refused before its arguments are even
 * read. The agent proposes a task, the person sees the four questions from the
 * approved mockup (what / where / why / can it be undone), the DESKTOP re-validates
 * it against this same list and runs exactly that. A compromised server can only
 * ever ask for one of these.
 *
 * ⛔ Pure. Every runtime (the agent proposing, the api recording, the portal
 * rendering) imports this so they cannot disagree about what a task is. The desktop
 * app cannot import this package (it bundles nothing from the monorepo), so it
 * carries its own copy of the KIND and FOLDER lists — `apps/desktop/src/coworker/
 * tasks.ts` — and a test there reads THIS file to prove the two lists are identical.
 *
 * ⛔ Every spec declares its risk and domains, and `decideToolCall()` in policy.ts
 * judges them like any other tool: a SAFE profile ALLOWS reads and ASKS before a
 * write. Nothing here can ever reach NEVER_AUTO_DOMAINS.
 */

import type { CoworkerToolSpec, RiskLevel } from "./types";
import { approvalSubject } from "./policy";

/** Every task kind that exists. Adding one is a deliberate act with its own test. */
export const COWORKER_TASK_KINDS = ["folder_summary", "organize_folder", "system_snapshot"] as const;
export type CoworkerTaskKind = (typeof COWORKER_TASK_KINDS)[number];

/**
 * The only folders a task may touch: the person's own Downloads, Desktop and
 * Documents. By NAME, never by path — a path is a parameter, and this list is not
 * a parameter. The desktop resolves the name to the real folder itself.
 */
export const COWORKER_FOLDERS = ["downloads", "desktop", "documents"] as const;
export type CoworkerFolder = (typeof COWORKER_FOLDERS)[number];

export const COWORKER_FOLDER_LABELS: Record<CoworkerFolder, string> = {
  downloads: "Downloads",
  desktop: "Desktop",
  documents: "Documents",
};

/** The AgentAction capability id every coworker task is filed under. */
export const COWORKER_TASK_CAPABILITY_ID = "coworker.task.v1";

/** A proposed task that nobody approved within this window is dead. */
export const COWORKER_TASK_TTL_MS = 30 * 60 * 1000;

/** A reason longer than this is not a reason, it is a prompt. */
export const MAX_REASON_CHARS = 200;

export type CoworkerTask =
  | { kind: "folder_summary"; folder: CoworkerFolder; reason: string }
  | { kind: "organize_folder"; folder: CoworkerFolder; reason: string }
  | { kind: "system_snapshot"; reason: string };

/**
 * The policy spec for each kind. ⛔ `destructive: false` on ALL of them is a fact,
 * not a preference: organize_folder MOVES files into subfolders of the same folder
 * and never deletes, overwrites or leaves the folder. The day a destructive kind is
 * added it gets its own spec with `destructive: true`, and policy asks for it on
 * every profile.
 */
export const COWORKER_TASK_SPECS: Record<CoworkerTaskKind, CoworkerToolSpec> = {
  folder_summary: {
    name: "coworker.folder_summary",
    description: "Count and size the files in one of the person's own folders, by type.",
    category: "FILESYSTEM",
    risk: "READ_ONLY",
    domains: ["files.read"],
    destructive: false,
    networked: false,
    exfiltrationCapable: false,
    timeoutMs: 30_000,
    maxRetries: 0,
  },
  organize_folder: {
    name: "coworker.organize_folder",
    description: "Move the loose files in one of the person's own folders into subfolders by type (Images, Documents, Installers, …). Moves only — never deletes or overwrites.",
    category: "FILESYSTEM",
    risk: "LOW",
    domains: ["files.read", "files.write"],
    destructive: false,
    networked: false,
    exfiltrationCapable: false,
    timeoutMs: 120_000,
    maxRetries: 0,
  },
  system_snapshot: {
    name: "coworker.system_snapshot",
    description: "Read basic facts about this computer: Windows version, uptime, free disk space, memory.",
    category: "DIAGNOSTIC",
    risk: "READ_ONLY",
    domains: ["diagnostics"],
    destructive: false,
    networked: false,
    exfiltrationCapable: false,
    timeoutMs: 15_000,
    maxRetries: 0,
  },
};

/** Control characters and bidi overrides have no place in a reason shown on screen. */
export function cleanReason(input: unknown): string {
  return cleanText(input, MAX_REASON_CHARS);
}

/** Strip control + bidi characters, collapse whitespace, cap the length. */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const stripped = Array.from(input.slice(0, max * 4))
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || c === 0x7f) return false;
      if (c >= 0x200b && c <= 0x200f) return false; // zero-width + bidi marks
      if (c >= 0x202a && c <= 0x202e) return false; // bidi embeddings/overrides
      if (c >= 0x2066 && c <= 0x2069) return false; // bidi isolates
      return true;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, max);
}

export type ParsedTask = { ok: true; task: CoworkerTask } | { ok: false; refused: string };

/**
 * Strict parse of a model-supplied (or renderer-supplied) request.
 *
 * ⛔ The kind is checked before anything else is looked at; unknown keys are a
 * refusal, not ignored — an extra `path` or `command` key is exactly the shape an
 * injection would try, and silently dropping it hides the attempt.
 */
export function parseCoworkerTask(raw: unknown): ParsedTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, refused: "not_an_object" };
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== "string" || !(COWORKER_TASK_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, refused: "unknown_task_kind" };
  }
  const allowedKeys = new Set(kind === "system_snapshot" ? ["kind", "reason"] : ["kind", "folder", "reason"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return { ok: false, refused: `unexpected_field:${k.slice(0, 32)}` };
  }
  const reason = cleanReason(r.reason);
  if (kind === "system_snapshot") return { ok: true, task: { kind, reason } };
  const folder = r.folder;
  if (typeof folder !== "string" || !(COWORKER_FOLDERS as readonly string[]).includes(folder)) {
    return { ok: false, refused: "unknown_folder" };
  }
  return { ok: true, task: { kind: kind as "folder_summary" | "organize_folder", folder: folder as CoworkerFolder, reason } };
}

export function specForTask(task: CoworkerTask): CoworkerToolSpec {
  return COWORKER_TASK_SPECS[task.kind];
}

/**
 * The four questions from the approved mockup: what, where, why, can it be undone.
 * ⛔ Written for a non-technical person. `where` names a folder, never a path — the
 * desktop knows the path, the card does not need it.
 */
export type CoworkerTaskCard = {
  title: string;
  what: string;
  where: string;
  why: string;
  reversible: string;
  risk: RiskLevel;
  /** True when the task changes nothing (a read), so the card can say so. */
  readOnly: boolean;
  /** The button label. */
  action: string;
};

export function describeCoworkerTask(task: CoworkerTask): CoworkerTaskCard {
  const why = task.reason || "You asked for this in the chat.";
  switch (task.kind) {
    case "folder_summary": {
      const f = COWORKER_FOLDER_LABELS[task.folder];
      return {
        title: `Look through your ${f} folder?`,
        what: `Count the files in ${f} by type and size. Nothing is opened, moved or changed.`,
        where: `Your ${f} folder`,
        why,
        reversible: "Nothing changes, so there is nothing to undo.",
        risk: "READ_ONLY",
        readOnly: true,
        action: "Go ahead",
      };
    }
    case "organize_folder": {
      const f = COWORKER_FOLDER_LABELS[task.folder];
      return {
        title: `Organize your ${f} folder?`,
        what: `Move the loose files in ${f} into subfolders by type — Images, Documents, Spreadsheets, PDFs, Installers, Archives, Videos, Audio, Other. Files that are open or in use are left alone. Nothing is deleted and nothing is overwritten.`,
        where: `Your ${f} folder (subfolders inside it)`,
        why,
        reversible: "Yes — every file is only moved one level down, and the list of moves is kept so it can be put back.",
        risk: "LOW",
        readOnly: false,
        action: "Organize it",
      };
    }
    case "system_snapshot":
      return {
        title: "Check this computer's basics?",
        what: "Read the Windows version, how long it has been running, free disk space and memory. Nothing is changed.",
        where: "This computer",
        why,
        reversible: "Nothing changes, so there is nothing to undo.",
        risk: "READ_ONLY",
        readOnly: true,
        action: "Go ahead",
      };
  }
}

/** The string an approval is bound to (hashed by the caller with node:crypto). */
export function coworkerTaskApprovalSubject(taskId: string, task: CoworkerTask): string {
  return approvalSubject(taskId, COWORKER_TASK_SPECS[task.kind].name, task);
}

/** Has a proposal outlived its approval window? */
export function coworkerTaskExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > COWORKER_TASK_TTL_MS;
}

/**
 * The result the desktop reports back, bounded so a task can never write an
 * unbounded blob into the database. Details are a short list of plain sentences.
 */
export type CoworkerTaskResult = {
  ok: boolean;
  /** One sentence for the chat and the audit row. */
  summary: string;
  /** Up to 20 short lines the card can show ("Moved 12 files to Images"). */
  details?: string[];
  /** Machine-readable refusal/failure code when ok is false. */
  code?: string;
};

export const MAX_RESULT_SUMMARY_CHARS = 400;
export const MAX_RESULT_DETAILS = 20;
export const MAX_RESULT_DETAIL_CHARS = 200;

export function boundTaskResult(raw: unknown): CoworkerTaskResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== "boolean" || typeof r.summary !== "string") return null;
  const details = Array.isArray(r.details)
    ? r.details.filter((d): d is string => typeof d === "string").slice(0, MAX_RESULT_DETAILS).map((d) => cleanReasonLike(d, MAX_RESULT_DETAIL_CHARS))
    : undefined;
  const code = typeof r.code === "string" ? r.code.replace(/[^a-z0-9_:-]/gi, "").slice(0, 64) : undefined;
  return {
    ok: r.ok,
    summary: cleanReasonLike(r.summary, MAX_RESULT_SUMMARY_CHARS),
    ...(details && details.length ? { details } : {}),
    ...(code ? { code } : {}),
  };
}

function cleanReasonLike(s: string, max: number): string {
  return cleanText(s, max);
}
