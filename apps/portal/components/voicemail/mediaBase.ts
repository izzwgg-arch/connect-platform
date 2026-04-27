/** Mirrors apiClient base: browser loads `<audio>` without fetch headers, so `/api` prefix is required in prod. */
export function mediaBaseUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  const fromEnv = baked != null && String(baked).trim() !== "" ? String(baked).trim().replace(/\/$/, "") : "";
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return "";
}

export function authTokenFromStorage(): string {
  if (typeof window === "undefined") return "";
  return (
    localStorage.getItem("token") ||
    localStorage.getItem("cc-token") ||
    localStorage.getItem("authToken") ||
    ""
  );
}

export function streamSrcForVoicemail(vm: { id: string; streamUrl?: string }): string {
  const apiBase = mediaBaseUrl();
  const token = authTokenFromStorage();
  return vm.streamUrl ?? `${apiBase}/voice/voicemail/${vm.id}/stream?token=${encodeURIComponent(token)}`;
}

export function downloadHrefForVoicemail(vmId: string): string {
  const apiBase = mediaBaseUrl();
  const token = authTokenFromStorage();
  return `${apiBase}/voice/voicemail/${vmId}/download?token=${encodeURIComponent(token)}`;
}
