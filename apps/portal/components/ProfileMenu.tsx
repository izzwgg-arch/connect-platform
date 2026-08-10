"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { getWebRingerEnabled, setWebRingerEnabled } from "../hooks/telephonyAudioPreferences";
import { apiDelete, apiGet, apiPost, apiPut, apiUploadVoicemailGreeting, ApiError } from "../services/apiClient";
import { clearAuthSession } from "../services/session";
import { useSipPhone } from "../hooks/useSipPhone";
import { ViewportDropdown } from "./ViewportDropdown";
import { UserAvatarUpload } from "./UserAvatarUpload";
import { getPreferredUserDisplayName } from "../lib/userDisplayName";

type ControlPanelResponse = {
  extension: null | {
    id: string;
    tenantId: string;
    number: string;
    displayName: string;
    status: string;
  };
  presence: "AVAILABLE" | "RINGING" | "ON_CALL" | "DND" | "OFFLINE" | string;
  smsToEmail?: { enabled: boolean };
  vmEmail?: { enabled: boolean; includeTranscript: boolean };
  greeting: GreetingState;
};

type GreetingState = {
  status: "default" | "custom";
  durationSec: number | null;
  updatedAt: string | null;
  originalFilename: string | null;
  previewUrl: string | null;
  publishStatus: string;
  publishDetail: string | null;
};

const DEFAULT_GREETING: GreetingState = {
  status: "default",
  durationSec: null,
  updatedAt: null,
  originalFilename: null,
  previewUrl: null,
  publishStatus: "publish_unavailable",
  publishDetail: null,
};

const VM_RECORD_TERMINAL = new Set(["saved", "failed", "timeout", "cancelled"]);

type VmRecordJobStatus = {
  ok?: boolean;
  jobId?: string;
  state?: string;
  extension?: string;
  pbxTenantId?: string;
  greetingType?: string;
  pjsipEndpointHint?: string | null;
  callerSipEndpointRequested?: string | null;
  callerSipEndpointAccepted?: string | null;
  wake?: {
    sent?: boolean;
    registered?: boolean;
    registrationState?: string | null;
    devicesNotified?: number;
    waitedMs?: number;
    error?: string;
  };
  pjsipContactOk?: boolean | null;
  matchedEndpoints?: string[];
  diagAvailable?: boolean;
  diagBypassWithoutDiag?: boolean;
  dialplanRecordExitCode?: number | null;
  dialplanShowSnippet?: string | null;
  helperJobId?: string | null;
  helper?: Record<string, unknown> | null;
  verification?: { saved?: boolean; sha256?: string | null; updatedAt?: string | null; sizeBytes?: number | null } | null;
  error?: { code?: string; userMessage?: string; message?: string } | null;
};

function vmRecordStateLabel(state: string): string {
  switch (state) {
    case "preparing_call":
    case "waking_device":
    case "checking_registration":
    case "checking_endpoint":
      return "Calling…";
    case "calling_extension":
      return "Calling your devices…";
    case "answer_and_follow_prompts":
      return "Answer the call and follow the prompts";
    case "waiting_for_saved_greeting":
      return "Recording — press 1 on the call to save";
    case "saved":
      return "Saved successfully";
    case "failed":
      return "Failed";
    case "timeout":
      return "Timed out";
    case "cancelled":
      return "Cancelled";
    default:
      return "Calling…";
  }
}

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [dnd, setDnd] = useState(false);
  // Real phone-system DND for this user's own extension, read from and written
  // to the SAME proven M11 helper path the assistant uses. Never seeded from
  // the old localStorage mute — that flag meant "this tab", and promoting it
  // would silently start blocking real calls for anyone who had ever set it.
  const [extDnd, setExtDnd] = useState(false);
  const [extDndSupported, setExtDndSupported] = useState(false);
  const [extDndSaving, setExtDndSaving] = useState(false);
  const [extDndError, setExtDndError] = useState<string | null>(null);
  const [ringerOn, setRingerOn] = useState(true);
  const [smsToEmail, setSmsToEmail] = useState(false);
  const [smsToEmailSaving, setSmsToEmailSaving] = useState(false);
  const [vmEmail, setVmEmail] = useState(true);
  const [vmEmailTranscript, setVmEmailTranscript] = useState(true);
  const [vmEmailSaving, setVmEmailSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [recordingCall, setRecordingCall] = useState(false);
  const [vmRecordJob, setVmRecordJob] = useState<VmRecordJobStatus | null>(null);
  const [panelData, setPanelData] = useState<ControlPanelResponse | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const { user, tenant, theme, setTheme, setUserAvatarUrl } = useAppContext();
  const sipPhone = useSipPhone();
  const closeMenu = useCallback(() => setOpen(false), []);
  const displayName = getPreferredUserDisplayName(user);
  const extensionNumber = panelData?.extension?.number || user.extension || "Not assigned";
  // Presence now follows the REAL extension DND read back from the phone
  // system. It must never follow the browser mute: that flag means "this tab",
  // and showing "Do Not Disturb" for it told people their extension was
  // silenced when it was still ringing everywhere else.
  // (panelData.presence is still a hardcoded "AVAILABLE" server-side, so it
  // only ever contributes the default here.)
  const presence = extDndSupported && extDnd ? "DND" : panelData?.presence || user.presence || "AVAILABLE";
  const greeting = panelData?.greeting ?? DEFAULT_GREETING;
  const previewUrl = useMemo(() => withBrowserToken(greeting.previewUrl), [greeting.previewUrl]);

  useEffect(() => {
    setRingerOn(getWebRingerEnabled());
    if (typeof window !== "undefined") {
      setDnd(localStorage.getItem("cc-extension-dnd") === "1");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    apiGet<ControlPanelResponse>("/voice/extensions/me/control-panel")
      .then((data) => {
        if (active) setPanelData(data);
      })
      .catch(() => {
        if (active) setPanelData({ extension: null, presence: "OFFLINE", greeting: DEFAULT_GREETING });
      });
    apiGet<{ supported?: boolean; dnd?: boolean }>("/voice/extensions/me/dnd")
      .then((d) => {
        if (!active) return;
        setExtDndSupported(Boolean(d?.supported));
        setExtDnd(Boolean(d?.dnd));
        setExtDndError(null);
      })
      .catch(() => {
        // Hide the control rather than show a confident "off" — reporting DND
        // as off when we could not read it is how calls get silently blocked.
        if (active) setExtDndSupported(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) setVmRecordJob(null);
  }, [open]);

  useEffect(() => {
    if (panelData?.smsToEmail) setSmsToEmail(Boolean(panelData.smsToEmail.enabled));
    if (panelData?.vmEmail) {
      setVmEmail(panelData.vmEmail.enabled !== false);
      setVmEmailTranscript(panelData.vmEmail.includeTranscript !== false);
    }
  }, [panelData]);

  function logout() {
    clearAuthSession();
    router.replace("/login");
  }

  function updateDnd(next: boolean) {
    setDnd(next);
    if (typeof window !== "undefined") localStorage.setItem("cc-extension-dnd", next ? "1" : "0");
  }

  // Real extension DND. Optimistic, but corrected from the server's read-back —
  // the control must never claim a state the phone system did not confirm.
  async function updateExtDnd(next: boolean) {
    const previous = extDnd;
    setExtDnd(next);
    setExtDndSaving(true);
    setExtDndError(null);
    try {
      const r = await apiPost<{ dnd?: boolean; confirmed?: boolean }>("/voice/extensions/me/dnd", { dnd: next });
      setExtDnd(Boolean(r?.dnd));
      if (r && r.confirmed === false) {
        setExtDndError("Saved, but we couldn't read it back — check your phone before relying on it.");
      }
    } catch (e: any) {
      setExtDnd(previous);
      setExtDndError(e?.body?.message || e?.message || "Couldn't reach the phone system.");
    } finally {
      setExtDndSaving(false);
    }
  }

  function updateRinger(next: boolean) {
    setRingerOn(next);
    setWebRingerEnabled(next);
  }

  async function updateSmsToEmail(next: boolean) {
    const previous = smsToEmail;
    setSmsToEmail(next); // optimistic
    setSmsToEmailSaving(true);
    try {
      await apiPut("/voice/extensions/me/sms-to-email", { enabled: next });
    } catch {
      setSmsToEmail(previous); // revert on failure
    } finally {
      setSmsToEmailSaving(false);
    }
  }

  async function updateVmEmail(next: boolean) {
    const previous = vmEmail;
    setVmEmail(next); // optimistic
    setVmEmailSaving(true);
    try {
      await apiPut("/voice/extensions/me/voicemail-email", { enabled: next });
    } catch {
      setVmEmail(previous); // revert on failure
    } finally {
      setVmEmailSaving(false);
    }
  }

  async function updateVmEmailTranscript(next: boolean) {
    const previous = vmEmailTranscript;
    setVmEmailTranscript(next); // optimistic
    setVmEmailSaving(true);
    try {
      await apiPut("/voice/extensions/me/voicemail-email", { includeTranscript: next });
    } catch {
      setVmEmailTranscript(previous); // revert on failure
    } finally {
      setVmEmailSaving(false);
    }
  }

  async function refreshPanel() {
    const data = await apiGet<ControlPanelResponse>("/voice/extensions/me/control-panel");
    setPanelData(data);
  }

  async function uploadGreeting(file: File | null | undefined) {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "wav" && ext !== "mp3") {
      setUploadMessage("Use a WAV or MP3 file.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setUploadMessage("Greeting must be 8 MB or smaller.");
      return;
    }
    setUploading(true);
    setUploadMessage("Uploading and converting greeting...");
    try {
      const nextGreeting = await apiUploadVoicemailGreeting(file);
      setPanelData((current) => ({
        extension: current?.extension ?? null,
        presence: current?.presence ?? "AVAILABLE",
        greeting: {
          status: nextGreeting.status,
          durationSec: nextGreeting.durationSec,
          updatedAt: nextGreeting.updatedAt,
          originalFilename: nextGreeting.originalFilename,
          previewUrl: nextGreeting.previewUrl,
          publishStatus: nextGreeting.publishStatus,
          publishDetail: nextGreeting.publishDetail,
        },
      }));
      setUploadMessage("Greeting uploaded successfully.");
      await refreshPanel().catch(() => undefined);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Upload failed.";
      setUploadMessage(message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function resetGreeting() {
    setUploading(true);
    setUploadMessage("Resetting greeting...");
    try {
      const nextGreeting = await apiDelete<GreetingState & { ok: boolean }>("/voice/extensions/me/voicemail-greeting");
      setPanelData((current) => ({
        extension: current?.extension ?? null,
        presence: current?.presence ?? "AVAILABLE",
        greeting: {
          status: nextGreeting.status,
          durationSec: nextGreeting.durationSec,
          updatedAt: nextGreeting.updatedAt,
          originalFilename: nextGreeting.originalFilename,
          previewUrl: nextGreeting.previewUrl,
          publishStatus: nextGreeting.publishStatus,
          publishDetail: nextGreeting.publishDetail,
        },
      }));
      setUploadMessage("Default voicemail greeting restored.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Reset failed.";
      setUploadMessage(message);
    } finally {
      setUploading(false);
    }
  }

  async function callToRecordGreeting() {
    setRecordingCall(true);
    setVmRecordJob(null);
    setUploadMessage("Starting Call to Record…");
    try {
      const callerSipEndpoint = sipPhone.diag.sipUsername || undefined;
      const res = await apiPost<VmRecordJobStatus>(
        "/voicemail/greeting/record-call",
        { greetingType: "unavailable", callerSipEndpoint },
        undefined,
        { timeoutMs: 120_000 },
      );
      if (!res.jobId) {
        throw new ApiError("Server did not return a job id.", 500);
      }
      setVmRecordJob(res);
      setUploadMessage(vmRecordStateLabel(String(res.state || "preparing_call")));

      const jobId = res.jobId;
      while (true) {
        const st = await apiGet<VmRecordJobStatus>(`/voicemail/greeting/record-call/${encodeURIComponent(jobId)}`, undefined, {
          timeoutMs: 25_000,
        });
        setVmRecordJob(st);
        const state = String(st.state || "");
        if (VM_RECORD_TERMINAL.has(state)) {
          if (state === "saved") {
            setUploadMessage("Voicemail greeting saved on the PBX.");
            await refreshPanel().catch(() => undefined);
          } else if (state === "timeout") {
            setUploadMessage(st.error?.userMessage || "Timed out waiting for the new greeting file.");
          } else {
            setUploadMessage(st.error?.userMessage || st.error?.message || "Call to record did not complete.");
          }
          break;
        }
        setUploadMessage(vmRecordStateLabel(state));
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not start recording call.";
      setUploadMessage(message);
    } finally {
      setRecordingCall(false);
    }
  }

  // Support-only diagnostics: the vm-record job readout was built while we had
  // no visibility into the PBX. Customers see only the friendly status line;
  // set localStorage.ecpVmDebug = "1" in the console to bring the readout back.
  const showVmRecordDebug =
    typeof window !== "undefined" && window.localStorage?.getItem("ecpVmDebug") === "1";

  return (
    <div className="menu-wrap">
      <button ref={triggerRef} className="icon-btn profile-trigger" onClick={() => setOpen((v) => !v)} title={displayName}>
        <UserAvatarUpload name={displayName} avatarUrl={user.avatarUrl} size={28} className="profile-trigger-avatar" />
        <span className="profile-trigger-name">{displayName}</span>
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closeMenu} width={390} className="extension-control-panel">
        <section className="ecp-header" aria-label="Extension control panel header">
          <UserAvatarUpload
            name={displayName}
            avatarUrl={user.avatarUrl}
            size={52}
            editable
            onUploaded={setUserAvatarUrl}
            className="ecp-avatar"
          />
          <div className="ecp-identity">
            <div className="ecp-name">{displayName}</div>
            <div className="ecp-tenant">{tenant.name}</div>
            <div className="ecp-extension-row">
              <strong>Ext {extensionNumber}</strong>
              <span className={`ecp-status ${statusTone(presence)}`}>
                <span aria-hidden />
                {statusLabel(presence)}
              </span>
            </div>
          </div>
        </section>

        <section className="ecp-section" aria-label="Quick controls">
          <div className="ecp-section-title">Quick Controls</div>
          {/* ⛔ This is NOT the phone system's Do Not Disturb. It is a browser-only
              mute: it lives in localStorage, it is never sent anywhere, and it does
              not stop your desk phone or mobile from ringing. Real extension DND is
              written to the PBX by the assistant, and the two have never been
              connected — which is exactly why a trainer saw the assistant say "DND
              is off" while this switch stayed lit, and the reverse the next day.
              Calling both of them "DND" is what made that unexplainable, so this one
              says what it actually does. Wiring this control to real extension DND
              is a deliberate product decision, not a rename — it would start
              blocking real calls from a browser switch. */}
          {/* The REAL one: this writes your extension's DND on the phone system,
              through the same M11 helper path the assistant uses. Shown only
              when the tenant is actually linked to a PBX — a toggle that cannot
              reach the phone system is worse than no toggle. */}
          {extDndSupported ? (
            <>
              <ControlToggle
                label="Do Not Disturb"
                detail={extDnd ? "Your extension is not accepting calls" : "Stop calls to your extension, everywhere"}
                checked={extDnd}
                disabled={extDndSaving}
                onChange={updateExtDnd}
              />
              {extDndError ? (
                <div className="ecp-inline-error" role="alert" style={{ fontSize: 12, color: "var(--danger)", padding: "2px 0 6px" }}>
                  {extDndError}
                </div>
              ) : null}
            </>
          ) : null}
          <ControlToggle label="Mute this browser" detail="Stops calls ringing HERE only — not your phone system DND" checked={dnd} onChange={updateDnd} />
          <ControlToggle label="Ringer" detail="WebRTC incoming ring" checked={ringerOn} onChange={updateRinger} />
          <ControlToggle label="Theme" detail={theme === "dark" ? "Dark mode" : "Light mode"} checked={theme === "dark"} onChange={(next) => setTheme(next ? "dark" : "light")} />
          <ControlToggle label="SMS to Email" detail="Send my texts to my inbox" checked={smsToEmail} disabled={smsToEmailSaving} onChange={updateSmsToEmail} />
          <ControlToggle label="Email my voicemails" detail="Send each new voicemail to my email" checked={vmEmail} disabled={vmEmailSaving} onChange={updateVmEmail} />
          <ControlToggle label="Include the typed-out message" detail="Add the written text to the email" checked={vmEmailTranscript} disabled={vmEmailSaving || !vmEmail} onChange={updateVmEmailTranscript} />
        </section>

        <section className="ecp-section" aria-label="Voicemail greeting">
          <div className="ecp-section-head">
            <div>
              <div className="ecp-section-title">Voicemail Greeting</div>
              <div className="ecp-muted">{greeting.status === "custom" ? "Custom greeting active" : "Using default greeting"}</div>
            </div>
            <span className={`ecp-pill ${greeting.status === "custom" ? "success" : ""}`}>{greeting.status}</span>
          </div>

          {greeting.status === "custom" && previewUrl ? (
            <div className="ecp-player">
              <audio controls preload="none" src={previewUrl} />
              <span>{greeting.durationSec ? `${greeting.durationSec}s` : "Duration pending"}</span>
            </div>
          ) : null}

          <div
            className={`ecp-dropzone ${dragActive ? "active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              void uploadGreeting(event.dataTransfer.files?.[0]);
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              hidden
              onChange={(event) => void uploadGreeting(event.target.files?.[0])}
            />
            <button className="ecp-upload-btn" type="button" disabled={uploading || !panelData?.extension} onClick={() => fileInputRef.current?.click()}>
              {greeting.status === "custom" ? "Replace Greeting" : "Upload Greeting"}
            </button>
            <span>WAV or MP3, up to 8 MB</span>
          </div>

          {uploading ? <div className="ecp-progress"><span /></div> : null}
          {uploadMessage ? <div className="ecp-muted">{uploadMessage}</div> : null}
          {vmRecordJob && showVmRecordDebug ? (
            <div className="ecp-muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 6 }}>
              <div>
                <strong>Job</strong> {vmRecordJob.jobId}{" "}
                <span style={{ opacity: 0.85 }}>({vmRecordStateLabel(String(vmRecordJob.state || ""))})</span>
              </div>
              {vmRecordJob.extension ? (
                <div>
                  <strong>Extension</strong> {vmRecordJob.extension}
                  {vmRecordJob.pbxTenantId ? ` · PBX tenant ${vmRecordJob.pbxTenantId}` : null}
                  {vmRecordJob.pjsipEndpointHint ? ` · Hint ${vmRecordJob.pjsipEndpointHint}` : null}
                </div>
              ) : null}
              {(vmRecordJob.callerSipEndpointRequested != null || vmRecordJob.callerSipEndpointAccepted != null) ? (
                <div>
                  <strong>Caller endpoint</strong>{" "}
                  requested: {vmRecordJob.callerSipEndpointRequested || "—"}
                  {" · "}
                  accepted: {vmRecordJob.callerSipEndpointAccepted || "rejected"}
                </div>
              ) : null}
              {typeof vmRecordJob.helper?.channel === "string" ? (
                <div>
                  <strong>Helper channel</strong> {vmRecordJob.helper.channel}
                  {typeof vmRecordJob.helper?.channelSource === "string" ? ` (${vmRecordJob.helper.channelSource})` : null}
                </div>
              ) : null}
              {vmRecordJob.wake ? (
                <div>
                  <strong>Wake</strong> {vmRecordJob.wake.sent ? "sent" : "not sent"}
                  {vmRecordJob.wake.devicesNotified != null ? ` · ${vmRecordJob.wake.devicesNotified} device(s)` : null}
                  {vmRecordJob.wake.waitedMs != null ? ` · waited ${vmRecordJob.wake.waitedMs}ms` : null}
                  {vmRecordJob.wake.registered != null ? ` · SIP session: ${vmRecordJob.wake.registered ? "REGISTERED" : "not registered yet"}` : null}
                  {vmRecordJob.wake.registrationState ? ` (${vmRecordJob.wake.registrationState})` : null}
                  {vmRecordJob.wake.error ? ` · ${vmRecordJob.wake.error}` : null}
                </div>
              ) : null}
              {vmRecordJob.pjsipContactOk != null ? (
                <div>
                  <strong>PJSIP contacts</strong> {vmRecordJob.pjsipContactOk ? "reachable" : "none Avail"}
                  {vmRecordJob.matchedEndpoints?.length ? ` · ${vmRecordJob.matchedEndpoints.join(", ")}` : null}
                  {vmRecordJob.diagBypassWithoutDiag ? " · diag bypass (legacy)" : null}
                </div>
              ) : null}
              {vmRecordJob.helperJobId ? (
                <div>
                  <strong>PBX helper job</strong> {vmRecordJob.helperJobId}
                </div>
              ) : null}
              {typeof vmRecordJob.helper?.asteriskExitCode === "number" ? (
                <div>
                  <strong>Originate</strong> exit {String(vmRecordJob.helper.asteriskExitCode)}
                </div>
              ) : null}
              {typeof vmRecordJob.helper?.asteriskOutput === "string" && vmRecordJob.helper.asteriskOutput ? (
                <div style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto", opacity: 0.9 }}>
                  <strong>Last Asterisk output</strong>
                  {"\n"}
                  {String(vmRecordJob.helper.asteriskOutput).slice(-800)}
                </div>
              ) : null}
              {vmRecordJob.verification?.saved ? (
                <div>
                  <strong>Verified</strong> sha {vmRecordJob.verification.sha256?.slice(0, 12) ?? "—"}… ·{" "}
                  {vmRecordJob.verification.updatedAt ?? "—"}
                </div>
              ) : null}
              {vmRecordJob.dialplanShowSnippet ? (
                <div style={{ whiteSpace: "pre-wrap", maxHeight: 80, overflow: "auto", opacity: 0.85 }}>
                  <strong>Dialplan snippet</strong>
                  {"\n"}
                  {vmRecordJob.dialplanShowSnippet.slice(0, 600)}
                </div>
              ) : null}
            </div>
          ) : null}
          {greeting.publishDetail ? <div className="ecp-warning">{greeting.publishDetail}</div> : null}
          <div className="ecp-actions-row">
            <button className="ecp-secondary-btn" type="button" disabled={!previewUrl} onClick={() => previewUrl && window.open(previewUrl, "_blank", "noopener,noreferrer")}>Play</button>
            <button className="ecp-secondary-btn danger-soft" type="button" disabled={uploading || greeting.status !== "custom"} onClick={() => void resetGreeting()}>Reset to Default</button>
            <button className="ecp-secondary-btn" type="button" disabled={uploading || recordingCall || !panelData?.extension} onClick={() => void callToRecordGreeting()}>
              {recordingCall ? "Calling..." : "Call to Record"}
            </button>
          </div>
        </section>

        <section className="ecp-logout">
          <button className="ecp-logout-btn" onClick={logout}>Logout</button>
        </section>
      </ViewportDropdown>
    </div>
  );
}

function ControlToggle({ label, detail, checked, onChange, disabled }: { label: string; detail: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button className="ecp-toggle-row" type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span className={`ecp-switch ${checked ? "on" : ""}`} aria-hidden><span /></span>
    </button>
  );
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("available")) return "available";
  if (normalized.includes("ring")) return "ringing";
  if (normalized.includes("dnd") || normalized.includes("offline")) return "danger";
  return "busy";
}

function statusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("dnd")) return "Do Not Disturb";
  if (normalized.includes("ring")) return "Ringing";
  if (normalized.includes("on_call")) return "On Call";
  if (normalized.includes("offline")) return "Offline";
  return "Available";
}

function withBrowserToken(url: string | null): string | null {
  if (!url || typeof window === "undefined") return url;
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
