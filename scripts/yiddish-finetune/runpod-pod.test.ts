/**
 * runpod-pod.ts — plan math + confirm gate. Every test uses an injected
 * `fetchFn`; NONE of these tests touch the real network or spend money.
 */
import test from "node:test";
import assert from "node:assert/strict";

// cliCreate falls back to process.env.RUNPOD_API_KEY when no deps.apiKey is
// given; tests that call it through the real global-fetch path need SOME
// key present (never a real one — every fetch here is monkey-patched).
process.env.RUNPOD_API_KEY ||= "test-key-for-runpod-pod-tests";

import {
  DEFAULT_CLOUD_TYPE,
  DEFAULT_GPU_ORDER,
  DEFAULT_IMAGE,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_HOURS,
  DEFAULT_VOLUME_GB,
  assertWithinCostCap,
  cliCreate,
  computePlan,
  createPod,
  fetchGpuTypes,
  hourlyPriceOf,
  pickGpu,
  sshPortOf,
  terminatePod,
  type GpuTypePrice,
} from "./runpod-pod";

const SAMPLE_GPUS: GpuTypePrice[] = [
  { id: "NVIDIA GeForce RTX 4090", displayName: "NVIDIA GeForce RTX 4090", memoryInGb: 24, securePrice: 0.44, communityPrice: 0.34 },
  { id: "NVIDIA GeForce RTX 3090", displayName: "NVIDIA GeForce RTX 3090", memoryInGb: 24, securePrice: 0.35, communityPrice: 0.22 },
  { id: "NVIDIA RTX A5000", displayName: "NVIDIA RTX A5000", memoryInGb: 24, securePrice: 0.36, communityPrice: 0.16 },
  { id: "NVIDIA A100 80GB PCIe", displayName: "NVIDIA A100 80GB PCIe", memoryInGb: 80, securePrice: 1.64, communityPrice: 1.19 },
  { id: "NVIDIA H100 80GB HBM3", displayName: "NVIDIA H100 80GB HBM3", memoryInGb: 80, securePrice: 2.79, communityPrice: 2.49 },
];

function fakeFetch(responder: (body: any) => any): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const data = responder(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data }),
    } as any;
  }) as any;
}

test("DEFAULT_GPU_ORDER puts cheap consumer cards first and the A100s/H100 last", () => {
  assert.deepEqual(DEFAULT_GPU_ORDER, [
    "NVIDIA GeForce RTX 4090",
    "NVIDIA GeForce RTX 3090",
    "NVIDIA RTX A5000",
    "NVIDIA A100 80GB PCIe",
    "NVIDIA A100-SXM4-80GB",
    "NVIDIA H100 80GB HBM3",
  ]);
});

test("DEFAULT_CLOUD_TYPE is COMMUNITY (cheap by default) and max-hours/cost defaults are 2h/$10", () => {
  assert.equal(DEFAULT_CLOUD_TYPE, "COMMUNITY");
  assert.equal(DEFAULT_MAX_HOURS, 2);
  assert.equal(DEFAULT_MAX_COST_USD, 10);
});

test("pickGpu prefers the cheapest-tier GPU (RTX 4090) first in the default order", () => {
  const gpu = pickGpu(SAMPLE_GPUS, DEFAULT_GPU_ORDER);
  assert.equal(gpu?.id, "NVIDIA GeForce RTX 4090");
});

test("pickGpu falls back to the next cheap card when the first is missing, never jumping straight to an A100", () => {
  const withoutFirst = SAMPLE_GPUS.filter((g) => g.id !== "NVIDIA GeForce RTX 4090");
  const gpu = pickGpu(withoutFirst, DEFAULT_GPU_ORDER);
  assert.equal(gpu?.id, "NVIDIA GeForce RTX 3090");
});

test("pickGpu only reaches an A100 once every cheap card is unavailable", () => {
  const onlyExpensive = SAMPLE_GPUS.filter((g) => g.id.includes("A100") || g.id.includes("H100"));
  const gpu = pickGpu(onlyExpensive, DEFAULT_GPU_ORDER);
  assert.equal(gpu?.id, "NVIDIA A100 80GB PCIe");
});

test("pickGpu returns null when nothing in the preference list is available", () => {
  const gpu = pickGpu([{ id: "unrelated", displayName: "unrelated", memoryInGb: 8, securePrice: 0.1, communityPrice: 0.05 }], DEFAULT_GPU_ORDER);
  assert.equal(gpu, null);
});

test("hourlyPriceOf prefers communityPrice by default (the cheap-by-default cloud type)", () => {
  assert.equal(hourlyPriceOf({ id: "x", displayName: "x", memoryInGb: 24, securePrice: 0.44, communityPrice: 0.34 }), 0.34);
  assert.equal(hourlyPriceOf({ id: "x", displayName: "x", memoryInGb: 24, securePrice: 0.44, communityPrice: null }), 0.44, "falls back to secure when community is unavailable");
});

test("hourlyPriceOf uses securePrice when cloudType=SECURE is requested explicitly", () => {
  assert.equal(hourlyPriceOf({ id: "x", displayName: "x", memoryInGb: 24, securePrice: 0.44, communityPrice: 0.34 }, "SECURE"), 0.44);
});

test("computePlan picks the cheap RTX 4090 by default and multiplies communityPrice by --max-hours", () => {
  const plan = computePlan(SAMPLE_GPUS, DEFAULT_GPU_ORDER, 2);
  assert.equal(plan.gpu.id, "NVIDIA GeForce RTX 4090");
  assert.equal(plan.cloudType, "COMMUNITY");
  assert.equal(plan.hourlyPrice, 0.34);
  assert.equal(plan.capUsd, 0.68);
  assert.equal(plan.maxHours, 2);
});

test("computePlan honours an explicit SECURE cloudType", () => {
  const plan = computePlan(SAMPLE_GPUS, DEFAULT_GPU_ORDER, 2, "SECURE");
  assert.equal(plan.hourlyPrice, 0.44);
  assert.equal(plan.capUsd, 0.88);
});

test("computePlan throws when none of the preferred GPUs are available (never silently picks something else)", () => {
  assert.throws(
    () => computePlan([{ id: "unrelated", displayName: "unrelated", memoryInGb: 8, securePrice: 0.1, communityPrice: 0.05 }], DEFAULT_GPU_ORDER, 2),
    /none of the preferred GPUs/,
  );
});

// ── the $10/day cost cap ─────────────────────────────────────────────────────

test("assertWithinCostCap passes when the plan's cap is under the limit", () => {
  const plan = computePlan(SAMPLE_GPUS, DEFAULT_GPU_ORDER, 2);
  assert.doesNotThrow(() => assertWithinCostCap(plan, 10));
});

test("assertWithinCostCap refuses when price x hours exceeds --max-cost-usd", () => {
  // A100 community $1.19/hr x 8h = $9.52... push past $10 with more hours.
  const plan = computePlan(SAMPLE_GPUS, ["NVIDIA A100 80GB PCIe"], 10);
  assert.equal(plan.capUsd, 11.9);
  assert.throws(() => assertWithinCostCap(plan, 10), /exceeds --max-cost-usd/);
});

test("assertWithinCostCap refuses (never assumes cheap) when the price could not be determined", () => {
  const plan = computePlan(
    [{ id: "NVIDIA GeForce RTX 4090", displayName: "NVIDIA GeForce RTX 4090", memoryInGb: 24, securePrice: null, communityPrice: null }],
    DEFAULT_GPU_ORDER,
    2,
  );
  assert.equal(plan.capUsd, null);
  assert.throws(() => assertWithinCostCap(plan, 10), /cannot verify/);
});

test("fetchGpuTypes uses the injected fetch and never touches the real network", async () => {
  let queried = false;
  const fetchFn = fakeFetch((body) => {
    queried = true;
    assert.match(body.query, /gpuTypes/);
    return { gpuTypes: SAMPLE_GPUS };
  });
  const gpus = await fetchGpuTypes({ fetchFn, apiKey: "test-key" });
  assert.equal(queried, true);
  assert.equal(gpus.length, SAMPLE_GPUS.length);
});

test("createPod sends the documented default image, volume size, and defaults cloudType to COMMUNITY", async () => {
  let sentInput: any = null;
  const fetchFn = fakeFetch((body) => {
    sentInput = body.variables.input;
    return { podFindAndDeployOnDemand: { id: "pod-123", desiredStatus: "RUNNING" } };
  });
  const pod = await createPod({ gpuTypeId: "NVIDIA GeForce RTX 4090", name: "test-pod" }, { fetchFn, apiKey: "test-key" });
  assert.equal(pod.id, "pod-123");
  assert.equal(sentInput.imageName, DEFAULT_IMAGE);
  assert.equal(sentInput.volumeInGb, DEFAULT_VOLUME_GB);
  assert.equal(sentInput.startSsh, true);
  assert.equal(sentInput.ports, "22/tcp");
  assert.equal(sentInput.cloudType, "COMMUNITY");
});

test("createPod honours an explicit cloudType override", async () => {
  let sentInput: any = null;
  const fetchFn = fakeFetch((body) => {
    sentInput = body.variables.input;
    return { podFindAndDeployOnDemand: { id: "pod-124" } };
  });
  await createPod({ gpuTypeId: "NVIDIA A100 80GB PCIe", name: "test-pod", cloudType: "SECURE" }, { fetchFn, apiKey: "test-key" });
  assert.equal(sentInput.cloudType, "SECURE");
});

test("terminatePod calls podTerminate with the pod id", async () => {
  let sentInput: any = null;
  const fetchFn = fakeFetch((body) => {
    sentInput = body.variables.input;
    return { podTerminate: true };
  });
  await terminatePod("pod-123", { fetchFn, apiKey: "test-key" });
  assert.equal(sentInput.podId, "pod-123");
});

test("sshPortOf finds the mapped public port for the pod's private SSH port 22", () => {
  const pod = {
    id: "pod-1",
    runtime: { ports: [{ ip: "1.2.3.4", publicPort: 40001, privatePort: 22, type: "tcp" }] },
  };
  assert.deepEqual(sshPortOf(pod as any), { ip: "1.2.3.4", port: 40001 });
});

test("sshPortOf returns null before the pod has exposed any ports yet", () => {
  assert.equal(sshPortOf({ id: "pod-1", runtime: null } as any), null);
  assert.equal(sshPortOf({ id: "pod-1", runtime: { ports: [] } } as any), null);
});

// ── the --confirm gate ───────────────────────────────────────────────────────

test("cliCreate refuses to create a pod without --confirm, and never touches the network", async () => {
  let touched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    touched = true;
    throw new Error("network must not be touched without --confirm");
  }) as any;
  try {
    await assert.rejects(() => cliCreate(["--name", "test-pod"]), /--confirm/);
    assert.equal(touched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cliCreate refuses when price x --max-hours exceeds --max-cost-usd, and never creates a pod", async () => {
  let podCreateCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (/gpuTypes/.test(body.query)) {
      return { ok: true, json: async () => ({ data: { gpuTypes: [SAMPLE_GPUS[3]] } }) } as any; // A100, community $1.19/hr
    }
    podCreateCalled = true;
    throw new Error("must not create a pod once the cost cap refuses");
  }) as any;
  try {
    // $1.19/hr x 20h = $23.80, well over the default $10 cap.
    await assert.rejects(
      () => cliCreate(["--confirm", "--max-hours", "20"]),
      /exceeds --max-cost-usd/,
    );
    assert.equal(podCreateCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cliCreate proceeds and requests COMMUNITY pricing when within the default cost cap", async () => {
  let createInput: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (/gpuTypes/.test(body.query)) {
      return { ok: true, json: async () => ({ data: { gpuTypes: [SAMPLE_GPUS[0]] } }) } as any; // RTX 4090
    }
    createInput = body.variables.input;
    return { ok: true, json: async () => ({ data: { podFindAndDeployOnDemand: { id: "pod-1" } } }) } as any;
  }) as any;
  try {
    const pod = await cliCreate(["--confirm"]);
    assert.equal(pod.id, "pod-1");
    assert.equal(createInput.cloudType, "COMMUNITY");
    assert.equal(createInput.gpuTypeId, "NVIDIA GeForce RTX 4090");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the CLI module's create/run subcommands are gated on --confirm (source check)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src: string = fs.readFileSync(path.join(__dirname, "runpod-pod.ts"), "utf8");
  const createFn = src.slice(src.indexOf("async function cliCreate"), src.indexOf("async function main"));
  assert.match(createFn, /--confirm/, "cliCreate must check for --confirm before creating anything");
  assert.match(createFn, /refusing to create/i);
  const runCase = src.slice(src.indexOf('case "run"'), src.indexOf('default:'));
  assert.match(runCase, /--confirm/);
});
