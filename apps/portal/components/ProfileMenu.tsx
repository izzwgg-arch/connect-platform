"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useId } from "react";
import { ChevronDown, ChevronRight, LogOut, Moon, Phone, ShieldCheck, Sun, Upload, Voicemail, X } from "lucide-react";
import { useProfileDnd } from "./useProfileDnd";
import { dndUnavailableMessage } from "./profileDnd";
import "./profile-menu.css";
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
  const [section, setSection] = useState<"quick" | "voicemail">("quick");
  const [panelStatus, setPanelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [panelRetry, setPanelRetry] = useState(0);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const menuId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
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
  const closeMenu = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const displayName = getPreferredUserDisplayName(user);
  const phoneDnd = useProfileDnd(open, `${user.id}:${tenant.id}`);
  const extensionNumber = panelData?.extension?.number;
  const canEditGreeting = panelStatus === "ready" && Boolean(panelData?.extension) && !uploading && !recordingCall;
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
    setPanelStatus("loading");
    setPanelData(null);
    setPreferenceError(null);
    apiGet<ControlPanelResponse>("/voice/extensions/me/control-panel")
      .then((data) => {
        if (active) { setPanelData(data); setPanelStatus("ready"); }
      })
      .catch(() => {
        if (active) { setPanelData(null); setPanelStatus("error"); }
      });
    return () => { active = false; };
  }, [open, user.id, tenant.id, panelRetry]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
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

  function updateRinger(next: boolean) {
    setRingerOn(next);
    setWebRingerEnabled(next);
  }

  async function updateSmsToEmail(next: boolean) {
    const previous = smsToEmail;
    setSmsToEmail(next); // optimistic
    setSmsToEmailSaving(true);
    setPreferenceError(null);
    try {
      await apiPut("/voice/extensions/me/sms-to-email", { enabled: next });
    } catch {
      setSmsToEmail(previous); // revert on failure
      setPreferenceError("Couldn’t save text-message emails. Please try again.");
    } finally {
      setSmsToEmailSaving(false);
    }
  }

  async function updateVmEmail(next: boolean) {
    const previous = vmEmail;
    setVmEmail(next); // optimistic
    setVmEmailSaving(true);
    setPreferenceError(null);
    try {
      await apiPut("/voice/extensions/me/voicemail-email", { enabled: next });
    } catch {
      setVmEmail(previous); // revert on failure
      setPreferenceError("Couldn’t save voicemail emails. Please try again.");
    } finally {
      setVmEmailSaving(false);
    }
  }

  async function updateVmEmailTranscript(next: boolean) {
    const previous = vmEmailTranscript;
    setVmEmailTranscript(next); // optimistic
    setVmEmailSaving(true);
    setPreferenceError(null);
    try {
      await apiPut("/voice/extensions/me/voicemail-email", { includeTranscript: next });
    } catch {
      setVmEmailTranscript(previous); // revert on failure
      setPreferenceError("Couldn’t save the transcription preference. Please try again.");
    } finally {
      setVmEmailSaving(false);
    }
  }

  async function refreshPanel() {
    const data = await apiGet<ControlPanelResponse>("/voice/extensions/me/control-panel");
    setPanelData(data);
  }

  async function uploadGreeting(file: File | null | undefined) {
    if (!file || !canEditGreeting) return;
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
        ...current,
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
    if (!canEditGreeting || greeting.status !== "custom") return;
    setUploading(true);
    setUploadMessage("Resetting greeting...");
    try {
      const nextGreeting = await apiDelete<GreetingState & { ok: boolean }>("/voice/extensions/me/voicemail-greeting");
      setPanelData((current) => ({
        ...current,
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
    if (!canEditGreeting) return;
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

  function selectSection(next: "quick" | "voicemail", focus = false) {
    setSection(next);
    if (focus) document.getElementById(`${menuId}-${next}-tab`)?.focus();
  }

  return (
    <div className="menu-wrap">
      <button ref={triggerRef} type="button" className="icon-btn profile-trigger" onClick={() => setOpen((v) => !v)}
        title={displayName} aria-label={`Personal settings for ${displayName}`} aria-expanded={open} aria-controls={menuId}>
        <UserAvatarUpload name={displayName} avatarUrl={user.avatarUrl} size={28} className="profile-trigger-avatar" />
        <span className="profile-trigger-name">{displayName}</span><ChevronDown size={14} aria-hidden />
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closeMenu} width={430} observeContent className="extension-control-panel profile-menu">
        <div id={menuId} aria-label="Personal settings" role="region">
          <header className="pm-header">
            <UserAvatarUpload name={displayName} avatarUrl={user.avatarUrl} size={48} editable onUploaded={setUserAvatarUrl} className="pm-avatar" />
            <div className="pm-identity">
              <div className="pm-name">{displayName}</div>
              <div className="pm-muted">{tenant.name}</div>
              <div className="pm-extension">{panelStatus === "loading" ? "Loading extension…" : panelStatus === "error" ? "Extension unavailable" : extensionNumber ? `Extension ${extensionNumber}` : "No extension assigned"}</div>
            </div>
            <button ref={closeRef} type="button" className="pm-close" aria-label="Close personal settings" onClick={closeMenu}><X size={17} aria-hidden /></button>
          </header>
          <div className="pm-tabs" role="tablist" aria-label="Personal settings sections">
            {(["quick", "voicemail"] as const).map((tab) => (
              <button type="button" key={tab} id={`${menuId}-${tab}-tab`} role="tab" aria-selected={section === tab}
                aria-controls={`${menuId}-${tab}`} tabIndex={section === tab ? 0 : -1}
                onClick={() => selectSection(tab)} onKeyDown={(event) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    selectSection(event.key === "Home" ? "quick" : event.key === "End" ? "voicemail" : tab === "quick" ? "voicemail" : "quick", true);
                  }
                }}>{tab === "quick" ? "Quick settings" : "Voicemail"}</button>
            ))}
          </div>
          {panelStatus === "error" ? <div className="pm-notice" role="alert">Couldn’t load your account preferences. <button type="button" className="pm-link" onClick={() => setPanelRetry((n) => n + 1)}>Retry</button></div> : null}
          <div className="pm-content" id={`${menuId}-quick`} role="tabpanel" aria-labelledby={`${menuId}-quick-tab`} hidden={section !== "quick"}>
            <section className="pm-section" aria-labelledby={`${menuId}-calls`}>
              <h3 id={`${menuId}-calls`}>Calls</h3>
              {phoneDnd.state.status === "ready" ? (
                <ControlToggle label="Do Not Disturb" detail={phoneDnd.state.enabled ? "On · Your extension is not accepting calls." : "Off · Stop calls to your extension on every device."}
                  checked={phoneDnd.state.enabled} onChange={phoneDnd.change} />
              ) : (
                <div className="pm-setting-row" aria-live="polite" aria-busy={phoneDnd.state.status === "loading" || phoneDnd.state.status === "saving"}>
                  <div><strong>Do Not Disturb</strong><small>{phoneDnd.state.status === "loading" ? "Checking your phone-system status…" : phoneDnd.state.status === "saving" ? "Updating your extension on every device…" : dndUnavailableMessage(phoneDnd.state.reason)}</small></div>
                  <span className="pm-state">{phoneDnd.state.status === "loading" ? "Checking…" : phoneDnd.state.status === "saving" ? "Saving…" : "Unavailable"}</span>
                </div>
              )}
              {phoneDnd.error ? <div className="pm-error" role="alert">{phoneDnd.error}</div> : null}
              {phoneDnd.state.status === "unavailable" ? <button type="button" className="pm-link" onClick={() => void phoneDnd.refresh()}>Check status again</button> : null}
              <ControlToggle label="Mute this browser" detail="Other devices keep ringing." checked={dnd} onChange={updateDnd} />
              <ControlToggle label="Incoming call sound" detail="Play a ringtone in this browser." checked={ringerOn} onChange={updateRinger} />
            </section>
            <section className="pm-section"><h3>Appearance</h3><div className="pm-appearance"><strong>Theme</strong><div className="pm-theme" role="group" aria-label="Theme">
              <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Sun size={15} aria-hidden />Light</button>
              <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Moon size={15} aria-hidden />Dark</button>
            </div></div></section>
            <section className="pm-section"><h3>Messages</h3><ControlToggle label="Email my text messages" detail="Send a copy to my account email." checked={smsToEmail} disabled={smsToEmailSaving || panelStatus !== "ready"} onChange={updateSmsToEmail} /></section>
          </div>
          <div className="pm-content" id={`${menuId}-voicemail`} role="tabpanel" aria-labelledby={`${menuId}-voicemail-tab`} hidden={section !== "voicemail"}>
            <section className="pm-section"><h3>Email delivery</h3>
              <ControlToggle label="Email my voicemails" detail="Send new voicemails to my account email." checked={vmEmail} disabled={vmEmailSaving || !panelData?.extension || panelStatus !== "ready"} onChange={updateVmEmail} />
              <div className="pm-dependent"><ControlToggle label="Include transcription in email" detail={vmEmail ? "Add the written text to the voicemail email." : "Turn on voicemail emails to include transcription."} checked={vmEmailTranscript} disabled={vmEmailSaving || !vmEmail || !panelData?.extension || panelStatus !== "ready"} onChange={updateVmEmailTranscript} /></div>
            </section>
            <section className="pm-section" aria-label="Voicemail greeting"><h3>Greeting</h3>
              <div className="pm-greeting-head"><span className="pm-greeting-icon"><Voicemail size={19} aria-hidden /></span><div><strong>{panelStatus === "loading" ? "Loading greeting…" : !panelData?.extension ? "Greeting unavailable" : greeting.status === "custom" ? "Custom greeting" : "Default greeting"}</strong><small>{panelData?.extension ? (greeting.originalFilename || "Upload an audio file or record by phone.") : "No extension is linked to this account."}</small></div></div>
              {panelStatus === "ready" && !panelData?.extension ? <div className="pm-notice">Ask your administrator to assign an extension to manage voicemail delivery and your greeting.</div> : null}
              {greeting.status === "custom" && previewUrl ? <div className="ecp-player"><audio controls preload="none" src={previewUrl} aria-label="Voicemail greeting" /><span>{greeting.durationSec ? `${greeting.durationSec}s` : "Duration pending"}</span></div> : null}
              <div className={`pm-greeting-upload ${dragActive ? "active" : ""}`} onDragOver={(event) => { event.preventDefault(); if (canEditGreeting) setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={(event) => { event.preventDefault(); setDragActive(false); if (canEditGreeting) void uploadGreeting(event.dataTransfer.files?.[0]); }}>
                <input ref={fileInputRef} type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" hidden onChange={(event) => void uploadGreeting(event.target.files?.[0])} />
                <div className="pm-actions">
                  <button className="pm-action pm-primary" type="button" disabled={!canEditGreeting} onClick={() => fileInputRef.current?.click()}><Upload size={15} aria-hidden />{greeting.status === "custom" ? "Replace audio" : "Upload audio"}</button>
                  <button className="pm-action" type="button" disabled={!canEditGreeting} onClick={() => void callToRecordGreeting()}><Phone size={15} aria-hidden />{recordingCall ? "Calling…" : "Call to record"}</button>
                  {greeting.status === "custom" ? <button className="pm-action" type="button" disabled={!canEditGreeting} onClick={() => void resetGreeting()}>Reset to default</button> : null}
                </div><p className="pm-hint">WAV or MP3 · Up to 8 MB</p>
              </div>
              {uploading ? <div className="ecp-progress"><span /></div> : null}
              {uploadMessage ? <div className="pm-muted" role="status">{uploadMessage}</div> : null}
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
            </section>
          </div>
          {preferenceError ? <div className="pm-error pm-save-error" role="alert">{preferenceError}</div> : null}
          <footer className="pm-footer">
            <button type="button" onClick={() => { closeMenu(); router.push("/account/security"); }}><ShieldCheck size={17} aria-hidden /><span>Security &amp; two-step verification</span><ChevronRight size={16} aria-hidden /></button>
            <button type="button" onClick={logout}><LogOut size={17} aria-hidden /><span>Sign out</span></button>
          </footer>
        </div>
      </ViewportDropdown>
    </div>
  );
}

function ControlToggle({ label, detail, checked, onChange, disabled }: { label: string; detail: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <button className="pm-setting-row pm-toggle" type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span><strong>{label}</strong><small>{detail}</small></span><span className={`pm-switch ${checked ? "on" : ""}`} aria-hidden><span /></span>
  </button>;
}

function withBrowserToken(url: string | null): string | null {
  if (!url || typeof window === "undefined") return url;
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
