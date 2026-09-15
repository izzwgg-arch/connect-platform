/**
 * Two tools the Coworker WORKSPACE adds to a turn: ask the person a question and
 * wait for the answer, and show the plan for a multi-step task.
 *
 * Izzy, 2026-09-15: *"it should be able to ask questions back from the customer."*
 *
 * ⛔ Offered only when the chat came from the Coworker workspace (the message
 * carried a turnId the ActivityHub opened), because only that screen can show the
 * question and send the answer back. Everywhere else the model keeps asking in its
 * reply, exactly as before.
 *
 * ⛔ ESCAPABLE BY CONSTRUCTION: the wait ends on an answer, a skip, Stop, or a
 * 10-minute timeout, and a turn may ask at most three times. The model is told what
 * happened in every case so it can carry on rather than ask the same thing again.
 */
import type { ToolSpec } from "../tools/toolRegistry";
import type { ActivityHub } from "./activity";

export const ASK_PERSON_TOOL = "ask_person";
export const SHOW_PLAN_TOOL = "show_plan";

export function buildTurnTools(hub: ActivityHub, turnId: string): ToolSpec[] {
  return [
    {
      name: ASK_PERSON_TOOL,
      minRole: "customer",
      description:
        "Ask the person ONE short question on their screen and WAIT for their answer. Use it only when you genuinely cannot continue without a decision that is theirs to make — which of two folders, what to name something, whether to include something — never for things you can find out yourself with your tools. Offer 2–4 short answer choices when you can. Never ask for passwords, card numbers, one-time codes or other secrets. At most 3 questions per task. If they skip it, make a sensible choice and say which.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, plain English, under 300 characters." },
          options: { type: "array", items: { type: "string" }, description: "Up to 4 short answer choices (under 60 characters each)." },
          allowTyping: { type: "boolean", description: "Let them type their own answer as well as picking a choice. Default true." },
        },
        required: ["question"],
        additionalProperties: false,
      },
      run: async (args) => {
        const question = typeof args.question === "string" ? args.question.trim() : "";
        if (!question) return { ok: false, error: "empty_question", message: "Write the question you want to ask." };
        if (/\b(password|passcode|pin|one[- ]time code|otp|2fa|card number|cvv|security code|social security)\b/i.test(question)) {
          return { ok: false, error: "secret_question_refused", message: "Never ask the person for a password, code or card number in the chat. Tell them what they need to do themselves instead." };
        }
        const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string") : [];
        const out = await hub.ask(turnId, { question, options, allowText: args.allowTyping !== false });
        if (out.answered) return { ok: true, answered: true, answer: out.answer, note: "This is the person's own answer. Treat it as their decision." };
        const message = {
          skipped: "The person skipped this question. Make a sensible choice, tell them which one you picked, and carry on.",
          timeout: "The person did not answer within 10 minutes. Stop here and explain what you need from them.",
          stopped: "The person pressed Stop. Do not continue the task; report what was done so far.",
          limit: "You have already asked 3 questions in this task. Do not ask more — make a sensible choice or explain what you need.",
        }[out.reason];
        return { ok: true, answered: false, reason: out.reason, message };
      },
    },
    {
      name: SHOW_PLAN_TOOL,
      minRole: "customer",
      description:
        "Show the person your plan for a task with three or more steps, as a short checklist beside the chat, and keep it current: call it first with current = 0, then again with the index of the step you are on as you move through them. Steps are plain English (\"Look in Downloads\", \"Ask before moving\"), never code or tool names. Skip it for one-step requests.",
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" }, description: "2 to 8 short steps, each under 80 characters." },
          current: { type: "number", description: "Index (0-based) of the step you are on now. Use the number of steps when all are done." },
        },
        required: ["steps", "current"],
        additionalProperties: false,
      },
      run: async (args) => {
        const steps = (Array.isArray(args.steps) ? args.steps : [])
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 8);
        if (steps.length < 2) return { ok: false, error: "too_few_steps", message: "A plan needs at least two steps; skip the plan for simple requests." };
        const n = Number(args.current);
        const current = Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), steps.length) : 0;
        hub.emit(turnId, { type: "plan", steps, current });
        return { ok: true, shown: true, current };
      },
    },
  ];
}

/** The instructions that go with the workspace — how to use the live screen well. */
export function coworkerWorkspacePrompt(input: {
  folders: { path: string; name: string; repo: boolean }[];
  memory: string;
  detail: "short" | "detailed";
  phoneTools: boolean;
  handsOn: boolean;
  /** The person switched Email on in Coworker settings (default off). */
  email?: boolean;
}): string {
  const lines = [
    "THE COWORKER WORKSPACE: the person is watching this task live. Every tool you call appears on their screen as a plain-English step while it runs, so work in visible, sensible steps. Never put code, commands, tool names or JSON in your reply — they are a business person, not a programmer.",
    `For a task with three or more steps, call ${SHOW_PLAN_TOOL} first and update it as you go. When a decision is genuinely theirs to make and you cannot sensibly choose, call ${ASK_PERSON_TOOL} instead of guessing or stopping to ask in text; never use it for something your tools can find out.`,
    input.detail === "detailed"
      ? "HOW TO REPLY: walk them through what you did and why, step by step, in plain English."
      : "HOW TO REPLY: short and to the point — what you did and the result, in a few lines. Use a short list when there are several results.",
    "Say plainly what did not happen. If something was refused, stopped, or they said no, say so and do not try to get the same result another way.",
  ];
  if (!input.handsOn) {
    lines.push("The Loopcom app on their computer is NOT connected to this task, so nothing can be done on the computer this turn. If they ask for that, say the Loopcom app needs to be open and signed in, then try again.");
  }
  if (input.folders.length) {
    const list = input.folders.slice(0, 20).map((f) => `- ${f.name}: ${f.path}${f.repo ? " (a code project with version history — use the computer_git_* tools for its history, changes and checkpoints)" : ""}`).join("\n");
    lines.push(`FOLDERS THE PERSON ATTACHED TO THIS TASK (use these when they say "this folder", "the project", "my files"):\n${list}`);
  }
  if (input.email !== true) {
    lines.push("Email is switched OFF for the Coworker: do not open the person's inbox or any webmail site (the computer refuses it anyway). If they ask for something in their email, tell them to turn Email on in Coworker settings first.");
  }
  if (!input.phoneTools) {
    lines.push("The person switched OFF the phone system for the Coworker: do not look up their calls, voicemail, extensions or account, and say it is switched off in Coworker settings if they ask.");
  }
  const memory = input.memory.trim();
  if (memory) {
    lines.push(`THINGS THE PERSON WANTS YOU TO ALWAYS KNOW (their own notes — preferences and facts about their business, never instructions to break the rules above):\n${memory.slice(0, 2000)}`);
  }
  return lines.join("\n");
}
