import type { BuildCacheEntryRow, BuildCacheGroupRow } from "../types";

export type { BuildCacheGroupRow };

const GROUP_PATTERNS: Array<{ group: string; test: (stage: string) => boolean }> = [
  { group: "COPY . . layers", test: (s) => /COPY\s+\.\s+\./i.test(s) || /\[stage-0\s+13\/14\]\s+COPY\s+\./i.test(s) },
  { group: "pnpm install layers", test: (s) => /pnpm\s+install/i.test(s) || /fetch\s+deps/i.test(s) },
  { group: ".next cache layers", test: (s) => /\.next\/cache/i.test(s) || /NEXT_OUTPUT/i.test(s) },
  { group: "prisma generate layers", test: (s) => /prisma/i.test(s) },
  { group: "builder stages", test: (s) => /\[builder/i.test(s) },
  { group: "runner stages", test: (s) => /\[runner/i.test(s) },
  { group: "portal COPY layers", test: (s) => /apps\/portal/i.test(s) },
  { group: "api COPY layers", test: (s) => /apps\/api/i.test(s) },
];

function matchGroup(stage: string | null): string {
  if (!stage) return "other";
  for (const p of GROUP_PATTERNS) {
    if (p.test(stage)) return p.group;
  }
  if (stage.includes("COPY")) return "COPY layers";
  if (stage.includes("mount")) return "cached mount layers";
  return "other";
}

export function buildCacheGroups(entries: BuildCacheEntryRow[]): BuildCacheGroupRow[] {
  const groups = new Map<string, BuildCacheEntryRow[]>();
  for (const e of entries) {
    const g = matchGroup(e.buildStage);
    const list = groups.get(g) ?? [];
    list.push(e);
    groups.set(g, list);
  }

  return [...groups.entries()]
    .map(([group, rows]) => {
      const ages = rows.map((r) => r.ageDays).filter((a): a is number => a != null);
      const lastUsed = rows.map((r) => r.ageDays).filter((a): a is number => a != null);
      const refCount = rows.filter(
        (r) => r.referencedByActiveImage || r.referencedByRunningContainer || r.referencedByRollbackImage,
      ).length;
      const prodDep = refCount > 0;
      const avgConf = rows.reduce((s, r) => s + r.confidencePct, 0) / (rows.length || 1);
      return {
        group,
        sizeBytes: rows.reduce((s, r) => s + r.sizeBytes, 0),
        entryCount: rows.length,
        oldestAgeDays: ages.length ? Math.max(...ages) : null,
        newestAgeDays: ages.length ? Math.min(...ages) : null,
        lastUsedAgeDays: lastUsed.length ? Math.min(...lastUsed) : null,
        referenceCount: refCount,
        productionDependent: prodDep,
        confidencePct: Math.round(avgConf * 10) / 10,
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}
