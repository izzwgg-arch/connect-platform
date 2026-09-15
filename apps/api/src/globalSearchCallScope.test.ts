import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the actual history selection block: search must not return before its in-memory guards.
const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const route = source.slice(source.indexOf('searchOnly: z.enum(["1"])'));
const start = route.indexOf("  const skip =");
const end = route.indexOf("  const extensionCandidates =", start);
assert.ok(!route.slice(0, start).includes('if (query.searchOnly === "1")'), "no early search return before access filters");
const block = ts.transpileModule(route.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const selectRows = new Function("db", "query", "where", "extensionScoped", "userExtensions", "linkedSipScopes", "cdrRowMatchesExtensions", "cdrRowMatchesExtensionNumbers", `return (async () => {${block}})()`);
const row = (id: string, extension: string) => ({ id, fromNumber: extension, toNumber: "outside", startedAt: new Date("2026-09-14T12:00:00Z"), direction: "incoming" });
async function run(extensionScoped: boolean, linkedSipScopes: any[] = []) {
  const own = [row("allowed", "101"), row("private", "102")];
  const foreign = [row("linked", "201"), row("foreign-private", "202")];
  const db = { connectCdr: { findMany: async ({ where }: any) => where.tenantId.in.includes("foreign") ? foreign : own, count: async () => 2 } };
  const matches = (r: any, extensions: string[]) => extensions.includes(r.fromNumber);
  return selectRows(db, { page: 1, pageSize: 10, searchOnly: "1" }, { tenantId: { in: ["own"] } }, extensionScoped, ["101"], linkedSipScopes, matches, matches);
}
test("call search excludes another extension's rows for extension-scoped viewers", async () => {
  assert.deepEqual((await run(true)).items.map((r: any) => r.rowId), ["allowed"]);
});
test("call search merges only authorized linked-SIP extensions", async () => {
  assert.deepEqual((await run(false, [{ tenantKeys: ["foreign"], extensions: ["201"] }])).items.map((r: any) => r.rowId), ["allowed", "private", "linked"]);
});
test("tenant-wide call search retains own-tenant visibility and minimal metadata", async () => {
  const result = await run(false);
  assert.deepEqual(result.items.map((r: any) => r.rowId), ["allowed", "private"]);
  assert.equal(result.items[0].direction, undefined);
});
