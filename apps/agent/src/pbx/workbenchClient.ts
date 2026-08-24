/**
 * Client for the api's support Workbench door
 * (POST /internal/agent/workbench, shared-secret header, fail-closed).
 *
 * ⛔ THIS CLIENT ENFORCES NOTHING AND MUST NOT TRY TO. Every gate — the
 * Watchman verdict, the command allowlist, the secret-path refusal, the
 * rulebook, the workspace root, the browser's host allowlist — lives on the api
 * side, inside the SAME closure the human workbench routes use. That is the
 * whole design: there is exactly one implementation of "may this run", so the
 * agent can never be held to looser rules than the person sitting at the desk.
 * Re-checking here would create a second opinion, and a second opinion is how
 * the two drift.
 *
 * ⛔ A REFUSAL IS DATA, NOT AN ERROR — the same contract as investigationClient.
 * When a gate turns something down the api answers 200 with `ok:false,
 * refused:true` and a plain-English reason, and that reason must reach the model
 * unchanged so it can adjust. Throwing "workbench_failed" instead would hide
 * "your rules say never" behind a generic error and the model would simply try
 * the same thing again. Only a transport fault or a missing secret throws.
 */
import { postInternalApi } from "./internalApiPost";

export type WorkbenchAction = "list_files" | "read_file" | "run_command" | "browse";

export interface WorkbenchRequest {
  action: WorkbenchAction;
  path?: string;
  command?: string;
  url?: string;
  /** Why the model is asking, in a few plain words. Lands in the audit row so a
   *  person reading the trail later sees the reasoning, not just the command. */
  purpose?: string;
}

export interface WorkbenchClient {
  call(req: WorkbenchRequest): Promise<any>;
}

export function makeWorkbenchClient(
  opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {},
): WorkbenchClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  // Above the api's own 30s command timeout so a command that legitimately runs
  // to its ceiling comes back as a result rather than as a transport abort.
  const timeoutMs = opts.timeoutMs ?? 40_000;
  return {
    async call(req: WorkbenchRequest): Promise<any> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("workbench_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const resp = await postInternalApi({
        url: `${baseUrl}/internal/agent/workbench`,
        secret,
        body: {
          action: req.action,
          ...(req.path != null ? { path: req.path } : {}),
          ...(req.command != null ? { command: req.command } : {}),
          ...(req.url != null ? { url: req.url } : {}),
          ...(req.purpose ? { purpose: req.purpose.slice(0, 300) } : {}),
        },
        timeoutMs,
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok && resp.status !== 200) {
        throw new Error(`workbench_api_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    },
  };
}
