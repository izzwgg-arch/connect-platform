import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where onboarding wizard uploads (porting bills / LOAs) live on disk.
 *
 * ONBOARDING_STORAGE_DIR must point at a volume-backed directory in
 * production — docker-compose.app.yml mounts the onboarding-files volume at
 * /var/lib/connect/onboarding-files for both api and api_candidate. The cwd
 * fallback exists for local dev only: inside a container it lands in the
 * ephemeral writable layer, and every deploy destroys the files while the
 * onboardingUploadedFile DB row survives (proven 2026-08-05 — a customer's
 * ported-number bill was wiped by that evening's deploys).
 */
export function onboardingStorageRoot(): string {
  return (process.env.ONBOARDING_STORAGE_DIR || path.resolve(process.cwd(), "data/onboarding-files")).replace(/\\/g, "/");
}

/** Resolve a stored key to an absolute path, refusing anything that escapes the root. */
export function resolveOnboardingStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("invalid_storage_key");
  const root = path.resolve(onboardingStorageRoot());
  const full = path.resolve(root, clean);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

/** True when the bytes for an uploaded-file row are actually still on disk. */
export function onboardingFileExists(storageKey: string | null | undefined): boolean {
  if (!storageKey) return false;
  try {
    return fs.existsSync(resolveOnboardingStoragePath(String(storageKey)));
  } catch {
    return false;
  }
}

/**
 * Startup guard: an api container running without ONBOARDING_STORAGE_DIR is
 * silently writing customer port documents to disk that the next deploy will
 * destroy. Loud warning so it shows up in `docker logs` immediately.
 */
export function warnIfOnboardingStorageEphemeral(log: { warn: (obj: unknown, msg?: string) => void }): void {
  if (!process.env.ONBOARDING_STORAGE_DIR) {
    log.warn(
      { fallbackDir: onboardingStorageRoot() },
      "ONBOARDING_STORAGE_DIR is not set — onboarding uploads (porting bills/LOAs) are being written to an ephemeral directory and will be LOST on the next deploy. Set it to a volume-backed path (see docker-compose.app.yml).",
    );
  }
}
