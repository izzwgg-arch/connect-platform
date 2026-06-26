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
 * Download a call recording. Returns true on success. On failure returns false
 * (caller can surface a message). Falls back to a direct navigation if the
 * Blob/object-URL path is unavailable.
 */
export async function downloadRecording(linkedId: string): Promise<boolean> {
  const token = getStorageToken();
  const base = `/api/voice/recording/${encodeURIComponent(linkedId)}/download`;
  const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
  const fallbackName = `recording-${linkedId}.wav`;

  try {
    const resp = await fetch(url, { headers: { Accept: "audio/*, */*" } });
    if (!resp.ok) return false;
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
    return true;
  } catch {
    // Last-resort fallback: let the browser navigate to the attachment URL.
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch {
      return false;
    }
  }
}
