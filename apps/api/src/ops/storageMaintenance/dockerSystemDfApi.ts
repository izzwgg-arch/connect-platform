import type { DockerSystemSummary } from "./types";

export type DockerBuildCacheRaw = {
  ID?: string;
  Parent?: string;
  Type?: string;
  Description?: string;
  InUse?: boolean;
  Shared?: boolean;
  Size?: number;
  CreatedAt?: string;
  LastUsedAt?: string;
  UsageCount?: number;
  Reclaimable?: boolean;
};

type DockerSystemDfJson = {
  Images?: Array<{ Size?: number; SharedSize?: number; UniqueSize?: number }>;
  Containers?: Array<{ SizeRw?: number; SizeRootFs?: number }>;
  Volumes?: Array<{ UsageData?: { Size?: number } }>;
  BuildCache?: DockerBuildCacheRaw[];
};

export function parseDockerSystemDfJson(raw: DockerSystemDfJson): DockerSystemSummary {
  const images = raw.Images ?? [];
  const containers = raw.Containers ?? [];
  const volumes = raw.Volumes ?? [];
  const buildCache = raw.BuildCache ?? [];

  const imagesBytes = images.reduce((s, i) => s + (i.Size ?? 0), 0);
  const containersBytes = containers.reduce((s, c) => s + (c.SizeRw ?? 0) + (c.SizeRootFs ?? 0), 0);
  const volumesBytes = volumes.reduce((s, v) => s + (v.UsageData?.Size ?? 0), 0);
  const buildTotalBytes = buildCache.reduce((s, b) => s + (b.Size ?? 0), 0);
  const buildReclaimableBytes = buildCache
    .filter((b) => b.Reclaimable)
    .reduce((s, b) => s + (b.Size ?? 0), 0);

  return {
    imagesCount: images.length,
    imagesBytes: images.length ? imagesBytes : null,
    imagesReclaimableBytes: null,
    containersCount: containers.length,
    containersBytes: containers.length ? containersBytes : null,
    volumesCount: volumes.length,
    volumesBytes: volumes.length ? volumesBytes : null,
    buildCache: {
      entryCount: buildCache.length,
      totalBytes: buildCache.length ? buildTotalBytes : null,
      reclaimableBytes: buildCache.length ? buildReclaimableBytes : null,
      source: buildCache.length ? "docker_system_df" : "unavailable",
    },
  };
}

export function extractBuildCacheRaw(raw: DockerSystemDfJson): DockerBuildCacheRaw[] {
  return raw.BuildCache ?? [];
}
