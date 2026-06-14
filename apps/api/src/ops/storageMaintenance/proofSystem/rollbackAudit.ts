import type { DockerImageRow } from "../scanner";
import type { RollbackCoverageRow, StorageClassification } from "../types";
import { CORE_ROLLBACK_SERVICES, isRollbackImageRef, resolveServiceName } from "./serviceMapping";

function classifyRollbackImage(repoTag: string, containers: number): StorageClassification {
  if (containers > 0) return "ACTIVE_REQUIRED";
  if (isRollbackImageRef(repoTag)) return "ROLLBACK_CANDIDATE";
  return "SAFE_CANDIDATE";
}

export function buildRollbackCoverage(images: DockerImageRow[]): RollbackCoverageRow[] {
  const byService = new Map<string, RollbackCoverageRow[]>();

  for (const img of images) {
    const tag = img.RepoTags?.[0] ?? img.Id.slice(0, 12);
    const [repository = tag, tagName = "latest"] = tag.includes(":") ? tag.split(":") : [tag, "latest"];
    const service = resolveServiceName(repository, tag);
    const classification = classifyRollbackImage(tag, img.Containers ?? 0);
    const row: RollbackCoverageRow = {
      service,
      image: repository,
      tag: tagName,
      sizeBytes: img.Size ?? null,
      classification,
      rollbackAvailable: classification === "ROLLBACK_CANDIDATE" || (img.Containers ?? 0) > 0,
      deploymentHint: isRollbackImageRef(tag) ? "blue_green_candidate_image" : null,
    };
    const list = byService.get(service) ?? [];
    list.push(row);
    byService.set(service, list);
  }

  const rows: RollbackCoverageRow[] = [];
  for (const service of CORE_ROLLBACK_SERVICES) {
    const matches = byService.get(service);
    if (matches?.length) {
      const best = matches.sort((a, b) => (b.rollbackAvailable ? 1 : 0) - (a.rollbackAvailable ? 1 : 0))[0]!;
      rows.push({ ...best, service });
    } else {
      rows.push({
        service,
        image: `app-${service}`,
        tag: "latest",
        sizeBytes: null,
        classification: "UNKNOWN_REQUIRES_REVIEW",
        rollbackAvailable: false,
        deploymentHint: "image_not_found_in_inventory",
      });
    }
  }

  for (const [service, list] of byService) {
    if ((CORE_ROLLBACK_SERVICES as readonly string[]).includes(service)) continue;
    rows.push(...list);
  }

  return rows.sort((a, b) => a.service.localeCompare(b.service));
}
