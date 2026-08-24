/**
 * The workbench tools — the privilege boundary, and the refusal contract.
 *
 * ⛔ The `minRole: "staff"` assertions are the load-bearing ones. These four
 * tools are a read of the platform's source and a command runner on the
 * production box. "internal" means admin MODE, which since 2026-08-06 includes
 * every TENANT_ADMIN — so a single wrong tier here hands a customer's own
 * administrator the codebase and a shell-shaped door on loopcom.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorkbenchTools } from "./workbenchTools";
import { toolsForRole } from "./toolRegistry";

function stub(reply: any = { ok: true }) {
  const calls: any[] = [];
  return {
    calls,
    client: { async call(req: any) { calls.push(req); return reply; } },
  };
}

test("⛔⛔ every workbench tool is STAFF-only", () => {
  const tools = buildWorkbenchTools({ workbench: stub().client });
  assert.equal(tools.length, 4);
  for (const t of tools) {
    assert.equal(t.minRole, "staff", `${t.name} is not staff-only — a tenant admin could reach it`);
  }
});

test("⛔ a customer and a tenant admin never even learn these exist", () => {
  const tools = buildWorkbenchTools({ workbench: stub().client });
  const names = (role: "customer" | "internal" | "staff") =>
    toolsForRole(tools, role).map((t) => t.name).sort();
  assert.deepEqual(names("customer"), []);
  assert.deepEqual(names("internal"), []);
  assert.deepEqual(names("staff"), ["browse", "list_files", "read_file", "run_command"]);
});

test("⛔ no tool declares a tenant — scope is never the model's to choose", () => {
  for (const t of buildWorkbenchTools({ workbench: stub().client })) {
    const props = Object.keys(t.parameters.properties).map((k) => k.toLowerCase());
    for (const forbidden of ["tenantid", "tenant", "tenant_id", "companyid", "userid", "role"]) {
      assert.ok(!props.includes(forbidden), `${t.name} declares ${forbidden}`);
    }
  }
});

test("the tools pass the caller's words through, and nothing else", async () => {
  const s = stub();
  const tools = buildWorkbenchTools({ workbench: s.client });
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  const ctx = { tenantId: "t1", role: "staff" as const };

  await byName("read_file").run({ path: "apps/api/src/server.ts", purpose: "checking a route" }, ctx);
  assert.deepEqual(s.calls.at(-1), { action: "read_file", path: "apps/api/src/server.ts", purpose: "checking a route" });

  await byName("run_command").run({ command: "git status" }, ctx);
  assert.deepEqual(s.calls.at(-1), { action: "run_command", command: "git status" });

  await byName("browse").run({ url: "https://app.loopcom.net/login" }, ctx);
  assert.deepEqual(s.calls.at(-1), { action: "browse", url: "https://app.loopcom.net/login" });

  await byName("list_files").run({}, ctx);
  assert.deepEqual(s.calls.at(-1), { action: "list_files", path: "" });
});

test("⛔ a refusal reaches the model unchanged — it is data, not an error", async () => {
  const refusal = { ok: false, refused: true, error: "refused_by_ground_rules", message: "Your rules say never." };
  const tools = buildWorkbenchTools({ workbench: stub(refusal).client });
  const out: any = await tools.find((t) => t.name === "run_command")!
    .run({ command: "docker restart app-api-1" }, { tenantId: "t1", role: "staff" });
  // Swallowing this into a generic failure is how the model learns nothing and
  // simply tries the same thing again.
  assert.deepEqual(out, refusal);
});

test("an empty argument is answered locally rather than spent on a round trip", async () => {
  const s = stub();
  const tools = buildWorkbenchTools({ workbench: s.client });
  for (const [name, args] of [["read_file", { path: "  " }], ["run_command", { command: "" }], ["browse", { url: "" }]] as const) {
    const out: any = await tools.find((t) => t.name === name)!.run(args as any, { tenantId: "t1", role: "staff" });
    assert.equal(out.ok, false, name);
  }
  assert.equal(s.calls.length, 0, "an empty argument still reached the server");
});

test("⛔⛔ SOURCE GUARD: nothing in this file decides what is allowed", () => {
  const src = readFileSync(join(__dirname, "workbenchTools.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Every gate lives on the api, inside the same closure the human workbench
  // uses. A check here would be a SECOND opinion, and a second opinion is how
  // the agent ends up held to rules nobody wrote down.
  for (const forbidden of ["ALLOWED_BINARIES", "classifyAction", "decideCommandRun", "commandTouchesSecrets", "watchman"]) {
    assert.ok(!code.includes(forbidden), `workbenchTools.ts is re-implementing a gate (${forbidden})`);
  }
  // And it must never be able to claim a confirmation on the human's behalf.
  assert.ok(!/confirmed/i.test(code), "the agent must not be able to send a confirmation");
});

test("⛔ SOURCE GUARD: the agent is wired with these tools (the defect was always a missing caller)", () => {
  const src = readFileSync(join(__dirname, "..", "server.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes("buildWorkbenchTools"), "server.ts never builds the workbench tools");
  assert.ok(src.includes("makeWorkbenchClient"), "server.ts never builds the workbench client");
  const block = src.slice(src.indexOf("const chatTools = ["));
  const list = block.slice(0, block.indexOf("];") + 2);
  assert.ok(list.includes("buildWorkbenchTools"), "the workbench tools are built but never added to chatTools");
});
