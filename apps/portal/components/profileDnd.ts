export type DndResponse = { supported?: boolean; dnd?: boolean; reason?: string; extension?: string; confirmed?: boolean };
export type DndState =
  | { status: "loading" }
  | { status: "saving" }
  | { status: "ready"; enabled: boolean; extension?: string }
  | { status: "unavailable"; reason: string };

export function readDndState(response: DndResponse): DndState {
  if (response.supported === true && typeof response.dnd === "boolean") {
    return { status: "ready", enabled: response.dnd, extension: response.extension };
  }
  return { status: "unavailable", reason: response.reason || "read_failed" };
}

// A POST can succeed while its read-back fails. Never turn its echoed request
// into a confirmed phone-system state, nor assume a failed request left DND off.
export function savedDndState(response: DndResponse): DndState {
  return response.confirmed === true && typeof response.dnd === "boolean"
    ? { status: "ready", enabled: response.dnd }
    : { status: "unavailable", reason: "unconfirmed" };
}

export function dndUnavailableMessage(reason: string): string {
  switch (reason) {
    case "no_extension": return "Assign an extension to your account to use Do Not Disturb.";
    case "no_tenant": return "Select your company to use Do Not Disturb.";
    case "tenant_not_linked": return "Your company’s phone system is not connected.";
    case "route_helper_not_configured": return "Phone-system controls are not configured. Contact support.";
    case "unconfirmed": return "The change could not be confirmed. Check the status before relying on it.";
    default: return "We couldn’t read your phone-system status. Try again.";
  }
}
