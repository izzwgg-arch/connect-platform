#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish fine-tune — RunPod SERVERLESS endpoint management
 * (Lane B, §3.2.5). This is the endpoint the platform's Everett client
 * (`apps/agent/src/transcription/everett.ts`) already calls in production —
 * `list`/`create`/`set-model` manage it, they never delete it.
 *
 * `create` builds a new serverless endpoint from the ivrit.ai
 * `runpod-serverless` worker image (github.com/ivrit-ai/runpod-serverless),
 * with `MODEL_NAME` set to whichever HF repo should be served — the stock
 * `ivrit-ai/yi-whisper-large-v3-turbo-ct2` or our fine-tuned repo.
 * `set-model` updates an EXISTING endpoint's env in place (what flips
 * `EVERETT_MODEL` after a fine-tune proves better on the gold set).
 *
 * ⛔ TODO(integrator, verify against live schema): the exact serverless
 * endpoint mutation names/fields (`saveEndpoint`/`endpointMutate` and
 * `myself.endpoints` for listing) are written from RunPod's public docs and
 * examples as of 2026-09-17. RunPod does not publish a versioned GraphQL
 * schema file — introspect `https://api.runpod.io/graphql` before the first
 * real `create`.
 *
 * ⛔ Never deletes an endpoint. There is no `delete` subcommand on purpose.
 */
import { pathToFileURL } from "node:url";

const GRAPHQL_URL = "https://api.runpod.io/graphql";

export type FetchFn = typeof fetch;

export interface RunpodDeps {
  fetchFn?: FetchFn;
  apiKey?: string;
}

function key(deps: RunpodDeps): string {
  const k = deps.apiKey ?? process.env.RUNPOD_API_KEY;
  if (!k) throw new Error("RUNPOD_API_KEY is not set (env or --api-key)");
  return k;
}

async function gql<T = any>(deps: RunpodDeps, query: string, variables?: Record<string, unknown>): Promise<T> {
  const f = deps.fetchFn ?? fetch;
  const res = await f(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key(deps)}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`RunPod GraphQL error: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 500)}`);
  }
  return json.data as T;
}

export const DEFAULT_SERVERLESS_IMAGE = "ivritai/runpod-serverless:latest";

export interface EndpointInfo {
  id: string;
  name: string;
  templateId?: string | null;
  workersMin?: number;
  workersMax?: number;
  gpuIds?: string;
}

const LIST_ENDPOINTS_QUERY = `
  query Myself {
    myself {
      endpoints {
        id
        name
        templateId
        workersMin
        workersMax
        gpuIds
      }
    }
  }
`;

export async function listEndpoints(deps: RunpodDeps = {}): Promise<EndpointInfo[]> {
  const data = await gql<{ myself: { endpoints: EndpointInfo[] } }>(deps, LIST_ENDPOINTS_QUERY);
  return data.myself?.endpoints ?? [];
}

export interface CreateEndpointInput {
  name: string;
  modelName: string;
  imageName?: string;
  gpuIds?: string;
  workersMin?: number;
  workersMax?: number;
}

/**
 * Env passed to the worker container — `MODEL_NAME` is what the ivrit.ai
 * `runpod-serverless` handler reads to decide which CT2 model to load.
 */
export function endpointEnv(input: CreateEndpointInput): { key: string; value: string }[] {
  return [{ key: "MODEL_NAME", value: input.modelName }];
}

const CREATE_ENDPOINT_MUTATION = `
  mutation SaveEndpoint($input: EndpointInput!) {
    saveEndpoint(input: $input) {
      id
      name
    }
  }
`;

export async function createEndpoint(input: CreateEndpointInput, deps: RunpodDeps = {}): Promise<EndpointInfo> {
  const data = await gql<{ saveEndpoint: EndpointInfo }>(deps, CREATE_ENDPOINT_MUTATION, {
    input: {
      name: input.name,
      templateId: null,
      imageName: input.imageName ?? DEFAULT_SERVERLESS_IMAGE,
      gpuIds: input.gpuIds ?? "AMPERE_80",
      workersMin: input.workersMin ?? 0,
      workersMax: input.workersMax ?? 1,
      env: endpointEnv(input),
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
    },
  });
  return data.saveEndpoint;
}

/** Flip an EXISTING endpoint's MODEL_NAME — never re-creates, never deletes. */
export async function setEndpointModel(endpointId: string, modelName: string, deps: RunpodDeps = {}): Promise<EndpointInfo> {
  const data = await gql<{ saveEndpoint: EndpointInfo }>(deps, CREATE_ENDPOINT_MUTATION, {
    input: { endpointId, env: [{ key: "MODEL_NAME", value: modelName }] },
  });
  return data.saveEndpoint;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "list": {
      const endpoints = await listEndpoints({});
      for (const e of endpoints) console.log(`${e.id}\t${e.name}\tworkers ${e.workersMin ?? 0}-${e.workersMax ?? 0}`);
      if (!endpoints.length) console.log("(no endpoints)");
      return;
    }
    case "create": {
      const model = argVal(rest, "--model");
      const name = argVal(rest, "--name");
      if (!model || !name) throw new Error("usage: create --model <hf repo> --name <name>");
      const ep = await createEndpoint({ name, modelName: model }, {});
      console.log(`[runpod-endpoint] created ${ep.id} (${ep.name}) serving ${model}`);
      console.log(`[runpod-endpoint] set EVERETT_ENDPOINT_ID=${ep.id} on the server once smoke-transcribe.ts proves it alive.`);
      return;
    }
    case "set-model": {
      const id = argVal(rest, "--id");
      const model = argVal(rest, "--model");
      if (!id || !model) throw new Error("usage: set-model --id <endpointId> --model <hf repo>");
      const ep = await setEndpointModel(id, model, {});
      console.log(`[runpod-endpoint] ${ep.id} now serving ${model}`);
      return;
    }
    default:
      console.log("usage: runpod-endpoint.ts <list|create --model <repo> --name <n>|set-model --id <id> --model <repo>>");
      console.log("(there is no 'delete' subcommand — endpoints are never deleted by this tool)");
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error("[runpod-endpoint] fatal", err);
    process.exit(1);
  });
}
