import { StatusChip } from "./StatusChip";

export function RegistrationBadge({ registered }: { registered: boolean }) {
  return <StatusChip tone={registered ? "success" : "danger"} label={registered ? "Registered" : "Unregistered"} />;
}
