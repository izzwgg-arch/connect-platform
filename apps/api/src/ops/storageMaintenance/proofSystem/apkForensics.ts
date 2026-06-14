import type { ApkForensicsRow, ApkForensicsSummary, StorageInventoryItem } from "../types";

function parseApkVersion(filename: string): string | null {
  const m = filename.match(/(\d+\.\d+\.\d+[^.]*)/);
  return m?.[1] ?? null;
}

export function buildApkForensics(items: StorageInventoryItem[]): ApkForensicsSummary {
  const apkItems = items.filter((i) => i.kind === "apk_download");
  const entries: ApkForensicsRow[] = apkItems.map((item, idx) => {
    const filename = item.label;
    const mtimeMs = Number(item.metadata?.mtimeMs ?? 0);
    const releaseDate = mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null;
    return {
      filename,
      path: item.pathOrRef,
      sizeBytes: item.sizeBytes ?? 0,
      buildDate: releaseDate,
      version: parseApkVersion(filename),
      releaseDate,
      isLatestRelease: idx === 0,
      referencedByDownloadPage: idx < 5,
    };
  });

  const totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);
  const latestReleases = entries.filter((e) => e.isLatestRelease || e.referencedByDownloadPage).slice(0, 5);
  const historicalReleases = entries.filter((e) => !e.isLatestRelease);

  return { totalBytes, latestReleases, historicalReleases, entries };
}
