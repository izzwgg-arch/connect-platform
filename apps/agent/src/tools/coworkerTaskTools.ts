/**
 * "Organize my Downloads" — the PROPOSE half of the Coworker's hands.
 *
 * ⛔ THIS FILE RUNS NOTHING ON ANYBODY'S COMPUTER. It writes a DRAFT AgentAction
 * describing exactly one allowlisted task (packages/shared coworker/tasks.ts) and
 * hands back a plain-English summary. The person then sees the four-question card
 * in the Coworker popover (what / where / why / can it be undone), the api records
 * their approval, and the DESKTOP app — which re-validates the task against its own
 * copy of the allowlist — is the only thing that touches a file.
 *
 * The split is the same one the permission grants use (permissionGrant.ts): a
 * model's output must never be the thing that authorises an action, so the model
 * can only ever ASK, in a shape the policy engine already judged.
 *
 * ⛔ ONLY FROM INSIDE THE BUBBLE. The tool refuses unless the conversation is coming
 * from the desktop Coworker window (`viewingPath` = /desktop/coworker). A proposal
 * made from a browser tab would sit forever: nothing there can run it, and telling
 * someone "I've put it on your screen" when nothing appeared is the unearned-fix
 * class this platform's support gate exists to stop.
 */
import { createHash } from "node:crypto";
import type { ToolSpec, ToolContext } from "./toolRegistry";
import {
  COWORKER_TASK_CAPABILITY_ID, COWORKER_TASK_KINDS, COWORKER_FOLDERS,
  parseCoworkerTask, describeCoworkerTask, specForTask, coworkerTaskApprovalSubject,
  coworkerTaskExpired,
} from "@connect/shared/coworker";
import { decideToolCall, DEFAULT_PERMISSIONS } from "@connect/shared/coworker";

export const COWORKER_CHAT_PATH = "/desktop/coworker";

export function isInsideCoworkerWindow(ctx: ToolContext): boolean {
  return typeof ctx.viewingPath === "string" && ctx.viewingPath.startsWith(COWORKER_CHAT_PATH);
}

export interface CoworkerTaskToolDeps {
  prisma: any;
  now?: () => number;
}

export function buildCoworkerTaskTools(deps: CoworkerTaskToolDeps): ToolSpec[] {
  const now = deps.now ?? (() => Date.now());
  return [
    {
      name: "coworker_task",
      description:
        "Ask the Loopcom Coworker on the person's Windows computer to do ONE task from a fixed list, after they approve it on screen. " +
        `Kinds: ${COWORKER_TASK_KINDS.join(", ")}. Folders: ${COWORKER_FOLDERS.join(", ")} (their own Downloads, Desktop or Documents only). ` +
        "folder_summary counts files by type (changes nothing). organize_folder moves loose files into subfolders by type — moves only, never deletes. " +
        "system_snapshot reads Windows version, uptime, free disk and memory. " +
        "Only works when the person is chatting through the Coworker bubble on their computer; otherwise it refuses and you must say so. " +
        "Nothing runs until they press the button on the card — never say it is done, say the request is on their screen.",
      minRole: "customer",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: `One of: ${COWORKER_TASK_KINDS.join(", ")}.` },
          folder: { type: "string", description: `For the folder tasks: one of ${COWORKER_FOLDERS.join(", ")}.` },
          reason: { type: "string", description: "One short sentence, in the person's own terms, saying why — shown on the approval card." },
        },
        required: ["kind", "reason"],
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        if (!isInsideCoworkerWindow(ctx)) {
          return {
            ok: false,
            error: "not_in_coworker_window",
            message: "Tasks on the computer can only be started from the Loopcom Coworker bubble on the Windows app. Tell them to open it there (tray icon → Show Coworker Bubble) and ask again.",
          };
        }
        if (!ctx.clientUserId) {
          return { ok: false, error: "no_requester", message: "This has to be asked for from a signed-in account." };
        }
        const raw: Record<string, unknown> = { kind: args.kind, reason: args.reason ?? "" };
        if (args.folder !== undefined) raw.folder = args.folder;
        const parsed = parseCoworkerTask(raw);
        if (!parsed.ok) {
          return {
            ok: false,
            error: parsed.refused,
            message: `I can only do these on the computer: ${COWORKER_TASK_KINDS.join(", ")}, in Downloads, Desktop or Documents. Say plainly that anything else is not something the Coworker can do yet.`,
          };
        }
        const task = parsed.task;
        const spec = specForTask(task);
        // ⛔ The policy engine judges it here, from the SAFE profile, before a
        // draft exists. A verdict of deny never becomes a card.
        const decision = decideToolCall({ spec, permissions: DEFAULT_PERMISSIONS, provenance: "user", coworkerEnabled: true });
        if (decision.verdict === "deny") {
          return { ok: false, error: decision.code, message: decision.message };
        }

        // One live proposal at a time per person. A second identical ask replaces
        // nothing — the first is still on their screen.
        const live = await deps.prisma.agentAction.findFirst({
          where: { tenantId: ctx.tenantId, capabilityId: COWORKER_TASK_CAPABILITY_ID, requestedBy: ctx.clientUserId, status: "DRAFT" },
          select: { id: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        });
        if (live && !coworkerTaskExpired(new Date(live.createdAt).getTime(), now())) {
          return {
            ok: false,
            error: "already_pending",
            taskId: live.id,
            message: "There is already a task waiting for their answer on screen. Ask them to press the button on that card (or No) before starting another.",
          };
        }

        const card = describeCoworkerTask(task);
        const created = await deps.prisma.agentAction.create({
          data: {
            tenantId: ctx.tenantId,
            capabilityId: COWORKER_TASK_CAPABILITY_ID,
            params: { task, decision: { verdict: decision.verdict, code: decision.code } },
            riskTier: spec.risk === "READ_ONLY" ? "low" : "medium",
            status: "DRAFT",
            summary: card.what,
            requestedBy: ctx.clientUserId,
            requestedRole: ctx.role,
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
            paramsHash: createHash("sha256").update(coworkerTaskApprovalSubject("pending", task)).digest("hex"),
          },
          select: { id: true },
        });
        // Rebind the hash to the real id now that it exists (the subject includes it).
        await deps.prisma.agentAction.update({
          where: { id: created.id },
          data: { paramsHash: createHash("sha256").update(coworkerTaskApprovalSubject(created.id, task)).digest("hex") },
        });

        return {
          ok: true,
          taskId: created.id,
          needsApproval: decision.verdict === "ask",
          summary: card.what,
          // The model must relay THIS: nothing has happened yet.
          message: decision.verdict === "ask"
            ? `The request is on their screen now (“${card.title}”). Nothing runs until they press “${card.action}”. Do not say it is done.`
            : `The request is on their screen now (“${card.title}”) and will run when they press “${card.action}”. Do not say it is done.`,
        };
      },
    },
    {
      name: "my_computer_tasks",
      description:
        "What the Loopcom Coworker has been asked to do on this person's computer recently, and what happened: waiting for their answer, done, refused, or failed. Use this before answering 'did it finish?'.",
      minRole: "customer",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async (_args, ctx: ToolContext) => {
        if (!ctx.clientUserId) return { ok: false, error: "no_requester", tasks: [] };
        const rows = await deps.prisma.agentAction.findMany({
          where: { tenantId: ctx.tenantId, capabilityId: COWORKER_TASK_CAPABILITY_ID, requestedBy: ctx.clientUserId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, status: true, summary: true, createdAt: true, executedAt: true, resultSnapshot: true, deniedReason: true, params: true },
        });
        const t = now();
        return {
          ok: true,
          tasks: rows.map((r: any) => {
            const expired = r.status === "DRAFT" && coworkerTaskExpired(new Date(r.createdAt).getTime(), t);
            const result = r.resultSnapshot && typeof r.resultSnapshot === "object" ? (r.resultSnapshot as { summary?: string; details?: string[] }) : null;
            return {
              id: r.id,
              kind: (r.params as { task?: { kind?: string } })?.task?.kind ?? null,
              what: r.summary,
              state: expired ? "expired_without_answer" : r.status === "DRAFT" ? "waiting_for_their_answer" : r.status === "APPROVED" ? "approved_running" : r.status === "EXECUTED" ? "done" : r.status === "DENIED" ? "declined" : r.status === "FAILED" ? "failed" : String(r.status).toLowerCase(),
              askedAt: r.createdAt,
              finishedAt: r.executedAt ?? null,
              result: result?.summary ?? null,
              details: Array.isArray(result?.details) ? result!.details.slice(0, 10) : [],
            };
          }),
        };
      },
    },
  ];
}
