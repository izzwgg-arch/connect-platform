import type { DockerContainerRow, DockerImageRow } from "../scanner";
import type { DependencyGraphNode, DependencyGraphSummary } from "../types";
import { resolveServiceName } from "./serviceMapping";

export type ImageInspectRow = {
  id: string;
  repoTags: string[];
  size: number;
  containers: number;
  rootFSLayers: number | null;
};

export function buildDependencyGraph(
  containers: DockerContainerRow[],
  images: DockerImageRow[],
  imageInspects: ImageInspectRow[],
): DependencyGraphSummary {
  const imageByTag = new Map<string, ImageInspectRow>();
  for (const img of imageInspects) {
    for (const tag of img.repoTags) imageByTag.set(tag.toLowerCase(), img);
    imageByTag.set(img.id.slice(0, 12).toLowerCase(), img);
  }

  const nodes: DependencyGraphNode[] = containers.map((c) => {
    const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
    const service = resolveServiceName(name, c.Image);
    const img = imageByTag.get(c.Image.toLowerCase()) ?? imageByTag.get(c.Image.split(":")[0]?.toLowerCase() ?? "");
    const running = (c.State ?? "").toLowerCase().includes("running");
    return {
      service,
      containerName: name,
      containerId: c.Id.slice(0, 12),
      image: c.Image,
      imageId: img?.id.slice(0, 12) ?? null,
      state: c.State ?? "unknown",
      sizeBytes: c.SizeRw ?? img?.size ?? null,
      classification: running ? "ACTIVE_REQUIRED" : "UNKNOWN_REQUIRES_REVIEW",
      protectedByRunningContainer: running,
      layerCount: img?.rootFSLayers ?? null,
    };
  });

  const runningCount = nodes.filter((n) => n.protectedByRunningContainer).length;
  const services = new Set(nodes.map((n) => n.service));
  const incomplete = containers.length > 0 && nodes.some((n) => n.service === "unknown");

  return {
    nodes: nodes.sort((a, b) => a.service.localeCompare(b.service)),
    runningContainerCount: runningCount,
    mappedServiceCount: services.size,
    incomplete,
    incompleteReason: incomplete ? "unmapped_containers_present" : null,
  };
}
