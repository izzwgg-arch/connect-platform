"use client";

/**
 * Play a written answer out loud (2026-08-21).
 *
 * Izzy: *"Can you make it so that I can play the output as audio?"* — the
 * server synthesises with ElevenLabs and hands back mp3 bytes; this hook owns
 * the browser half.
 *
 * ⛔⛔ THE MEDIA TRAPS THIS REPO HAS ALREADY PAID FOR, all of which present as
 * "the button does nothing":
 *   • CONTENT TYPE — never trust the type on bytes you were handed. The Blob
 *     is rebuilt with an explicit `audio/mpeg`; ElevenLabs' own CDN has served
 *     audio labelled `text/plain` before now, and `<audio>` silently declines
 *     to decode it with no error anywhere.
 *   • CSP — `media-src 'self' blob: data:` is what makes an object URL play at
 *     all. It was missing platform-wide until 2026-08-19 and every blob player
 *     in the portal was dead. If playback stops working everywhere at once,
 *     check the nginx security headers before reading a line of this file.
 *   • OBJECT URLS LEAK — one per play, revoked on stop, on replace and on
 *     unmount.
 *   • play() RETURNS A PROMISE THAT CAN REJECT (autoplay policy, decode
 *     failure). An unhandled rejection here is a button that does nothing and
 *     says nothing, so the reason is surfaced.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiPostBlob, ApiError } from "../services/apiClient";

export interface SpeakController {
  /** id of the message currently being fetched from the server, if any. */
  loadingId: string | null;
  /** id of the message currently playing, if any. */
  playingId: string | null;
  /** Plain-English failure, or null. */
  error: string | null;
  /** True when the last thing played was shortened to fit the length cap. */
  truncated: boolean;
  speak: (id: string, text: string) => Promise<void>;
  stop: () => void;
}

export function useSpeakText(): SpeakController {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  /** Guards against a slow response landing after the user asked for another. */
  const wantRef = useRef<string | null>(null);

  const teardown = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    wantRef.current = null;
    teardown();
    setPlayingId(null);
    setLoadingId(null);
  }, [teardown]);

  useEffect(() => () => teardown(), [teardown]);

  const speak = useCallback(
    async (id: string, text: string) => {
      // Clicking the button of the message that is already playing stops it.
      if (playingId === id) {
        stop();
        return;
      }
      stop();
      setError(null);
      setTruncated(false);
      wantRef.current = id;
      setLoadingId(id);

      try {
        const { blob, headers } = await apiPostBlob("/admin/support/speak", { text });
        // The user moved on while this was in flight — drop it rather than
        // surprising them with audio they no longer asked for.
        if (wantRef.current !== id) return;

        // ⛔ Rebuild with an explicit audio type; see the header.
        const bytes = await blob.arrayBuffer();
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
        urlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          setPlayingId(null);
          teardown();
        };
        audio.onerror = () => {
          setPlayingId(null);
          setError("The audio came back but this browser wouldn't play it.");
          teardown();
        };

        setTruncated(headers.get("X-Speak-Truncated") === "1");
        setLoadingId(null);
        await audio.play();
        if (wantRef.current !== id) return;
        setPlayingId(id);
      } catch (e: unknown) {
        setLoadingId(null);
        setPlayingId(null);
        teardown();
        if (e instanceof ApiError) {
          // The server's own sentence is the useful one — it knows whether the
          // key is missing, the text was empty, or the provider refused.
          setError(e.message || "Couldn't read that out.");
        } else if (e instanceof Error && e.name === "NotAllowedError") {
          setError("The browser blocked playback — click play again.");
        } else {
          setError("Couldn't read that out.");
        }
      }
    },
    [playingId, stop, teardown],
  );

  return { loadingId, playingId, error, truncated, speak, stop };
}
