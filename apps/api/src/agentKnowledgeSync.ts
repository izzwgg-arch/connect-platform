/**
 * Publishes `docs/agent-knowledge/*.md` into `AgentKnowledgeDoc` rows.
 *
 * WHY THE API DOES THIS. The knowledge itself must live in git — that is where
 * Claude sessions write it and where it is reviewable. But the AGENT container
 * is a manual rebuild (it is in no deploy queue), so knowledge baked into the
 * agent image would need a hand-built container for every wording change. The
 * api ships the same repo (`COPY . .`, so `/app/docs` is inside the image) and
 * redeploys freely, so it reads the files at boot and writes them to the
 * database. The agent reads the database. Edit a file → deploy the api →
 * the assistant knows it, with no agent rebuild.
 *
 * ⛔ SAFETY RULES, each one load-bearing:
 *   · A file that fails to parse is SKIPPED and its previously published row is
 *     LEFT ALONE. Publishing half a document could publish the staff-only half
 *     (see `parseKnowledgeDoc` — it fails closed on an unbalanced marker), and
 *     losing good knowledge because someone typo'd is worse than being stale.
 *   · A tenant document must resolve to a REAL tenant. An unresolvable company
 *     is an error, never a guess — a document published against the wrong
 *     tenantId would tell one customer another customer's facts.
 *   · Stale rows are removed only when the scan actually read the directory AND
 *     found the system document. An empty or unreadable directory deletes
 *     NOTHING — the same defensive posture the PBX tenant sweep uses, for the
 *     same reason: a short list must never be read as "everything is gone".
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { db } from "@connect/db";
import { parseKnowledgeDoc, type ParsedKnowledgeDoc } from "@connect/shared";

export interface KnowledgeSyncSummary {
  dir: string;
  scanned: number;
  published: number;
  unchanged: number;
  removed: number;
  skipped: Array<{ file: string; reason: string }>;
  /** True when the directory could not be read at all (dev machines, older images). */
  missingDir: boolean;
}

export function agentKnowledgeDir(): string {
  const configured = String(process.env.AGENT_KNOWLEDGE_DIR || "").trim();
  if (configured) return configured.replace(/[\\/]+$/, "");
  // `/app` inside the container; the repo root when running from source.
  return path.join(process.cwd(), "docs", "agent-knowledge");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface CandidateFile {
  slug: string;
  relPath: string;
  text: string;
}

async function readCandidates(dir: string): Promise<CandidateFile[] | null> {
  const out: CandidateFile[] = [];
  const push = async (abs: string, rel: string, slug: string) => {
    const text = await fsp.readFile(abs, "utf8");
    out.push({ slug, relPath: rel, text });
  };

  try {
    await push(path.join(dir, "system.md"), "system.md", "system");
  } catch {
    // No system document is not fatal on its own, but it IS the signal used
    // below to decide whether deletion is safe.
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(path.join(dir, "tenants"));
  } catch {
    return out.length > 0 ? out : null;
  }
  for (const name of entries.sort()) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const slug = name.replace(/\.md$/i, "").toLowerCase();
    if (slug === "system") continue; // reserved
    try {
      await push(path.join(dir, "tenants", name), path.posix.join("tenants", name), slug);
    } catch {
      /* unreadable single file — reported as skipped below via absence */
    }
  }
  return out;
}

/**
 * Resolve which company a parsed tenant document belongs to. `tenantId` wins;
 * a name is accepted only when it matches exactly ONE live tenant.
 */
async function resolveTenantId(doc: ParsedKnowledgeDoc): Promise<{ tenantId: string; tenantName: string } | { error: string }> {
  if (doc.tenantId) {
    const t = await (db as any).tenant.findUnique({ where: { id: doc.tenantId }, select: { id: true, name: true } });
    if (!t) return { error: `tenantId ${doc.tenantId} does not exist` };
    return { tenantId: t.id, tenantName: t.name };
  }
  const name = (doc.tenantName ?? "").trim();
  if (!name) return { error: "no tenantId and no company name" };
  const matches = await (db as any).tenant.findMany({
    where: { name: { equals: name, mode: "insensitive" }, pbxRemovedAt: null },
    select: { id: true, name: true },
    take: 5,
  });
  if (matches.length === 0) return { error: `no live tenant is named "${name}" — add tenantId: to the front matter` };
  if (matches.length > 1) return { error: `"${name}" matches ${matches.length} tenants — use tenantId:` };
  return { tenantId: matches[0].id, tenantName: matches[0].name };
}

export async function syncAgentKnowledgeDocs(log?: {
  info: (o: any, m: string) => void;
  warn: (o: any, m: string) => void;
}): Promise<KnowledgeSyncSummary> {
  const dir = agentKnowledgeDir();
  const summary: KnowledgeSyncSummary = { dir, scanned: 0, published: 0, unchanged: 0, removed: 0, skipped: [], missingDir: false };

  const files = await readCandidates(dir);
  if (files === null) {
    summary.missingDir = true;
    log?.info({ knowledgeSync: summary }, "agent knowledge: no docs/agent-knowledge directory — nothing published");
    return summary;
  }
  summary.scanned = files.length;

  const existing: Array<{ id: string; slug: string; checksum: string; source: string }> = await (db as any).agentKnowledgeDoc.findMany({
    select: { id: true, slug: true, checksum: true, source: true },
  });
  const bySlug = new Map(existing.map((r) => [r.slug, r]));
  const seen = new Set<string>();
  let sawSystem = false;

  for (const file of files) {
    const parsed = parseKnowledgeDoc({ text: file.text, slug: file.slug, sourcePath: file.relPath });
    if (parsed.errors.length > 0) {
      summary.skipped.push({ file: file.relPath, reason: parsed.errors.join("; ") });
      continue;
    }

    let tenantId: string | null = null;
    let tenantName: string | null = null;
    if (parsed.scope === "tenant") {
      const resolved = await resolveTenantId(parsed);
      if ("error" in resolved) {
        summary.skipped.push({ file: file.relPath, reason: resolved.error });
        continue;
      }
      tenantId = resolved.tenantId;
      tenantName = resolved.tenantName;
    } else {
      sawSystem = true;
    }

    seen.add(file.slug);
    const checksum = sha256(file.text);
    const prior = bySlug.get(file.slug);
    if (prior && prior.checksum === checksum) {
      summary.unchanged++;
      continue;
    }

    const data = {
      scope: parsed.scope,
      tenantId,
      title: parsed.scope === "tenant" ? (tenantName ?? parsed.title) : parsed.title,
      body: parsed.body,
      internalBody: parsed.internalBody || null,
      checksum,
      source: "repo",
      sourcePath: file.relPath,
    };
    await (db as any).agentKnowledgeDoc.upsert({
      where: { slug: file.slug },
      create: { slug: file.slug, ...data },
      update: data,
    });
    summary.published++;
  }

  // ⛔ Deletion is gated on having actually read a real directory: the system
  // document present, and at least one document published or unchanged. A scan
  // that found nothing removes nothing.
  const scanLooksReal = sawSystem && files.length > 0;
  if (scanLooksReal) {
    for (const row of existing) {
      if (row.source !== "repo") continue; // hand-written rows are not ours to delete
      if (seen.has(row.slug)) continue;
      // A document skipped for an error this run is NOT stale — leave it.
      if (summary.skipped.some((s) => s.file.replace(/^tenants\//, "").replace(/\.md$/i, "").toLowerCase() === row.slug)) continue;
      await (db as any).agentKnowledgeDoc.delete({ where: { id: row.id } });
      summary.removed++;
    }
  }

  const noisy = summary.published > 0 || summary.removed > 0 || summary.skipped.length > 0;
  if (noisy) {
    const level = summary.skipped.length > 0 ? "warn" : "info";
    log?.[level]?.({ knowledgeSync: summary }, "agent knowledge documents synced");
  } else {
    log?.info({ knowledgeSync: { ...summary, skipped: [] } }, "agent knowledge documents unchanged");
  }
  return summary;
}
