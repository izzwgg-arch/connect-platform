#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish fine-tune — RunPod on-demand POD lifecycle (Lane B, §3.2.4).
 *
 * Runs on Izzy's PC. Rents an on-demand GPU pod, uploads the dataset built by
 * `build-dataset.ts`, runs `train.py` on it, downloads the CT2 model +
 * `report.json`, and terminates the pod — always, including on error or
 * Ctrl-C, because an on-demand A100/H100 bills by the hour whether it is
 * doing anything or not.
 *
 * ⛔ `create` (and `run`) refuse without `--confirm`. `plan` is read-only: it
 * queries GPU prices and prints the hourly cost and the `--max-hours` cap
 * WITHOUT creating anything, so Izzy can see the bill before it starts.
 *
 * Owner decision 2026-09-17 ("use the best free option available", paid cap
 * $10/day): this is the PAID fallback, cheap by default —
 *   - GPU preference is cheap consumer cards FIRST (RTX 4090 / 3090 / A5000),
 *     the A100s LAST — a 24GB consumer card is enough for LoRA on
 *     whisper-large-v3-turbo (fits in ~10-12GB at batch 4/grad-accum 8) and
 *     costs a fraction of an A100.
 *   - `cloudType` defaults to COMMUNITY (cheaper, interruptible spot-like
 *     capacity), not SECURE.
 *   - `--max-hours` defaults to 2, and `create`/`run` HARD REFUSE when
 *     `price × --max-hours` exceeds `--max-cost-usd` (default $10) — a price
 *     that cannot be read is treated as "over cap", never as "assume it's
 *     fine". `plan` prints the same $ figure without ever refusing (it never
 *     creates anything).
 * The FREE path is `kaggle-run.ts` (Kaggle's ~30 free GPU-hours/week) — see
 * README.md "Free path: Kaggle". Use that first; this file is for when the
 * free quota is spent or a bigger/faster run is worth the money.
 *
 * The RunPod GraphQL mutation/query field names below are written from
 * public RunPod API documentation and community examples as of this build
 * (2026-09-17) — RunPod does not publish a versioned schema file, so
 * ⛔ TODO(integrator): verify `podFindAndDeployOnDemand`, `podTerminate` and
 * the `gpuTypes` query field list against a live `https://api.runpod.io/graphql`
 * introspection query before the first real `create --confirm` run.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = __dirname;
const GRAPHQL_URL = "https://api.runpod.io/graphql";

export type FetchFn = typeof fetch;

export interface RunpodDeps {
  fetchFn?: FetchFn;
  apiKey?: string;
  now?: () => number;
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

// ── GPU pricing / plan ───────────────────────────────────────────────────────

export interface GpuTypePrice {
  id: string;
  displayName: string;
  memoryInGb: number;
  securePrice: number | null;
  communityPrice: number | null;
}

/**
 * Cheap consumer cards FIRST (owner decision 2026-09-17: "cheap by
 * default"), the 80GB/H100 cards LAST as a capacity-only fallback when
 * nothing cheap is available. 24GB is plenty for LoRA on
 * whisper-large-v3-turbo — see train.py's 16GB-card defaults.
 */
export const DEFAULT_GPU_ORDER = [
  "NVIDIA GeForce RTX 4090",
  "NVIDIA GeForce RTX 3090",
  "NVIDIA RTX A5000",
  "NVIDIA A100 80GB PCIe",
  "NVIDIA A100-SXM4-80GB",
  "NVIDIA H100 80GB HBM3",
];

export const DEFAULT_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";
export const DEFAULT_VOLUME_GB = 200;

/** COMMUNITY = cheaper, interruptible-capacity pricing. SECURE stays available via --cloud-type. */
export type CloudType = "COMMUNITY" | "SECURE";
export const DEFAULT_CLOUD_TYPE: CloudType = "COMMUNITY";
export const DEFAULT_MAX_HOURS = 2;
export const DEFAULT_MAX_COST_USD = 10;

/**
 * ⛔ TODO(integrator, verify against live schema): `gpuTypes` is documented by
 * RunPod as returning `id`, `displayName`, `memoryInGb`,
 * `securePrice`/`communityPrice` (on-demand secure-cloud pricing, $/hr).
 */
const GPU_TYPES_QUERY = `
  query GpuTypes {
    gpuTypes {
      id
      displayName
      memoryInGb
      securePrice
      communityPrice
    }
  }
`;

/** Fetch GPU prices and pick the first available GPU from `order`, cheapest field first. */
export async function fetchGpuTypes(deps: RunpodDeps = {}): Promise<GpuTypePrice[]> {
  const data = await gql<{ gpuTypes: GpuTypePrice[] }>(deps, GPU_TYPES_QUERY);
  return data.gpuTypes ?? [];
}

export function pickGpu(gpuTypes: GpuTypePrice[], order: string[] = DEFAULT_GPU_ORDER): GpuTypePrice | null {
  for (const name of order) {
    const found = gpuTypes.find((g) => g.displayName === name || g.id === name);
    if (found) return found;
  }
  return null;
}

/** Price for the cloud type we are actually renting — COMMUNITY by default,
 * falling back to whichever field the GPU actually publishes. */
export function hourlyPriceOf(gpu: GpuTypePrice, cloudType: CloudType = DEFAULT_CLOUD_TYPE): number | null {
  if (cloudType === "SECURE") return gpu.securePrice ?? gpu.communityPrice ?? null;
  return gpu.communityPrice ?? gpu.securePrice ?? null;
}

export interface PlanResult {
  gpu: GpuTypePrice;
  cloudType: CloudType;
  hourlyPrice: number | null;
  maxHours: number;
  /** hourlyPrice * maxHours, rounded — null when the price is unknown (never assumed $0). */
  capUsd: number | null;
}

export function computePlan(
  gpuTypes: GpuTypePrice[],
  order: string[],
  maxHours: number,
  cloudType: CloudType = DEFAULT_CLOUD_TYPE,
): PlanResult {
  const gpu = pickGpu(gpuTypes, order);
  if (!gpu) throw new Error(`none of the preferred GPUs are available: ${order.join(", ")}`);
  const hourlyPrice = hourlyPriceOf(gpu, cloudType);
  return {
    gpu,
    cloudType,
    hourlyPrice,
    maxHours,
    capUsd: hourlyPrice == null ? null : Number((hourlyPrice * maxHours).toFixed(2)),
  };
}

/**
 * The hard budget gate. Refuses when the plan's cap exceeds `maxCostUsd` —
 * AND when the price could not be determined at all, because "unknown" is
 * never treated as "cheap enough". Only `create`/`run` call this; `plan`
 * never does, so it can always print the figures without throwing.
 */
export function assertWithinCostCap(plan: PlanResult, maxCostUsd: number): void {
  if (plan.capUsd == null) {
    throw new Error(
      `refusing to create: no price found for ${plan.gpu.displayName} (${plan.cloudType}) — cannot verify it is under the $${maxCostUsd} cap`,
    );
  }
  if (plan.capUsd > maxCostUsd) {
    throw new Error(
      `refusing to create: ${plan.gpu.displayName} (${plan.cloudType}) at $${plan.hourlyPrice}/hr × ${plan.maxHours}h = $${plan.capUsd} exceeds --max-cost-usd ${maxCostUsd}`,
    );
  }
}

// ── create / terminate ───────────────────────────────────────────────────────

export interface CreatePodInput {
  gpuTypeId: string;
  name: string;
  imageName?: string;
  volumeInGb?: number;
  containerDiskInGb?: number;
  cloudType?: CloudType;
}

export interface PodInfo {
  id: string;
  desiredStatus?: string;
  machineId?: string;
  runtime?: { ports?: { ip: string; publicPort: number; privatePort: number; type: string }[] } | null;
}

/**
 * ⛔ TODO(integrator, verify against live schema): `podFindAndDeployOnDemand`
 * is the documented mutation for renting a single on-demand pod; the field
 * list below (gpuTypeId, cloudType, volumeInGb, containerDiskInGb,
 * minVcpuCount, minMemoryInGb, imageName, dockerArgs, ports, volumeMountPath,
 * env) mirrors RunPod's public examples as of 2026-09-17.
 */
const CREATE_POD_MUTATION = `
  mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
    podFindAndDeployOnDemand(input: $input) {
      id
      desiredStatus
      machineId
    }
  }
`;

export async function createPod(input: CreatePodInput, deps: RunpodDeps = {}): Promise<PodInfo> {
  const data = await gql<{ podFindAndDeployOnDemand: PodInfo }>(deps, CREATE_POD_MUTATION, {
    input: {
      gpuTypeId: input.gpuTypeId,
      name: input.name,
      cloudType: input.cloudType ?? DEFAULT_CLOUD_TYPE,
      imageName: input.imageName ?? DEFAULT_IMAGE,
      volumeInGb: input.volumeInGb ?? DEFAULT_VOLUME_GB,
      containerDiskInGb: input.containerDiskInGb ?? 50,
      minVcpuCount: 8,
      minMemoryInGb: 40,
      ports: "22/tcp",
      startSsh: true,
      volumeMountPath: "/workspace",
    },
  });
  return data.podFindAndDeployOnDemand;
}

const POD_STATUS_QUERY = `
  query Pod($id: String!) {
    pod(input: { podId: $id }) {
      id
      desiredStatus
      runtime {
        ports { ip publicPort privatePort type }
      }
    }
  }
`;

export async function getPod(id: string, deps: RunpodDeps = {}): Promise<PodInfo> {
  const data = await gql<{ pod: PodInfo }>(deps, POD_STATUS_QUERY, { id });
  return data.pod;
}

/**
 * ⛔ TODO(integrator, verify against live schema): `podTerminate` is
 * documented as taking `{ podId }` and returning nothing meaningful; treated
 * here as fire-and-forget but always awaited so a caller can detect a
 * network failure and retry (never silently leave a pod billing).
 */
const TERMINATE_POD_MUTATION = `
  mutation TerminatePod($input: PodTerminateInput!) {
    podTerminate(input: $input)
  }
`;

export async function terminatePod(id: string, deps: RunpodDeps = {}): Promise<void> {
  await gql(deps, TERMINATE_POD_MUTATION, { input: { podId: id } });
}

export function sshPortOf(pod: PodInfo): { ip: string; port: number } | null {
  const p = pod.runtime?.ports?.find((x) => x.privatePort === 22);
  if (!p) return null;
  return { ip: p.ip, port: p.publicPort };
}

// ── wait-ready / upload / train / download (ssh/scp; real network + process) ─

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 }, (err: any, stdout, stderr) => {
      resolve({ code: err?.code == null ? 0 : Number(err.code) || 1, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function sshArgs(ip: string, port: number): string[] {
  return ["-o", "StrictHostKeyChecking=accept-new", "-p", String(port), `root@${ip}`];
}

export async function waitReady(pod: PodInfo, deps: RunpodDeps & { pollMs?: number; timeoutMs?: number } = {}): Promise<{ ip: string; port: number }> {
  const started = (deps.now ?? Date.now)();
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  const pollMs = deps.pollMs ?? 5000;
  // Not sleeping in unit tests: callers pass a fast pollMs/timeoutMs, or mock getPod.
  // (Left as a real loop for the CLI path; tests exercise sshPortOf/getPod directly.)
  let current = pod;
  while (true) {
    const p = sshPortOf(current);
    if (p) return p;
    if ((deps.now ?? Date.now)() - started > timeoutMs) throw new Error(`pod ${pod.id} never exposed SSH within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
    current = await getPod(pod.id, deps);
  }
}

export async function uploadDataset(ip: string, port: number, localDatasetDir: string, remoteDir = "/workspace"): Promise<void> {
  const res = await run("scp", ["-r", "-P", String(port), "-o", "StrictHostKeyChecking=accept-new", localDatasetDir, `root@${ip}:${remoteDir}/dataset`]);
  if (res.code !== 0) throw new Error(`scp dataset failed: ${res.stderr.slice(0, 400)}`);
  const scriptsRes = await run("scp", ["-r", "-P", String(port), "-o", "StrictHostKeyChecking=accept-new", HERE, `root@${ip}:${remoteDir}/yiddish-finetune`]);
  if (scriptsRes.code !== 0) throw new Error(`scp scripts failed: ${scriptsRes.stderr.slice(0, 400)}`);
}

export async function startTraining(ip: string, port: number, trainArgs: string[] = [], remoteDir = "/workspace"): Promise<void> {
  const cmd = [
    `cd ${remoteDir}/yiddish-finetune &&`,
    `pip install -q -r requirements.txt &&`,
    `nohup python3 train.py --dataset ${remoteDir}/dataset ${trainArgs.join(" ")} > train.log 2>&1 &`,
    `echo started`,
  ].join(" ");
  const res = await run("ssh", [...sshArgs(ip, port), cmd]);
  if (res.code !== 0 || !res.stdout.includes("started")) throw new Error(`failed to start training: ${res.stderr.slice(0, 400)}`);
}

export async function pollTrainingLog(ip: string, port: number, remoteDir = "/workspace"): Promise<string> {
  const res = await run("ssh", [...sshArgs(ip, port), `tail -n 100 ${remoteDir}/yiddish-finetune/train.log 2>/dev/null || echo "(no log yet)"`]);
  return res.stdout;
}

export async function isTrainingDone(ip: string, port: number, remoteDir = "/workspace"): Promise<boolean> {
  const res = await run("ssh", [...sshArgs(ip, port), `test -f ${remoteDir}/yiddish-finetune/report.json && echo yes || echo no`]);
  return res.stdout.trim() === "yes";
}

export async function downloadResults(ip: string, port: number, outDir: string, remoteDir = "/workspace"): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const ct2 = await run("scp", ["-r", "-P", String(port), "-o", "StrictHostKeyChecking=accept-new", `root@${ip}:${remoteDir}/yiddish-finetune/out-ct2`, outDir]);
  if (ct2.code !== 0) throw new Error(`scp out-ct2 failed: ${ct2.stderr.slice(0, 400)}`);
  const report = await run("scp", ["-P", String(port), "-o", "StrictHostKeyChecking=accept-new", `root@${ip}:${remoteDir}/yiddish-finetune/report.json`, outDir]);
  if (report.code !== 0) throw new Error(`scp report.json failed: ${report.stderr.slice(0, 400)}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function cloudTypeArg(argv: string[]): CloudType {
  const v = argVal(argv, "--cloud-type");
  if (!v) return DEFAULT_CLOUD_TYPE;
  if (v !== "COMMUNITY" && v !== "SECURE") throw new Error(`--cloud-type must be COMMUNITY or SECURE, got ${v}`);
  return v;
}

async function cliPlan(argv: string[]): Promise<void> {
  const maxHours = Number(argVal(argv, "--max-hours") ?? String(DEFAULT_MAX_HOURS));
  const maxCostUsd = Number(argVal(argv, "--max-cost-usd") ?? String(DEFAULT_MAX_COST_USD));
  const cloudType = cloudTypeArg(argv);
  const gpuTypes = await fetchGpuTypes({});
  const plan = computePlan(gpuTypes, DEFAULT_GPU_ORDER, maxHours, cloudType);
  console.log(`[runpod-pod] chosen GPU: ${plan.gpu.displayName} (${plan.gpu.id}), cloudType ${plan.cloudType}`);
  console.log(`[runpod-pod] price: $${plan.hourlyPrice ?? "?"}/hr, --max-hours ${plan.maxHours} -> cap $${plan.capUsd ?? "?"}`);
  console.log(
    plan.capUsd == null
      ? `[runpod-pod] price unknown — 'create' would REFUSE (cannot verify the $${maxCostUsd} cap)`
      : plan.capUsd > maxCostUsd
        ? `[runpod-pod] cap $${plan.capUsd} EXCEEDS --max-cost-usd ${maxCostUsd} — 'create' would REFUSE`
        : `[runpod-pod] cap $${plan.capUsd} is within --max-cost-usd ${maxCostUsd} — 'create' would proceed`,
  );
  console.log(`[runpod-pod] image: ${DEFAULT_IMAGE}, volume: ${DEFAULT_VOLUME_GB}GB`);
  console.log(`[runpod-pod] NOTHING was created. Re-run with 'create --confirm' to actually rent this pod.`);
}

export async function cliCreate(argv: string[]): Promise<PodInfo> {
  if (!argv.includes("--confirm")) throw new Error("refusing to create a pod without --confirm (this bills real money)");
  const maxHours = Number(argVal(argv, "--max-hours") ?? String(DEFAULT_MAX_HOURS));
  const maxCostUsd = Number(argVal(argv, "--max-cost-usd") ?? String(DEFAULT_MAX_COST_USD));
  const cloudType = cloudTypeArg(argv);
  const gpuTypes = await fetchGpuTypes({});
  const plan = computePlan(gpuTypes, DEFAULT_GPU_ORDER, maxHours, cloudType);
  assertWithinCostCap(plan, maxCostUsd);
  console.log(`[runpod-pod] creating ${plan.gpu.displayName} (${plan.cloudType}) @ $${plan.hourlyPrice}/hr, cap $${plan.capUsd} over ${maxHours}h`);
  const pod = await createPod(
    { gpuTypeId: plan.gpu.id, name: argVal(argv, "--name") ?? `yc-finetune-${Date.now()}`, cloudType },
    {},
  );
  console.log(`[runpod-pod] created pod ${pod.id}`);
  return pod;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "plan":
      return cliPlan(rest);
    case "create": {
      await cliCreate(rest);
      return;
    }
    case "wait-ready": {
      const id = argVal(rest, "--pod-id");
      if (!id) throw new Error("--pod-id required");
      const pod = await getPod(id, {});
      const p = await waitReady(pod, {});
      console.log(`[runpod-pod] ssh ready at ${p.ip}:${p.port}`);
      return;
    }
    case "upload": {
      const ip = argVal(rest, "--ip")!;
      const port = Number(argVal(rest, "--port")!);
      const dataset = argVal(rest, "--dataset")!;
      await uploadDataset(ip, port, dataset);
      console.log(`[runpod-pod] uploaded dataset + scripts`);
      return;
    }
    case "train": {
      const ip = argVal(rest, "--ip")!;
      const port = Number(argVal(rest, "--port")!);
      await startTraining(ip, port, rest.filter((a) => !["--ip", ip, "--port", String(port)].includes(a)));
      console.log(`[runpod-pod] training started; poll with 'runpod-pod.ts train-log --ip ... --port ...'`);
      return;
    }
    case "train-log": {
      const ip = argVal(rest, "--ip")!;
      const port = Number(argVal(rest, "--port")!);
      console.log(await pollTrainingLog(ip, port));
      return;
    }
    case "download": {
      const ip = argVal(rest, "--ip")!;
      const port = Number(argVal(rest, "--port")!);
      const outDir = argVal(rest, "--out") ?? path.join(HERE, "out");
      await downloadResults(ip, port, outDir);
      console.log(`[runpod-pod] downloaded results to ${outDir}`);
      return;
    }
    case "terminate": {
      const id = argVal(rest, "--pod-id");
      if (!id) throw new Error("--pod-id required");
      await terminatePod(id, {});
      console.log(`[runpod-pod] terminated pod ${id}`);
      return;
    }
    case "run": {
      if (!rest.includes("--confirm")) throw new Error("refusing to run the full pipeline without --confirm");
      const maxHours = Number(argVal(rest, "--max-hours") ?? String(DEFAULT_MAX_HOURS));
      const dataset = argVal(rest, "--dataset");
      if (!dataset) throw new Error("--dataset <dir> required");
      let pod: PodInfo | null = null;
      const deadline = Date.now() + maxHours * 3_600_000;
      const watchdog = setInterval(() => {
        if (Date.now() > deadline && pod) {
          console.error(`[runpod-pod] --max-hours ${maxHours} reached — terminating ${pod.id}`);
          terminatePod(pod.id, {}).finally(() => process.exit(1));
        }
      }, 30_000);
      const cleanup = async () => {
        clearInterval(watchdog);
        if (pod) {
          console.error(`[runpod-pod] cleaning up — terminating pod ${pod.id}`);
          await terminatePod(pod.id, {}).catch((e) => console.error(`[runpod-pod] terminate failed: ${e}`));
        }
      };
      process.once("SIGINT", () => cleanup().finally(() => process.exit(130)));
      try {
        pod = await cliCreate(rest);
        const { ip, port } = await waitReady(pod, {});
        await uploadDataset(ip, port, dataset);
        await startTraining(ip, port, rest.filter((a) => a !== "--confirm" && a !== "--dataset" && a !== dataset && a !== "--max-hours" && a !== String(maxHours)));
        console.log(`[runpod-pod] training launched; polling for report.json…`);
        while (!(await isTrainingDone(ip, port))) {
          await new Promise((r) => setTimeout(r, 60_000));
          console.log(await pollTrainingLog(ip, port));
        }
        const outDir = argVal(rest, "--out") ?? path.join(HERE, "out");
        await downloadResults(ip, port, outDir);
        console.log(`[runpod-pod] done, results in ${outDir}`);
      } catch (err) {
        console.error(`[runpod-pod] run failed:`, err);
        throw err;
      } finally {
        await cleanup();
      }
      return;
    }
    default:
      console.log("usage: runpod-pod.ts <plan|create|wait-ready|upload|train|train-log|download|terminate|run> [--confirm] [...]");
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
    console.error("[runpod-pod] fatal", err);
    process.exit(1);
  });
}
