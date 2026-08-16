import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The database is faked at module level: this suite is about the publishing
 * RULES (what gets written, what is refused, what is never deleted), not about
 * Prisma.
 */
const state: {
  docs: Array<any>;
  tenants: Array<{ id: string; name: string; pbxRemovedAt: Date | null }>;
  deleted: string[];
} = { docs: [], tenants: [], deleted: [] };

mock.module("@connect/db", {
  namedExports: {
    db: {
      agentKnowledgeDoc: {
        findMany: async ({ select }: any) => state.docs.map((d) => ({ ...d })),
        upsert: async ({ where, create, update }: any) => {
          const i = state.docs.findIndex((d) => d.slug === where.slug);
          if (i >= 0) state.docs[i] = { ...state.docs[i], ...update };
          else state.docs.push({ id: `doc_${state.docs.length + 1}`, ...create });
        },
        delete: async ({ where }: any) => {
          const i = state.docs.findIndex((d) => d.id === where.id);
          if (i >= 0) state.deleted.push(state.docs.splice(i, 1)[0].slug);
        },
      },
      tenant: {
        findUnique: async ({ where }: any) => state.tenants.find((t) => t.id === where.id) ?? null,
        findMany: async ({ where }: any) => {
          const name = String(where.name?.equals ?? "").toLowerCase();
          return state.tenants.filter((t) => t.name.toLowerCase() === name && t.pbxRemovedAt === null);
        },
      },
    },
  },
});

// Loaded after the module mock is installed. Not top-level await: this suite
// runs through tsx's CJS transform, which rejects it.
let syncAgentKnowledgeDocs: typeof import("./agentKnowledgeSync").syncAgentKnowledgeDocs;

let dir = "";
async function makeDir(files: Record<string, string>) {
  dir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-"));
  await mkdir(path.join(dir, "tenants"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await writeFile(path.join(dir, rel), text, "utf8");
  }
  process.env.AGENT_KNOWLEDGE_DIR = dir;
}

beforeEach(async () => {
  if (!syncAgentKnowledgeDocs) ({ syncAgentKnowledgeDocs } = await import("./agentKnowledgeSync"));
  state.docs = [];
  state.deleted = [];
  state.tenants = [
    { id: "t_acme", name: "Acme Ltd", pbxRemovedAt: null },
    { id: "t_beta", name: "Beta Co", pbxRemovedAt: null },
  ];
});

test("publishes the system document and each tenant document", async () => {
  await makeDir({
    "system.md": "# Connect\nCalls ring for 15 seconds.\n",
    "tenants/acme.md": "---\ntenantId: t_acme\n---\n# Acme\nOne extension, 101.\n",
  });
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.published, 2);
  assert.deepEqual(s.skipped, []);
  const acme = state.docs.find((d) => d.slug === "acme");
  assert.equal(acme.tenantId, "t_acme");
  assert.equal(acme.title, "Acme Ltd", "the title comes from the real tenant record");
  assert.match(acme.body, /One extension/);
  await rm(dir, { recursive: true, force: true });
});

test("a company can be named instead of id when the name is unambiguous", async () => {
  await makeDir({ "system.md": "# Connect\nx\n", "tenants/beta.md": "---\ntenant: beta co\n---\n# Beta\nTheir fact.\n" });
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.skipped.length, 0);
  assert.equal(state.docs.find((d) => d.slug === "beta").tenantId, "t_beta");
  await rm(dir, { recursive: true, force: true });
});

test("⛔ a document naming an unknown company is REFUSED, never guessed", async () => {
  await makeDir({ "system.md": "# Connect\nx\n", "tenants/ghost.md": "---\ntenant: Nobody Inc\n---\n# G\nfacts\n" });
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.published, 1, "only the system document publishes");
  assert.ok(s.skipped.some((x) => /no live tenant is named/.test(x.reason)));
  assert.equal(state.docs.find((d) => d.slug === "ghost"), undefined);
  await rm(dir, { recursive: true, force: true });
});

test("⛔ a broken file is skipped and its LAST GOOD version is left alone", async () => {
  state.docs.push({ id: "doc_1", slug: "acme", scope: "tenant", tenantId: "t_acme", title: "Acme Ltd", body: "good knowledge", checksum: "old", source: "repo" });
  await makeDir({
    "system.md": "# Connect\nx\n",
    // unbalanced internal marker → parse error
    "tenants/acme.md": "---\ntenantId: t_acme\n---\nsafe\n<!-- internal -->\nsecret\n",
  });
  const s = await syncAgentKnowledgeDocs();
  assert.ok(s.skipped.some((x) => /unbalanced/.test(x.reason)));
  const acme = state.docs.find((d) => d.slug === "acme");
  assert.equal(acme.body, "good knowledge", "the previously published document must survive");
  assert.deepEqual(state.deleted, [], "and it must NOT be treated as stale");
  await rm(dir, { recursive: true, force: true });
});

test("an unchanged file is not rewritten", async () => {
  await makeDir({ "system.md": "# Connect\nsame\n" });
  await syncAgentKnowledgeDocs();
  const s2 = await syncAgentKnowledgeDocs();
  assert.equal(s2.published, 0);
  assert.equal(s2.unchanged, 1);
  await rm(dir, { recursive: true, force: true });
});

test("a document whose file was deleted is removed", async () => {
  await makeDir({ "system.md": "# Connect\nx\n", "tenants/acme.md": "---\ntenantId: t_acme\n---\n# A\nfacts\n" });
  await syncAgentKnowledgeDocs();
  await rm(path.join(dir, "tenants", "acme.md"));
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.removed, 1);
  assert.deepEqual(state.deleted, ["acme"]);
  await rm(dir, { recursive: true, force: true });
});

test("⛔ an EMPTY or unreadable directory deletes NOTHING", async () => {
  state.docs.push({ id: "doc_1", slug: "acme", scope: "tenant", tenantId: "t_acme", title: "Acme", body: "b", checksum: "c", source: "repo" });
  process.env.AGENT_KNOWLEDGE_DIR = path.join(tmpdir(), "definitely-not-here-" + Date.now());
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.missingDir, true);
  assert.equal(s.removed, 0);
  assert.equal(state.docs.length, 1);
});

test("⛔ with the system document missing, nothing is deleted either", async () => {
  state.docs.push({ id: "doc_1", slug: "gone", scope: "tenant", tenantId: "t_acme", title: "Gone", body: "b", checksum: "c", source: "repo" });
  await makeDir({ "tenants/acme.md": "---\ntenantId: t_acme\n---\n# A\nfacts\n" });
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.removed, 0, "a scan without the system document is not trusted to be complete");
  await rm(dir, { recursive: true, force: true });
});

test("hand-written rows are never deleted by the file sync", async () => {
  state.docs.push({ id: "doc_1", slug: "typed-by-hand", scope: "tenant", tenantId: "t_beta", title: "B", body: "b", checksum: "c", source: "manual" });
  await makeDir({ "system.md": "# Connect\nx\n" });
  const s = await syncAgentKnowledgeDocs();
  assert.equal(s.removed, 0);
  assert.equal(state.docs.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test("staff-only sections are stored apart from the customer-safe body", async () => {
  await makeDir({
    "system.md": "# Connect\npublic\n<!-- internal -->\nstaff only\n<!-- /internal -->\n",
  });
  await syncAgentKnowledgeDocs();
  const sys = state.docs.find((d) => d.slug === "system");
  assert.doesNotMatch(sys.body, /staff only/);
  assert.match(sys.internalBody, /staff only/);
  await rm(dir, { recursive: true, force: true });
});
