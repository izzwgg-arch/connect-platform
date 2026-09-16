"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPortalApiBaseUrl } from "../../../services/apiClient";

/**
 * The customer's desk-phone scan page — opened from a link we text or email.
 *
 * ⛔ PUBLIC BY TOKEN. There is no sign-in and no Bearer token: the token in the URL
 * is the whole credential and the api re-checks it on every request. So this file
 * calls the api with plain fetch against the public base URL, never the authenticated
 * client, and shows only what the api's customer projection returns.
 *
 * ⛔ THE CAMERA DOES NOT DECODE ANYTHING HERE. It grabs a frame and posts it; the
 * server reads the barcodes with the same engine and the same one gate that the
 * typed, uploaded and texted doors already go through. That keeps one set of rules
 * for what may be attached to a phone, and means an old browser is not a dead end.
 */

type Phone = {
  id: string;
  mac: string | null;
  model: string | null;
  vendor: string | null;
  displayName: string | null;
  extNumber: string | null;
  done: boolean;
};

type Order = { company: string | null; total: number; scanned: number; phones: Phone[] };
type Matched = { phone: Phone; makerLabel: string | null; total: number; scanned: number };

/**
 * A SCANNER, NOT A PHOTOGRAPHER (Izzy, 2026-09-16: "It needs to scan very efficiently
 * right away"). The first build posted ONE JPEG every 1.5s to the server and asked the
 * camera for nothing - on most phones that reads as "it doesn't scan". Now the SAME zxing
 * engine the server uses runs on-device against a centre crop several times a second, the
 * camera is asked for continuous focus + 1080p, and only the decoded TEXT crosses the wire.
 * The server stays the ONLY judge: it re-shapes, re-parses and gates the values exactly
 * like every other door - the browser just reads faster.
 */
const DECODE_EVERY_MS = 140;
/** Never repeat an identical decode's post more often than this. */
const POST_EVERY_MS = 700;
/** Fallback cadence for a browser whose decode engine cannot load: photo -> server. */
const SCAN_EVERY_MS = 1500;
/** "Not readable yet" states - normal while someone lines the camera up; never shown. */
const SILENT_SCAN_ERRORS = new Set(["photo_unreadable", "nothing_matched_yet"]);

export default function PhoneSetupPage({ params }: { params: { token: string } }) {
  const token = String(params?.token ?? "");
  const base = `${getPortalApiBaseUrl()}/phone-setup/${encodeURIComponent(token)}`;

  const [order, setOrder] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "camera" | "matched" | "typed">("list");
  const [matched, setMatched] = useState<Matched | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typedFor, setTypedFor] = useState<Phone | null>(null);
  const [typedText, setTypedText] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);
  const decodeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  /** On-device decoder once its wasm is up; null = fall back to photo posts. */
  const decodeRef = useRef<((img: ImageData) => Promise<string[]>) | null>(null);
  const decodeBusy = useRef(false);
  const lastPostRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(base, { headers: { accept: "application/json" } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.ok) {
        setLoadError(body?.message || "This link is no longer active. Ask Loopcom for a new one.");
        return;
      }
      setOrder({ company: body.company ?? null, total: body.total ?? 0, scanned: body.scanned ?? 0, phones: body.phones ?? [] });
      setLoadError(null);
    } catch {
      setLoadError("We couldn't reach Loopcom just now. Check your signal and try again.");
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const stopCamera = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (decodeTimerRef.current) { clearInterval(decodeTimerRef.current); decodeTimerRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
    setTorchAvailable(false); setTorchOn(false);
  }, []);
  useEffect(() => stopCamera, [stopCamera]);

  /** One place decides what a scan answer means, whichever door carried it. */
  const applyScanOutcome = useCallback((httpOk: boolean, body: any): boolean => {
    if (httpOk && body?.ok && body?.matched) {
      stopCamera();
      setMatched({ phone: body.phone, makerLabel: body.makerLabel ?? null, total: body.total, scanned: body.scanned });
      setOrder((o) => (o ? { ...o, scanned: body.scanned, total: body.total } : o));
      setProblem(null);
      setView("matched");
      void load();
      return true;
    }
    if (body?.error && !SILENT_SCAN_ERRORS.has(String(body.error))) setProblem(body.message || null);
    return false;
  }, [load, stopCamera]);

  /** Decoded symbol values -> the server's gate. The text is the payload, never a picture. */
  const postTexts = useCallback(async (texts: string[]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await fetch(`${base}/scan-text`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      const body = await r.json().catch(() => ({}));
      applyScanOutcome(r.ok, body);
    } catch {
      /* a dropped post is not an error; the next decode tries again */
    } finally {
      inFlight.current = false;
    }
  }, [base, applyScanOutcome]);

  /** ~7 attempts a second on the centre of the frame - where the reticle points. */
  const decodeTick = useCallback(async () => {
    const video = videoRef.current, decode = decodeRef.current;
    if (!video || !decode || decodeBusy.current || video.readyState < 2) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    decodeBusy.current = true;
    try {
      const cw = Math.round(w * 0.72), ch = Math.round(h * 0.46);
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
      const values = await decode(ctx.getImageData(0, 0, cw, ch));
      if (!values.length) return;
      const key = [...values].sort().join("|");
      const now = Date.now();
      if (key === lastPostRef.current.key && now - lastPostRef.current.at < POST_EVERY_MS) return;
      lastPostRef.current = { key, at: now };
      await postTexts(values.slice(0, 8));
    } catch {
      /* one bad frame is nothing; the next tick tries again */
    } finally {
      decodeBusy.current = false;
    }
  }, [postTexts]);

  /** FALLBACK ONLY (no wasm): one frame -> the server decodes, as the first build did. */
  const sendFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || inFlight.current || video.readyState < 2) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    inFlight.current = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
      if (!blob) return;
      const form = new FormData();
      form.append("file", blob, "scan.jpg");
      const r = await fetch(`${base}/scan`, { method: "POST", body: form });
      const body = await r.json().catch(() => ({}));
      applyScanOutcome(r.ok, body);
    } catch {
      /* A dropped frame is not an error; the next tick tries again. */
    } finally {
      inFlight.current = false;
    }
  }, [base, applyScanOutcome]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch { /* no light is fine; the button just did nothing */ }
  }, [torchOn]);

  const startCamera = useCallback(async () => {
    setProblem(null); setView("camera");
    try {
      // 1080p + continuous focus is what makes a sticker at reading distance sharp.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      if (track) {
        // Non-standard capabilities, applied only where the phone admits them -
        // a camera that refuses simply stays on its defaults.
        const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
        const advanced: Record<string, unknown>[] = [];
        if (Array.isArray(caps.focusMode) && (caps.focusMode as string[]).includes("continuous")) {
          advanced.push({ focusMode: "continuous" });
        }
        if (advanced.length) await track.applyConstraints({ advanced } as MediaTrackConstraints).catch(() => {});
        setTorchAvailable(Boolean((caps as { torch?: boolean }).torch));
      }
      // The on-device engine: same zxing the server runs, wasm served from our own origin.
      if (!decodeRef.current) {
        try {
          const zxing = await import("zxing-wasm/reader");
          zxing.prepareZXingModule({
            overrides: {
              locateFile: (path: string, prefix: string) =>
                path.endsWith(".wasm") ? "/zxing/zxing_reader.wasm" : prefix + path,
            },
          });
          decodeRef.current = async (img: ImageData) => {
            const results = await zxing.readBarcodes(img, {
              tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 8,
            });
            return (results ?? []).map((r) => String(r?.text ?? "").trim()).filter((v) => v.length > 0);
          };
        } catch {
          decodeRef.current = null; // old browser: the photo fallback below still works
        }
      }
      if (decodeRef.current) {
        decodeTimerRef.current = setInterval(() => { void decodeTick(); }, DECODE_EVERY_MS);
      } else {
        timerRef.current = setInterval(() => { void sendFrame(); }, SCAN_EVERY_MS);
      }
    } catch {
      stopCamera();
      setView("list");
      setProblem("We couldn't open the camera. Allow camera access, or type the numbers instead.");
    }
  }, [decodeTick, sendFrame, stopCamera]);

  const submitTyped = useCallback(async () => {
    if (!typedFor || !typedText.trim()) return;
    setBusy(true); setProblem(null);
    try {
      const r = await fetch(`${base}/phones/${encodeURIComponent(typedFor.id)}/label`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: typedText.trim() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.ok) { setProblem(body?.message || "That couldn't be saved. Check the numbers and try again."); return; }
      setTypedText(""); setTypedFor(null); setView("list"); await load();
    } catch {
      setProblem("We couldn't reach Loopcom just now. Try again in a moment.");
    } finally { setBusy(false); }
  }, [base, typedFor, typedText, load]);

  function toggleTheme() {
    const shell = document.querySelector(".ps-shell");
    if (!shell) return;
    const now = shell.getAttribute("data-ps-theme");
    const next = now === "light" ? "dark" : "light";
    shell.setAttribute("data-ps-theme", next);
    try { window.localStorage.setItem("ps-theme", next); } catch { /* blocked storage is fine */ }
  }

  const Header = (
    <div className="ps-top">
      <img className="ps-logo" src="/brand/loopcom/loopcom-wordmark-560.png" alt="Loopcom" width={560} height={99} />
      <button type="button" className="ps-theme" onClick={toggleTheme}>Light / dark</button>
    </div>
  );

  if (loadError) {
    return (
      <div className="ps-wrap">
        {Header}
        <div className="ps-card">
          <h1 className="ps-h1">This link isn&rsquo;t active</h1>
          <p className="ps-sub">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!order) {
    return <div className="ps-wrap">{Header}<div className="ps-card"><p className="ps-sub">Loading your phones&hellip;</p></div></div>;
  }

  const remaining = order.total - order.scanned;

  return (
    <div className="ps-wrap">
      {Header}

      {view === "camera" && (
        <div className="ps-card">
          <div className="ps-cam">
            <video ref={videoRef} playsInline muted />
            <div className="ps-reticle"><i /><i /><i /><i /></div>
            <span className="ps-chip">{remaining > 0 ? `${order.scanned + 1} of ${order.total}` : "All scanned"}</span>
            <p className="ps-camhint">Hold it about 6 inches from the sticker &mdash; it scans by itself</p>
          </div>
          {problem && <div className="ps-note" data-kind="bad">{problem}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            {torchAvailable && (
              <button type="button" className="ps-btn ghost" style={{ flex: 1 }} onClick={() => { void toggleTorch(); }}>
                {torchOn ? "Light off" : "Light on"}
              </button>
            )}
            <button type="button" className="ps-btn ghost" style={{ flex: 2 }} onClick={() => { stopCamera(); setView("list"); }}>Stop scanning</button>
          </div>
        </div>
      )}

      {view === "matched" && matched && (
        <div className="ps-card">
          <div className="ps-burst">&#10003;</div>
          <h1 className="ps-h1">
            Got it{matched.phone.displayName ? ` — that’s your ${matched.phone.displayName} phone` : ""}
          </h1>
          {matched.phone.extNumber && (
            <div className="ps-dest"><span>&rarr;</span><span>Goes to <b>Extension {matched.phone.extNumber}</b></span></div>
          )}
          <div className="ps-idcard">
            {matched.makerLabel && <div className="ps-idrow"><span>Make</span><b>{matched.makerLabel}{matched.phone.model ? ` ${matched.phone.model}` : ""}</b></div>}
            {matched.phone.mac && <div className="ps-idrow"><span>Address</span><b>{matched.phone.mac}</b></div>}
          </div>
          <p className="ps-sub">
            {matched.total - matched.scanned > 0
              ? `${matched.total - matched.scanned} ${matched.total - matched.scanned === 1 ? "phone" : "phones"} left.`
              : "That was the last one."}
          </p>
          {matched.total - matched.scanned > 0
            ? <button type="button" className="ps-btn" onClick={() => { void startCamera(); }}>Scan the next one</button>
            : <button type="button" className="ps-btn" onClick={() => setView("list")}>See all my phones</button>}
          <button type="button" className="ps-btn ghost" onClick={() => setView("list")}>Finish later</button>
        </div>
      )}

      {view === "typed" && typedFor && (
        <div className="ps-card">
          <h1 className="ps-h1">Type what the sticker says</h1>
          <p className="ps-sub">
            It&rsquo;s the white label under the {typedFor.displayName || "phone"}. Type both lines &mdash; the address and the serial number.
          </p>
          <div className="ps-field">
            <label htmlFor="ps-typed">From the sticker</label>
            <textarea
              id="ps-typed" className="ps-input" rows={3} value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder={"MAC 805EC0B3B2D0\n2142019121401463"}
            />
          </div>
          {problem && <div className="ps-note" data-kind="bad">{problem}</div>}
          <button type="button" className="ps-btn" disabled={busy || !typedText.trim()} onClick={() => { void submitTyped(); }}>
            {busy ? "Saving…" : "Save this phone"}
          </button>
          <button type="button" className="ps-btn ghost" onClick={() => { setTypedFor(null); setProblem(null); setView("list"); }}>Back</button>
        </div>
      )}

      {view === "list" && (
        <div className="ps-card">
          <h1 className="ps-h1">
            {remaining > 0
              ? `Let’s set up your ${order.total} desk ${order.total === 1 ? "phone" : "phones"}`
              : "Every sticker is scanned"}
          </h1>
          <p className="ps-sub">
            {/* ⛔ HONEST WORDS ONLY (Izzy, 2026-09-16). This page knows about STICKERS, not
                whether a phone is working — "All your phones are ready" here was the
                unconditional-tick lie all over again, shown to a customer whose phone was
                sitting on a halt screen. A serial on file means we have what the sticker
                says; the setting-up still happens on our side. */}
            {remaining > 0
              ? "Scan the sticker under each phone. We’ll do the rest."
              : "That’s everything we needed from the stickers. Setup continues on our side — you can still scan a phone if another one arrives."}
          </p>
          {order.company && <p className="ps-sub">{order.company}</p>}

          <div className="ps-rows">
            {order.phones.map((p) => (
              <div className="ps-row" key={p.id} data-done={p.done ? "true" : "false"}>
                <span className="ps-tick" data-done={p.done ? "true" : "false"}>{p.done ? "✓" : "·"}</span>
                <span className="ps-lbl">
                  <b>{p.displayName || p.model || "Desk phone"}</b>
                  <span>{p.extNumber ? `Extension ${p.extNumber}` : "Not assigned yet"}{p.mac ? ` · ${p.mac}` : ""}</span>
                </span>
                {!p.done && (
                  <button type="button" className="ps-theme" onClick={() => { setTypedFor(p); setProblem(null); setView("typed"); }}>Type it</button>
                )}
              </div>
            ))}
          </div>

          {problem && <div className="ps-note" data-kind="bad">{problem}</div>}
          {/* ⛔⛔ THE CAMERA IS NEVER HIDDEN (Izzy, 2026-09-16, opening his own link: "Never got
              a camera or anything to scan"). With every serial already on file, this page used
              to offer NOTHING — on the one page whose entire job is the camera. Scanning is
              always allowed: a replacement phone, a re-check, a phone they are not sure about.
              The server's one gate still judges every frame exactly as before. */}
          <button type="button" className="ps-btn" onClick={() => { void startCamera(); }}>
            {remaining > 0 ? "Scan a phone" : "Scan another phone"}
          </button>
        </div>
      )}

      <p className="ps-foot">Loopcom &middot; we only ever read the sticker, never a photo of anything else.</p>
    </div>
  );
}
