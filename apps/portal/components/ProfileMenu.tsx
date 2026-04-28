"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { getWebRingerEnabled, setWebRingerEnabled } from "../hooks/telephonyAudioPreferences";
import { apiDelete, apiGet, apiUploadVoicemailGreeting, ApiError } from "../services/apiClient";
import { clearAuthSession } from "../services/session";
import { ScopedActionButton } from "./ScopedActionButton";
import { ViewportDropdown } from "./ViewportDropdown";

type ControlPanelResponse = {
  extension: null | {
    id: string;
    tenantId: string;
    number: string;
    displayName: string;
    status: string;
  };
  presence: "AVAILABLE" | "RINGING" | "ON_CALL" | "DND" | "OFFLINE" | string;
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

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [dnd, setDnd] = useState(false);
  const [ringerOn, setRingerOn] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [panelData, setPanelData] = useState<ControlPanelResponse | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const { user, tenant, role, setRole, theme, setTheme } = useAppContext();
  const closeMenu = useCallback(() => setOpen(false), []);
  const displayName = formatTopbarUserName(user.name, user.email);
  const avatarText = initialsFor(displayName);
  const extensionNumber = panelData?.extension?.number || user.extension || "Not assigned";
  const presence = dnd ? "DND" : panelData?.presence || user.presence || "AVAILABLE";
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
    return () => {
      active = false;
    };
  }, [open]);

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

  return (
    <div className="menu-wrap">
      <button ref={triggerRef} className="icon-btn profile-trigger" onClick={() => setOpen((v) => !v)} title={displayName}>
        <span className="profile-trigger-avatar" aria-hidden>{avatarText}</span>
        <span className="profile-trigger-name">{displayName}</span>
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closeMenu} width={390} className="extension-control-panel">
        <section className="ecp-header" aria-label="Extension control panel header">
          <div className="ecp-avatar" aria-hidden>{avatarText}</div>
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
          <ControlToggle label="DND" detail="Silence calls for this browser" checked={dnd} onChange={updateDnd} />
          <ControlToggle label="Ringer" detail="WebRTC incoming ring" checked={ringerOn} onChange={updateRinger} />
          <ControlToggle label="Theme" detail={theme === "dark" ? "Dark mode" : "Light mode"} checked={theme === "dark"} onChange={(next) => setTheme(next ? "dark" : "light")} />
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
          {greeting.publishDetail ? <div className="ecp-warning">{greeting.publishDetail}</div> : null}
          <div className="ecp-actions-row">
            <button className="ecp-secondary-btn" type="button" disabled={!previewUrl} onClick={() => previewUrl && window.open(previewUrl, "_blank", "noopener,noreferrer")}>Play</button>
            <button className="ecp-secondary-btn danger-soft" type="button" disabled={uploading || greeting.status !== "custom"} onClick={() => void resetGreeting()}>Reset to Default</button>
          </div>
        </section>

        <section className="ecp-section ecp-admin" aria-label="Role and admin controls">
          <div className="ecp-section-title">Role / Admin</div>
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="END_USER">End User</option>
            <option value="TENANT_ADMIN">Tenant Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </select>
          <ScopedActionButton className="btn ghost">Office Hours Override</ScopedActionButton>
        </section>

        <section className="ecp-logout">
          <button className="ecp-logout-btn" onClick={logout}>Logout</button>
        </section>
      </ViewportDropdown>
    </div>
  );
}

function ControlToggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button className="ecp-toggle-row" type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span className={`ecp-switch ${checked ? "on" : ""}`} aria-hidden><span /></span>
    </button>
  );
}

function formatTopbarUserName(name?: string | null, email?: string | null): string {
  const rawName = (name ?? "").trim();
  const rawEmail = (email ?? "").trim();
  const base = rawName && !rawName.includes("@")
    ? rawName
    : rawEmail.split("@")[0] || rawName.split("@")[0] || "User";
  return base.replace(/\d{6,}$/, "") || base;
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "U";
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
