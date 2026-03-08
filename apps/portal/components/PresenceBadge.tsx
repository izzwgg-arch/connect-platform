import type { Presence } from "../types/app";
import { StatusChip } from "./StatusChip";

export function PresenceBadge({ presence }: { presence: Presence }) {
  const tone = presence === "AVAILABLE" ? "success" : presence === "ON_CALL" ? "info" : presence === "DND" ? "warning" : "neutral";
  return <StatusChip tone={tone} label={presence.replace("_", " ")} />;
}
