import type { NormalizedExtensionState } from "../types";

export function normalizeExtensionForClient(
  ext: NormalizedExtensionState,
): NormalizedExtensionState {
  return { ...ext };
}
