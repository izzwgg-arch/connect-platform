/**
 * Shared plumbing for call-recording PLAYBACK in the browser.
 *
 * Every screen that plays a call recording (Call History detail panel, CRM
 * timeline, Call Recordings pages) must build its stream URL and explain its
 * failures through this module — there have been TWO players with divergent
 * behavior before (one got a loading spinner and honest errors, the other
 * stayed silent), and that split is exactly what this file exists to prevent.
 *
 * An <audio> element's onError says only "it broke" — never why. So on failure
 * we ask the server for one byte (Range: bytes=0-0) and use its status + JSON
 * body to say the true thing:
 *   - 404 with a "never recorded" body is PERMANENT — the PBX has confirmed no
 *     audio exists. Saying "try again" here sent one customer clicking the same
 *     dead button four times in eight minutes.
 *   - 403 is a permission answer, not a glitch.
 *   - everything else (5xx, network, auth hiccups) is temporary and retryable.
 */

export type RecordingPlaybackFailure = "not_recorded" | "forbidden" | "temporary";

export const RECORDING_PLAYBACK_TEXT: Record<RecordingPlaybackFailure, string> = {
  not_recorded: "This call wasn’t recorded, so there’s no audio to play.",
  forbidden: "You don’t have permission to listen to this recording.",
  temporary: "The audio didn’t load. This is usually temporary — try again.",
};

export function getRecordingToken(): string {
  if (typeof window === "undefined") return "";
  return (
    window.localStorage.getItem("token") ||
    window.localStorage.getItem("cc-token") ||
    window.localStorage.getItem("authToken") ||
    ""
  );
}

function recordingUrl(linkedId: string, kind: "stream" | "download"): string {
  const base = `/api/voice/recording/${encodeURIComponent(linkedId)}/${kind}`;
  const token = getRecordingToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function recordingStreamUrl(linkedId: string): string {
  return recordingUrl(linkedId, "stream");
}

export function recordingDownloadUrl(linkedId: string): string {
  return recordingUrl(linkedId, "download");
}

export async function classifyRecordingPlaybackFailure(
  streamUrl: string,
): Promise<RecordingPlaybackFailure> {
  try {
    const resp = await fetch(streamUrl, { headers: { Range: "bytes=0-0" } });
    if (resp.ok || resp.status === 206) return "temporary"; // server served audio — the element choked, not the recording
    if (resp.status === 403) return "forbidden";
    if (resp.status === 404) {
      const body = (await resp.json().catch(() => null)) as { error?: string } | null;
      // The server's 404 bodies distinguish "never recorded" (permanent) from a
      // transient fetch problem it chose to 404-shape. Only audio_fetch_failed
      // is retryable; every other 404 is a permanent no-audio answer.
      return body?.error === "audio_fetch_failed" ? "temporary" : "not_recorded";
    }
    return "temporary";
  } catch {
    return "temporary";
  }
}
