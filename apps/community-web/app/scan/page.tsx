"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { API_URL, api, getAccessToken } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Dialog, Field, Icon, useToast } from "@/components/ui";
import type { PersonCard } from "@/components/graph/types";
import "@/components/crm/crm.css";

type Resolved = { person: PersonCard; relationship: { degree: number; connectionStatus: "none" | "pending_out" | "pending_in" | "connected" } };

export default function ScanPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(false);
  const [supported, setSupported] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manualLink, setManualLink] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [busy, setBusy] = useState(false);
  const [metOpen, setMetOpen] = useState(false);
  const [metEvent, setMetEvent] = useState("");
  const [metNote, setMetNote] = useState("");

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopCamera() {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }

  const resolveCode = useCallback(
    async (code: string) => {
      setBusy(true);
      try {
        const r = await api<Resolved>(`/qr/resolve?code=${encodeURIComponent(code)}`);
        setResolved(r);
      } catch (e: any) {
        toast(e?.message ?? "That doesn't look like a Loopcom Community code.", { kind: "err" });
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  async function startCamera() {
    if (!supported) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      scanningRef.current = true;
      setScanning(true);
      // BarcodeDetector isn't in the default TS DOM lib yet.
      const Detector = (window as any).BarcodeDetector;
      const detector = new Detector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!scanningRef.current) return;
        if (videoRef.current && videoRef.current.readyState >= 2) {
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length) {
              const value = codes[0].rawValue as string;
              stopCamera();
              await resolveCode(value);
              return;
            }
          } catch {
            /* keep trying on the next frame */
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't access the camera.", { kind: "err" });
    }
  }

  async function connect() {
    if (!resolved) return;
    setBusy(true);
    try {
      await api("/connections/request", { method: "POST", body: { personId: resolved.person.id } });
      setResolved((r) => (r ? { ...r, relationship: { ...r.relationship, connectionStatus: "pending_out" } } : r));
      toast("Request sent.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't send that request.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    if (!resolved) return;
    setBusy(true);
    try {
      await api(`/people/${resolved.person.id}/follow`, { method: "POST" });
      toast("Following.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't follow them.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function saveContact() {
    if (!resolved) return;
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_URL}/public/people/${resolved.person.username}/vcard`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error("Couldn't get their contact card.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${resolved.person.username}.vcf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that contact.", { kind: "err" });
    }
  }

  async function saveMetNote() {
    if (!resolved) return;
    setBusy(true);
    try {
      await api("/qr/met", { method: "POST", body: { personId: resolved.person.id, event: metEvent.trim() || undefined, note: metNote.trim() || undefined } });
      toast("Noted.");
      setMetOpen(false);
      setMetEvent("");
      setMetNote("");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that note.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResolved(null);
    setManualLink("");
  }

  return (
    <AppShell cols="narrow" title="Scan a code">
      {resolved ? (
        <div className="card" style={{ textAlign: "center" }}>
          <Link href={`/people/${resolved.person.username}`}>
            <Avatar name={resolved.person.name} assetId={resolved.person.avatarAssetId} size={64} />
          </Link>
          <b style={{ display: "block", marginTop: 8, fontSize: 16 }}>{resolved.person.name}</b>
          <p className="sm dim">{[resolved.person.headline, resolved.person.primaryOrg?.displayName].filter(Boolean).join(" · ")}</p>
          <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
            {resolved.relationship.connectionStatus === "none" ? (
              <Button kind="p" icon="plus" loading={busy} onClick={connect} data-testid="scan-connect">
                Connect
              </Button>
            ) : (
              <Button kind="" disabled data-testid="scan-connect-status">
                {resolved.relationship.connectionStatus === "connected" ? "Connected" : "Request sent"}
              </Button>
            )}
            <Button loading={busy} onClick={follow} data-testid="scan-follow">
              Follow
            </Button>
            <Button icon="dl" onClick={saveContact} data-testid="scan-save-contact">
              Save contact
            </Button>
            <Button icon="edit" onClick={() => setMetOpen(true)} data-testid="scan-add-note">
              Add note
            </Button>
          </div>
          <div style={{ marginTop: 14 }}>
            <Button small onClick={reset} data-testid="scan-again">
              Scan another
            </Button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ textAlign: "center" }}>
          {supported ? (
            <>
              <div style={{ borderRadius: 12, overflow: "hidden", background: "#000", aspectRatio: "1", maxWidth: 320, margin: "0 auto" }}>
                <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: scanning ? "block" : "none" }} />
              </div>
              {!scanning ? (
                <Button kind="p" icon="cam" onClick={startCamera} style={{ marginTop: 12 }} data-testid="scan-start-camera">
                  Start camera
                </Button>
              ) : (
                <Button style={{ marginTop: 12 }} onClick={stopCamera} data-testid="scan-stop-camera">
                  Stop
                </Button>
              )}
              <p className="sm dim" style={{ marginTop: 10 }}>
                Point your camera at a Loopcom Community QR code.
              </p>
            </>
          ) : (
            <>
              <Icon name="qr" size={40} />
              <p className="sm dim" style={{ marginTop: 8 }}>
                Your browser can't scan codes directly here. Paste the profile link instead.
              </p>
            </>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <input
              className="in"
              placeholder="Paste a Loopcom Community profile link"
              value={manualLink}
              onChange={(e) => setManualLink(e.target.value)}
              style={{ flex: 1 }}
              data-testid="scan-manual-input"
            />
            <Button kind="p" icon="link" loading={busy} disabled={!manualLink.trim()} onClick={() => resolveCode(manualLink.trim())} data-testid="scan-manual-submit">
              Look up
            </Button>
          </div>
        </div>
      )}

      <Dialog open={metOpen} onClose={() => setMetOpen(false)} title={`Note about ${resolved?.person.name ?? ""}`}>
        <Field label="Where did you meet? (optional)" htmlFor="scan-met-event">
          <input id="scan-met-event" className="in" value={metEvent} onChange={(e) => setMetEvent(e.target.value)} placeholder="e.g. Chamber mixer" data-testid="scan-met-event" />
        </Field>
        <Field label="Note (optional)" htmlFor="scan-met-note">
          <textarea id="scan-met-note" className="note-input" value={metNote} onChange={(e) => setMetNote(e.target.value)} data-testid="scan-met-note" />
        </Field>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button onClick={() => setMetOpen(false)}>Cancel</Button>
          <Button kind="p" loading={busy} onClick={saveMetNote} data-testid="scan-met-save">
            Save
          </Button>
        </div>
      </Dialog>
    </AppShell>
  );
}
