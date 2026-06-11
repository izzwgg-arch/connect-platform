import { isLocalhostDevHost } from "@connect/shared";

export function isLocalhostDev(): boolean {
  return typeof window !== "undefined" && isLocalhostDevHost(window.location.host);
}
