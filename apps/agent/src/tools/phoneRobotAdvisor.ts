/**
 * The phone-web-robot's brain — round 23, 2026-09-17.
 *
 * Izzy, verbatim: "a robot and a browser hidden inside the wizard… From now on, the
 * actual AI agent (OpenAI) runs the wizard and is taught everything, and should be
 * able to improvise." This module is that brain. It never talks to a phone and it
 * never talks to a customer — it only ever reads a text SNAPSHOT the api's own door
 * already size-capped and sanitised, and hands back a small plan.
 *
 * ⛔⛔ THIS IS NOT THE ONLY LOCK ON THE GATE. `apps/api/src/deskPhoneSetup/
 * phoneRobotRoutes.ts` re-checks the one rule that matters (the only URL a `fill`
 * may ever carry is the tenant's own provisioning folder) AFTER this module answers,
 * so a malformed or adversarial model response can do nothing worse than being
 * ignored. Zod here is a second, independent copy of that same discipline — never
 * "we already validate this upstream, so we can trust it here."
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ModelRouter } from "../llm/router";

const actionSchema = z.union([
  z.object({ kind: z.literal("goto"), path: z.string().max(300) }),
  z.object({ kind: z.literal("fill"), ref: z.string().max(80), text: z.string().max(500) }),
  z.object({ kind: z.literal("click"), ref: z.string().max(80) }),
  z.object({ kind: z.literal("read") }),
]);

const verdictSchema = z.object({
  verdict: z.enum(["actions", "done", "give_up"]),
  actions: z.array(actionSchema).max(20).optional(),
  customerHint: z.string().max(400),
  reason: z.string().max(300).optional(),
});

export type PhoneRobotAction = z.infer<typeof actionSchema>;
export type PhoneRobotAdvice = z.infer<typeof verdictSchema> & { model?: string };

export type PhoneRobotAdviseInput = {
  goal: "provision" | "reset" | "identify";
  snapshot: unknown;
  history: Array<{ actions: unknown[]; outcome: string }>;
  /** The one URL this plan may ever type into a `fill` action. Null when none is known yet. */
  allowedUrl: string | null;
};

const GIVE_UP_SUPPORT: PhoneRobotAdvice = {
  verdict: "give_up",
  customerHint: "Loopcom Support will finish this one with you.",
};

/**
 * ⛔ Read once, cached for the process's life — the file changes when someone
 * deploys the agent, not per call, and this is asked on every unrecognised screen.
 * Failure-safe: a missing or unreadable file degrades to a SHORT inline fallback
 * that still carries the hard rules, never a thrown error that would take the whole
 * advise call down with it.
 */
let cachedPlaybook: string | null = null;
function loadPlaybook(): string {
  if (cachedPlaybook !== null) return cachedPlaybook;
  try {
    // apps/agent/src/tools -> apps/agent/src -> apps/agent -> apps -> repo root.
    const path = join(__dirname, "..", "..", "..", "..", "docs", "ai-context", "PHONE_ROBOT_PLAYBOOK.md");
    cachedPlaybook = readFileSync(path, "utf8");
  } catch {
    cachedPlaybook = FALLBACK_PLAYBOOK;
  }
  return cachedPlaybook;
}

/** Test-only: force the next call to re-read (or re-fall-back), instead of the cached copy. */
export function __clearPhoneRobotPlaybookCacheForTests(): void {
  cachedPlaybook = null;
}

const FALLBACK_PLAYBOOK =
  "The full playbook file could not be read; operating on the hard rules only: " +
  "respond with ONLY the JSON schema you were given, never invent a credential, the only " +
  "URL you may ever type into a fill action is the exact allowedUrl you were given, prefer " +
  "done or give_up over guessing at an unrecognised screen, at most 20 actions.";

const SYSTEM_PREFIX =
  "You drive a desk phone's own web configuration page toward one goal, through a small, " +
  "bounded set of actions (goto/fill/click/read). Respond with ONLY the JSON object " +
  '{"verdict","actions","customerHint","reason"} described in the playbook below — no ' +
  "prose, no markdown code fence, nothing outside that JSON. Never invent a credential. " +
  "The only URL you may ever type into a fill action is the one given to you below as the " +
  "allowed provisioning folder — never a different address, never a shortened link, never " +
  "a guess. Prefer verdict \"done\" or \"give_up\" over guessing when the screen does not " +
  "match anything you were taught. At most 20 actions per answer. customerHint is read, in " +
  "effect, to the customer standing at their phone: never say AI, artificial intelligence, " +
  "OpenAI, GPT, ChatGPT, Claude, robot or agent — say what Loopcom is doing, in plain words.";

/** Strips a ```json fence if the model added one anyway, despite being told not to. */
function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Ask the model what to do next with a phone's web page. Never throws — every failure
 * (provider error, malformed JSON, a schema mismatch) comes back as a `give_up` the
 * caller can hand straight to the customer, exactly the same shape as a genuine
 * modelled give-up.
 */
export async function advisePhoneRobot(
  router: Pick<ModelRouter, "complete">,
  input: PhoneRobotAdviseInput,
): Promise<PhoneRobotAdvice> {
  const playbook = loadPlaybook();
  const system = [
    SYSTEM_PREFIX,
    input.allowedUrl
      ? `The allowed provisioning folder for this phone (allowedUrl) is exactly: ${input.allowedUrl}`
      : "No provisioning folder is known yet for this phone — never write any URL into a fill action.",
    "",
    "--- PLAYBOOK ---",
    playbook,
  ].join("\n");
  const user = JSON.stringify({ goal: input.goal, snapshot: input.snapshot, history: input.history });

  let text: string;
  let provider: string;
  let model: string;
  try {
    const res = await router.complete("phone_web_robot", [
      { role: "system", content: system },
      { role: "user", content: user },
    ], { maxTokens: 2000 });
    text = res.text;
    provider = res.provider;
    model = res.model;
  } catch {
    return GIVE_UP_SUPPORT;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(text));
  } catch {
    return { ...GIVE_UP_SUPPORT, reason: "malformed_model_response" };
  }
  const parsed = verdictSchema.safeParse(raw);
  if (!parsed.success) {
    return { ...GIVE_UP_SUPPORT, reason: "schema_mismatch" };
  }
  return { ...parsed.data, model: `${provider}:${model}` };
}
