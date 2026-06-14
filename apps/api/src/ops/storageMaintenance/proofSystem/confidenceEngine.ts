import type {
  ConfidenceLabel,
  StorageClassification,
  StorageInventoryItem,
} from "../types";

export type ConfidenceInput = {
  classification: StorageClassification;
  sizeBytes: number | null;
  referencedByRunningContainer?: boolean;
  referencedByActiveImage?: boolean;
  referencedByRollbackImage?: boolean;
  reclaimable?: boolean;
  inUse?: boolean;
  knownKind?: boolean;
  metadataComplete?: boolean;
};

export function scoreConfidence(input: ConfidenceInput): { confidencePct: number; confidenceLabel: ConfidenceLabel } {
  if (input.classification === "PROTECTED_NEVER_DELETE" || input.classification === "ACTIVE_REQUIRED") {
    return { confidencePct: 0, confidenceLabel: "BLOCKED" };
  }
  if (input.referencedByRunningContainer || input.inUse === true) {
    return { confidencePct: 0, confidenceLabel: "BLOCKED" };
  }
  if (input.classification === "UNKNOWN_REQUIRES_REVIEW" || input.metadataComplete === false) {
    return { confidencePct: 0, confidenceLabel: "UNKNOWN" };
  }
  if (input.referencedByActiveImage && !input.reclaimable) {
    return { confidencePct: 50, confidenceLabel: "REVIEW_REQUIRED" };
  }
  if (input.classification === "ROLLBACK_CANDIDATE") {
    return { confidencePct: 95, confidenceLabel: "LIKELY_SAFE" };
  }
  if (input.classification === "SAFE_CANDIDATE" && input.reclaimable !== false) {
    if (!input.referencedByActiveImage && !input.referencedByRollbackImage) {
      return { confidencePct: 99.9, confidenceLabel: "SAFE" };
    }
    return { confidencePct: 95, confidenceLabel: "LIKELY_SAFE" };
  }
  return { confidencePct: 70, confidenceLabel: "REVIEW_REQUIRED" };
}

export function scoreInventoryItem(item: StorageInventoryItem): { confidencePct: number; confidenceLabel: ConfidenceLabel } {
  const containers = Number(item.metadata?.containers ?? 0);
  const reclaimable = item.reclaimableBytes != null && item.reclaimableBytes > 0;
  return scoreConfidence({
    classification: item.classification,
    sizeBytes: item.sizeBytes,
    referencedByRunningContainer: containers > 0,
    referencedByActiveImage: containers > 0,
    referencedByRollbackImage: String(item.pathOrRef).toLowerCase().includes("candidate"),
    reclaimable,
    knownKind: item.kind !== "diagnostic_dump",
    metadataComplete: item.classification !== "UNKNOWN_REQUIRES_REVIEW",
  });
}
