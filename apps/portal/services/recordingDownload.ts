/**
 * Reliable cross-browser call-recording download.
 *
 * The previous approach — an <a target="_blank"> pointing at a
 * Content-Disposition:attachment WAV — is unreliable on Apple browsers
 * (Safari/Chrome on macOS/iOS), which frequently open the audio in a new
 * tab/Quick Look or get popup-blocked instead of saving the file. That
 * surfaced as "can listen but not download".
 *
 * Instead we fetch the audio as a Blob (same auth the inline player uses:
 * the ?token= query param) and trigger a real download via an object URL +
 * the `download` attribute, which Chrome, Firefox and modern Safari all honour.
 */

function getStorageToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("token") || window.localStorage.getItem("cc-token") || "";
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  // RFC 5987 filename*=UTF-8''... or plain filename="..."
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { /* fall through */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain?.[1]) return plain[1].trim();
  return fallback;
}

/**
 * Why a download failed, so the caller can say something true.
 *
 * "not_recorded" is a permanent answer — the PBX has confirmed the call has no
 * audio file — and must NOT be reported as "please try again", which is what
 * sent one customer clicking the same dead button four times in eight minutes.
 */
export type RecordingFailure = "not_recorded" | "forbidden" | "temporary";

export const RECORDING_FAILURE_TEXT: Record<RecordingFailure, string> = {
  not_recorded:
    "This call was not recorded, so there is no audio to download. If you expected it to be recorded, let us know — recording is switched on per route on the phone system.",
  forbidden: "You do not have permission to download this recording.",
  temporary:
    "The recording could not be fetched just now. This is usually temporary — please try again in a moment.",
};

/**
 * Download a call recording. Returns true on success. On failure returns false
 * (caller can surface a message). Falls back to a direct navigation if the
 * Blob/object-URL path is unavailable.
 *
 * Prefer downloadRecordingWithReason() for anything user-facing — this wrapper
 * exists so older call sites keep compiling.
 */
export async function downloadRecording(linkedId: string): Promise<boolean> {
  return (await downloadRecordingWithReason(linkedId)).ok;
}

/** Download a recording, reporting WHY it failed so the UI can be honest. */
export async function downloadRecordingWithReason(
  linkedId: string,
): Promise<{ ok: true } | { ok: false; reason: RecordingFailure }> {
  const token = getStorageToken();
  const base = `/api/voice/recording/${encodeURIComponent(linkedId)}/download`;
  const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
  const fallbackName = `recording-${linkedId}.wav`;

  try {
    const resp = await fetch(url, { headers: { Accept: "audio/*, */*" } });
    if (!resp.ok) {
      if (resp.status === 403) return { ok: false, reason: "forbidden" };
      if (resp.status === 404) {
        // 404 covers both "never recorded" and "no such call"; the server names
        // which. Anything else 404-shaped is still permanent, so don't invite a
        // retry that cannot succeed.
        const body = await resp.json().catch(() => null as any);
        return { ok: false, reason: body?.error === "audio_fetch_failed" ? "temporary" : "not_recorded" };
      }
      return { ok: false, reason: "temporary" };
    }
    const blob = await resp.blob();
    const filename = filenameFromDisposition(resp.headers.get("content-disposition"), fallbackName);

    const objectUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a tick so the download has started.
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 4000);
    return { ok: true };
  } catch {
    // Last-resort fallback: let the browser navigate to the attachment URL.
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true };
    } catch {
      return { ok: false, reason: "temporary" };
    }
  }
}
