/**
 * The WORKBENCH tools — the agent's hands on the server.
 *
 * ⛔⛔ WHY THESE EXIST, AND WHAT WAS ACTUALLY BROKEN BEFORE THEM.
 * The support desk shipped an IDE whose chat dock posted to
 * `/agent/chat/message` — this agent — while this agent held no tool that could
 * touch a file. So a support person opened a file, asked "what is wrong with
 * this?", and the model answered from nothing: it could not read the file on
 * the screen, could not run the command that would settle the question, and
 * could not look at the page it was about to change. It looked like Cursor and
 * had no hands. That is what these four tools fix, and they add no dependency:
 * every gate they ride already existed for the human workbench.
 *
 * ⛔ `minRole: "staff"` on ALL FOUR — SUPER_ADMIN only, never "customer" and
 * never "internal". "internal" means admin MODE, which since 2026-08-06
 * includes every TENANT_ADMIN; handing a customer's own administrator a read of
 * the platform's source and a command runner on the production box would be the
 * worst privilege leak this codebase has ever shipped. A customer, and a tenant
 * admin, never learn these tools exist (`toolsForRole` filters them out).
 *
 * ⛔ NOTHING HERE DECIDES WHAT IS ALLOWED. The api door shares the human
 * workbench's gate closure, so "may this run" has exactly one implementation.
 * If you find yourself adding a check to this file, you are building the second
 * opinion that the design exists to prevent.
 *
 * ⛔ THEY CANNOT WRITE. There is no edit tool, no save tool, no deploy tool, and
 * that is deliberate rather than unfinished: every command is checked against a
 * read-only allowlist, and code reaches production only through the deploy
 * queue. If an edit tool is ever added it belongs behind the same
 * password-gated confirmation flow that provisioning uses — never here.
 */
import type { WorkbenchClient } from "../pbx/workbenchClient";
import type { ToolSpec } from "./toolRegistry";

export interface WorkbenchToolDeps {
  workbench: WorkbenchClient;
}

export function buildWorkbenchTools(deps: WorkbenchToolDeps): ToolSpec[] {
  return [
    {
      name: "list_files",
      description:
        [
          "List what is in a folder of the Connect codebase on the server. Use it to find your way around before reading anything — path is relative to the repository root, and an empty path lists the top level.",
          "",
          "Each entry says whether it is a file or a folder, its size, and its git letter (M changed, U new) when the box has a repository.",
          "",
          "Say what you are looking for in `purpose`; a person reads that trail afterwards.",
        ].join("\n"),
      minRole: "staff",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder relative to the repo root. Empty or omitted lists the top level." },
          purpose: { type: "string", description: "What you are looking for, in a few plain words." },
        },
        required: [],
        additionalProperties: false,
      },
      run: async (args) =>
        deps.workbench.call({
          action: "list_files",
          path: typeof args.path === "string" ? args.path : "",
          ...(typeof args.purpose === "string" && args.purpose.trim() ? { purpose: args.purpose.trim() } : {}),
        }),
    },

    {
      name: "read_file",
      description:
        [
          "Read a file from the Connect codebase on the server. This is how you see the file the person is looking at — read it before saying anything about what it does.",
          "",
          "Big files come back trimmed and say so. Files holding credentials are refused, and the refusal explains itself.",
          "",
          "⛔ EVIDENCE RULE: describe only what you have actually read. If you did not open it, say you did not check — never present a guess about code in the same voice as something you read.",
        ].join("\n"),
      minRole: "staff",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File relative to the repo root, e.g. apps/api/src/server.ts" },
          purpose: { type: "string", description: "Why you are opening it, in a few plain words." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (args) => {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return { ok: false, error: "Which file? Give a path relative to the repository root." };
        return deps.workbench.call({
          action: "read_file",
          path,
          ...(typeof args.purpose === "string" && args.purpose.trim() ? { purpose: args.purpose.trim() } : {}),
        });
      },
    },

    {
      name: "run_command",
      description:
        [
          "Run ONE read-only command on the server and see its output — grep, git status, docker ps, psql, journalctl, df, wc and the like. Use it to find out what is actually true instead of reasoning about what should be.",
          "",
          "It cannot change anything: only read-only tools are permitted, chaining and redirects are refused, and the ground rules are checked on top of that.",
          "",
          "If the answer comes back refused, READ THE REASON and adjust — it is telling you which rule you met. When a rule says the person must decide, ask them in the chat; you cannot confirm on your own behalf.",
          "",
          "Say what you are trying to establish in `purpose`.",
        ].join("\n"),
      minRole: "staff",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "One read-only shell command." },
          purpose: { type: "string", description: "What you are trying to establish, in a few plain words." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      run: async (args) => {
        const command = typeof args.command === "string" ? args.command.trim() : "";
        if (!command) return { ok: false, error: "No command was supplied." };
        return deps.workbench.call({
          action: "run_command",
          command,
          ...(typeof args.purpose === "string" && args.purpose.trim() ? { purpose: args.purpose.trim() } : {}),
        });
      },
    },

    {
      name: "browse",
      description:
        [
          "Open one of Loopcom's own web pages and read it back: the status code, how long it took, the title, the headings, the visible text, the links, the forms and which scripts it loads. Use it to check that a page really works after a change, or to see what a customer sees.",
          "",
          "It only opens Loopcom's own addresses, it is never signed in, and it sends no cookies — so what it sees is what a signed-out visitor sees.",
          "",
          "⛔ It reads a page's CONTENT, not its appearance. It cannot tell you whether something is the wrong colour, misaligned or ugly — for that, ask the person at the desk to look at the preview.",
          "",
          "⛔ When `clientRendered` comes back true the page is a shell that fills in after loading, so empty text there is NORMAL and is not evidence of a broken deploy.",
        ].join("\n"),
      minRole: "staff",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full address, e.g. https://app.loopcom.net/login" },
          purpose: { type: "string", description: "What you are checking, in a few plain words." },
        },
        required: ["url"],
        additionalProperties: false,
      },
      run: async (args) => {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) return { ok: false, error: "No address was supplied." };
        return deps.workbench.call({
          action: "browse",
          url,
          ...(typeof args.purpose === "string" && args.purpose.trim() ? { purpose: args.purpose.trim() } : {}),
        });
      },
    },
  ];
}
