import { test } from "node:test";
import assert from "node:assert/strict";
import { VitalPbxClient } from "@connect/integrations";

// Regression guard for the June 2026 incident where an automatic VitalPBX
// tenant re-save (PUT) silently wiped tenants' inbound DIDs. Connect must NEVER
// modify the PBX without explicit operator permission. These tests lock in the
// default-OFF "PBX read-only safe mode" enforced inside VitalPbxClient.

const BASE = { baseUrl: "http://pbx.invalid", apiToken: "test-key" };

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.PBX_ALLOW_CONFIG_MUTATIONS;
  if (value === undefined) delete process.env.PBX_ALLOW_CONFIG_MUTATIONS;
  else process.env.PBX_ALLOW_CONFIG_MUTATIONS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PBX_ALLOW_CONFIG_MUTATIONS;
    else process.env.PBX_ALLOW_CONFIG_MUTATIONS = prev;
  }
}

test("BLOCKS tenant update (DID-wiping PUT) by default", async () => {
  await withEnv(undefined, async () => {
    const client = new VitalPbxClient({ ...BASE });
    await assert.rejects(
      () => client.updateTenant("8", { name: "x" }),
      (err: any) => err?.code === "PBX_MUTATION_BLOCKED" && err?.httpStatus === 403,
    );
  });
});

test("BLOCKS inbound-number remove (DID delete) by default", async () => {
  await withEnv(undefined, async () => {
    const client = new VitalPbxClient({ ...BASE });
    await assert.rejects(
      () => client.removeTenantInboundNumber("8", { phone_number: "+18452449666" }),
      (err: any) => err?.code === "PBX_MUTATION_BLOCKED",
    );
  });
});

test("BLOCKS tenant create / delete / queue write by default", async () => {
  await withEnv(undefined, async () => {
    const client = new VitalPbxClient({ ...BASE });
    await assert.rejects(() => client.createTenant({ name: "x" }), (e: any) => e?.code === "PBX_MUTATION_BLOCKED");
    await assert.rejects(() => client.deleteTenant("8"), (e: any) => e?.code === "PBX_MUTATION_BLOCKED");
    await assert.rejects(() => client.syncTenant("8"), (e: any) => e?.code === "PBX_MUTATION_BLOCKED");
    await assert.rejects(() => client.createQueue({ name: "x" }, "8"), (e: any) => e?.code === "PBX_MUTATION_BLOCKED");
  });
});

test("ALLOWS read endpoints even with mutations disabled", async () => {
  await withEnv(undefined, async () => {
    // simulate avoids real network; the point is the guard must not fire on reads.
    const client = new VitalPbxClient({ ...BASE, simulate: true });
    const t = await client.getTenant("8");
    assert.ok(t, "read should not be blocked");
  });
});

test("env PBX_ALLOW_CONFIG_MUTATIONS=1 lets a mutation through the guard", async () => {
  await withEnv("1", async () => {
    const client = new VitalPbxClient({ ...BASE });
    // Guard must NOT block; it proceeds to the network and fails for another
    // reason (host is unreachable) — anything except PBX_MUTATION_BLOCKED.
    await assert.rejects(
      () => client.updateTenant("8", { name: "x" }),
      (err: any) => err?.code !== "PBX_MUTATION_BLOCKED",
    );
  });
});

test("explicit allowConfigMutations:true overrides the default block", async () => {
  await withEnv(undefined, async () => {
    const client = new VitalPbxClient({ ...BASE, allowConfigMutations: true });
    await assert.rejects(
      () => client.updateTenant("8", { name: "x" }),
      (err: any) => err?.code !== "PBX_MUTATION_BLOCKED",
    );
  });
});
