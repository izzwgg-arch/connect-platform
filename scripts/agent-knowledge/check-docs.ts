/**
 * Pre-flight for the knowledge corpus: every file must parse, name a real
 * company, and keep its staff-only material out of the customer-safe half.
 *
 *   node scripts/agent-knowledge/check-docs.mjs
 *
 * Run this before committing a knowledge change. The api runs the same parser
 * at boot and simply skips a bad file, which is safe but silent — this makes
 * the problem loud while you can still fix it.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
// Imported from source, not from "@connect/shared": that package's `main`
// points at a build output which may be stale, and this check must read the
// same parser the api will actually run.
import { parseKnowledgeDoc } from "../../packages/shared/src/agentKnowledgeDoc";

/** Words that must never appear in a customer-facing body. */
const LEAK_PATTERNS = [
  /\bpassword\b/i,
  /\bAMI\b/,
  /\bssh\b/i,
  /\/root\//,
  /\bapi[_ -]?key\b/i,
  /\bcuid\b/i,
  /\bpbxRemovedAt\b/,
];

async function main() {
  const dir = path.join(process.cwd(), "docs", "agent-knowledge");
  const files = [];
  try {
    await fsp.access(path.join(dir, "system.md"));
    files.push({ abs: path.join(dir, "system.md"), rel: "system.md", slug: "system" });
  } catch {
    console.error("FAIL: docs/agent-knowledge/system.md is missing");
    process.exit(1);
  }
  for (const name of (await fsp.readdir(path.join(dir, "tenants"))).sort()) {
    if (!name.endsWith(".md")) continue;
    files.push({ abs: path.join(dir, "tenants", name), rel: `tenants/${name}`, slug: name.replace(/\.md$/, "") });
  }

  let bad = 0;
  const seenTenants = new Map();
  for (const f of files) {
    const text = await fsp.readFile(f.abs, "utf8");
    const doc = parseKnowledgeDoc({ text, slug: f.slug, sourcePath: f.rel });
    const problems = [...doc.errors];

    for (const re of LEAK_PATTERNS) {
      if (re.test(doc.body)) problems.push(`customer-safe body matches ${re} — move it inside <!-- internal -->`);
    }
    if (doc.scope === "tenant") {
      if (!doc.tenantId) problems.push("no tenantId in front matter (a rename would orphan this document)");
      else if (seenTenants.has(doc.tenantId)) problems.push(`same tenantId as ${seenTenants.get(doc.tenantId)} — two documents for one company`);
      else seenTenants.set(doc.tenantId, f.rel);
    }
    if (doc.body.length > 20000) problems.push(`customer-safe body is ${doc.body.length} chars — it will be truncated in the prompt`);

    if (problems.length) {
      bad++;
      console.error(`FAIL ${f.rel}`);
      for (const p of problems) console.error(`     · ${p}`);
    }
  }

  console.log(`${files.length} documents checked, ${bad} with problems`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
