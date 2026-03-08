import { StatusChip } from "./StatusChip";

export function LiveCallBadge({ active }: { active: boolean }) {
  return <StatusChip tone={active ? "info" : "neutral"} label={active ? "Live Call" : "Idle"} />;
}
