"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { RoleGate } from "../../../../components/RoleGate";
import { apiGet, apiPost } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminMobileDevice {
  id: string;
  tenantId: string;
  user: { id: string; email: string; name: string } | null;
  extension: { id: string; number: string; displayName: string } | null;
  platform: "IOS" | "ANDROID";
  active: boolean;
  deviceId: string | null;
  deviceName: string | null;
  appVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  osVersion: string | null;
  lastSeenAt: string;
  lastPushSentAt: string | null;
  lastPushType: string | null;
  lastPushStatus: string | null;
  lastPushError: string | null;
  permRecordAudio: boolean | null;
  permNotifications: boolean | null;
  permissionsReportedAt: string | null;
  expoPushTokenTail: string;
  voipPushTokenTail: string | null;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
}

interface AdminMobileDevicesResponse {
  count: number;
  devices: AdminMobileDevice[];
}

interface WakeEvent {
  id: string;
  pbxCallId: string;
  stage: string;
  source: string;
  userId: string | null;
  deviceId: string | null;
  extensionId: string | null;
  details: Record<string, unknown> | null;
  latencyMs: number | null;
  occurredAt: string;
}

interface WakeTimelineResponse {
  events: WakeEvent[];
}

interface RepublishWakeConfigResponse {
  ok: boolean;
  systemPublished: boolean;
  systemError: string | null;
  wakeWaitSecs: number;
  tenantsAttempted: number;
  tenantsPublished: number;
  tenants: Array<{
    tenantId: string;
    slug: string;
    published: boolean;
    pbxTenantId: string | null;
    pbxTenantCode: string | null;
    error: string | null;
  }>;
}

interface ForceReregisterResponse {
  ok: boolean;
  deviceId: string;
  syntheticPbxCallId: string;
  queued: number;
  simulated: boolean;
  error: string | null;
}

// ── Stage taxonomy ────────────────────────────────────────────────────────────

const STAGE_ORDER: Record<string, number> = {
  WAKE_REQUESTED: 1,
  WAKE_DEVICES_RESOLVED: 2,
  WAKE_PUSH_QUEUED: 3,
  WAKE_PUSH_DELIVERED: 4,
  WAKE_PUSH_FAILED: 4,
  DEVICE_PUSH_RECEIVED: 5,
  DEVICE_REGISTER_TRIGGERED: 6,
  DEVICE_REGISTER_COMPLETE: 7,
  DEVICE_REGISTER_FAILED: 7,
  DEVICE_INVITE_RECEIVED: 8,
  DEVICE_ANSWER_TAPPED: 9,
  WAKE_TIMED_OUT: 99,
  INVITE_PUSH_DELIVERED: 99,
};

const STAGE_COLOR: Record<string, string> = {
  WAKE_REQUESTED: "#60a5fa",
  WAKE_DEVICES_RESOLVED: "#60a5fa",
  WAKE_PUSH_QUEUED: "#60a5fa",
  WAKE_PUSH_DELIVERED: "#22c55e",
  WAKE_PUSH_FAILED: "#ef4444",
  DEVICE_PUSH_RECEIVED: "#22c55e",
  DEVICE_REGISTER_TRIGGERED: "#60a5fa",
  DEVICE_REGISTER_COMPLETE: "#22c55e",
  DEVICE_REGISTER_FAILED: "#ef4444",
  DEVICE_INVITE_RECEIVED: "#22c55e",
  DEVICE_ANSWER_TAPPED: "#22c55e",
  WAKE_TIMED_OUT: "#ef4444",
  INVITE_PUSH_DELIVERED: "#a78bfa",
};

// Friendly source labels
const SOURCE_LABEL: Record<string, string> = {
  pbx_dialplan: "PBX",
  api: "API",
  device: "Device",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function freshnessTone(iso: string | null): { color: string; bg: string; label: string } {
  if (!iso) return { color: "#ef4444", bg: "#7f1d1d22", label: "never" };
  const t = new Date(iso).getTime();
  const ageS = (Date.now() - t) / 1000;
  if (ageS < 60) return { color: "#22c55e", bg: "#14532d22", label: "just now" };
  if (ageS < 300) return { color: "#22c55e", bg: "#14532d22", label: "<5m" };
  if (ageS < 3600) return { color: "#fbbf24", bg: "#78350f22", label: "<1h" };
  if (ageS < 86400) return { color: "#fbbf24", bg: "#78350f22", label: "<24h" };
  return { color: "#ef4444", bg: "#7f1d1d22", label: ">24h" };
}

// ── Auto-triage ───────────────────────────────────────────────────────────────
// Given a single call's ordered event list, produce a one-line diagnosis.
// This is the entire point of the page: turning a wall of stages into
// "wake fired but device never confirmed receipt — Samsung dropped the FCM"
// without forcing the human to mentally sequence them.

interface CallSummary {
  pbxCallId: string;
  events: WakeEvent[];
  diagnosis: string;
  diagnosisColor: string;
}

function diagnoseCall(
  events: WakeEvent[],
  device?: AdminMobileDevice | null,
): { text: string; color: string } {
  const stages = new Set(events.map((e) => e.stage));
  const any = (s: string) => stages.has(s);
  const stageEvent = (s: string) => events.find((e) => e.stage === s);
  const stageTime = (s: string): number | null => {
    const e = stageEvent(s);
    return e ? new Date(e.occurredAt).getTime() : null;
  };
  const gap = (a: string, b: string): number | null => {
    const ta = stageTime(a);
    const tb = stageTime(b);
    return ta != null && tb != null ? tb - ta : null;
  };

  // Permission-class diagnoses take precedence when the call reached the
  // device but the answer flow was blocked at a known choke point. Without
  // RECORD_AUDIO, the SIP 200 OK is sent with no audio track and the PBX
  // BYE's almost immediately — the wake event timeline alone cannot
  // distinguish that from a generic media failure.
  if (
    device?.platform === "ANDROID" &&
    device.permRecordAudio === false &&
    any("DEVICE_INVITE_RECEIVED")
  ) {
    return {
      text:
        "RECORD_AUDIO permission denied on this device — incoming calls answer-then-disconnect. Ask user to grant mic access (Settings → Apps → Connect → Permissions).",
      color: "#ef4444",
    };
  }
  if (
    device?.platform === "ANDROID" &&
    device.permNotifications === false
  ) {
    return {
      text:
        "POST_NOTIFICATIONS denied on this device — heads-up ringer + lock-screen full-screen intent are suppressed by Android, so calls won't visibly ring even when the wake push reaches the FGS. Ask user to enable notifications (Settings → Apps → Connect → Notifications).",
      color: "#ef4444",
    };
  }

  if (!any("WAKE_REQUESTED")) {
    return {
      text: "PBX did not fire wake-extension — dialplan / DID routing issue (call never reached connect-dial-with-wake)",
      color: "#ef4444",
    };
  }
  if (!any("WAKE_DEVICES_RESOLVED")) {
    return {
      text: "Wake fired but no MobileDevice rows resolved — user not provisioned on a device, or extension not linked",
      color: "#ef4444",
    };
  }
  if (any("WAKE_PUSH_FAILED")) {
    return {
      text: "FCM push send rejected by Expo / Google — check device token freshness or Firebase project",
      color: "#ef4444",
    };
  }
  if (!any("WAKE_PUSH_DELIVERED") && !any("WAKE_PUSH_QUEUED")) {
    return {
      text: "Wake push never queued — backend send pipeline broken",
      color: "#ef4444",
    };
  }
  if (!any("DEVICE_PUSH_RECEIVED")) {
    return {
      text: "Push sent by server but device never confirmed receipt — Samsung/OEM dropped the FCM (Doze, missing notification permission, or app force-stopped). Try Force re-register on this device card; if that also fails, the FCM token is dead and the user must re-open the app.",
      color: "#ef4444",
    };
  }
  // Slow-receive: push reached the device but more than 5 seconds after the
  // server queued it. Indicates Samsung Doze / battery optimization is
  // throttling FCM delivery — the wake_wait_secs window almost certainly
  // expired before SIP could re-register.
  const queueToReceive = gap("WAKE_PUSH_QUEUED", "DEVICE_PUSH_RECEIVED");
  if (queueToReceive != null && queueToReceive > 5000) {
    return {
      text: `Wake push took ${(queueToReceive / 1000).toFixed(1)}s to reach the device — Samsung Doze / battery optimization is delaying FCM. Set battery to "Unrestricted" (Settings → Apps → Connect → Battery) and ensure SipKeepAliveService is running.`,
      color: "#ef4444",
    };
  }
  if (any("DEVICE_REGISTER_FAILED")) {
    return {
      text: "Device received wake but SIP REGISTER failed — credentials invalid, network blocked, or PBX unreachable",
      color: "#ef4444",
    };
  }
  if (!any("DEVICE_REGISTER_TRIGGERED")) {
    return {
      text: "Device received wake but native handler did not fire JS bridge — SipKeepAliveService probably did not start (Android 15 FGS rejection, or app was force-stopped). Try Force re-register; if this keeps happening on a Galaxy S25, check the SipKeepAliveService section in the in-app Diagnostics screen for the FGS error class.",
      color: "#ef4444",
    };
  }
  if (!any("DEVICE_REGISTER_COMPLETE")) {
    return {
      text: "Register triggered but never completed within window — JS process slow to thaw, or WSS handshake stalled. If wake_wait_secs is at the default 10s this should be enough on a healthy network.",
      color: "#fbbf24",
    };
  }
  if (!any("DEVICE_INVITE_RECEIVED")) {
    // Did the phone register fast enough vs the dialplan budget?
    const registerCompleteMs = gap("WAKE_REQUESTED", "DEVICE_REGISTER_COMPLETE");
    if (registerCompleteMs != null && registerCompleteMs > 9000) {
      return {
        text: `Phone re-registered but it took ${(registerCompleteMs / 1000).toFixed(1)}s — longer than wake_wait_secs (10s default). The dialplan timed out and routed the call to voicemail. Either bump PBX_WAKE_WAIT_SECS in the API env or speed up the cold-start path (already on Hermes).`,
        color: "#fbbf24",
      };
    }
    return {
      text: "Phone re-registered but PBX never sent INVITE — wake_wait_secs may be too short OR PBX dialed before the contact was online. Click Republish wake config to push the latest budget into AstDB.",
      color: "#fbbf24",
    };
  }
  if (any("DEVICE_ANSWER_TAPPED")) {
    return { text: "Full path completed — call was answered", color: "#22c55e" };
  }
  return {
    text: "Phone rang but call was not answered (missed call / declined / timed out)",
    color: "#fbbf24",
  };
}

function groupEventsByCall(
  events: WakeEvent[],
  device?: AdminMobileDevice | null,
): CallSummary[] {
  const byCall = new Map<string, WakeEvent[]>();
  for (const e of events) {
    if (!byCall.has(e.pbxCallId)) byCall.set(e.pbxCallId, []);
    byCall.get(e.pbxCallId)!.push(e);
  }
  const calls: CallSummary[] = [];
  for (const [pbxCallId, evs] of byCall.entries()) {
    const sorted = [...evs].sort(
      (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
    const d = diagnoseCall(sorted, device);
    calls.push({ pbxCallId, events: sorted, diagnosis: d.text, diagnosisColor: d.color });
  }
  // Most recent call first
  calls.sort(
    (a, b) =>
      new Date(b.events[b.events.length - 1].occurredAt).getTime() -
      new Date(a.events[a.events.length - 1].occurredAt).getTime(),
  );
  return calls;
}

// ── Components ────────────────────────────────────────────────────────────────

function DeviceCard({
  device,
  selected,
  onSelect,
}: {
  device: AdminMobileDevice;
  selected: boolean;
  onSelect: () => void;
}) {
  const seen = freshnessTone(device.lastSeenAt);
  const pushedTone = device.lastPushStatus
    ? device.lastPushStatus === "ok" || device.lastPushStatus === "queued"
      ? { color: "#22c55e", bg: "#14532d22" }
      : { color: "#ef4444", bg: "#7f1d1d22" }
    : { color: "#6b7280", bg: "#1f293722" };
  return (
    <div
      onClick={onSelect}
      style={{
        background: selected ? "#1e3a5f" : "#1f2937",
        border: selected ? "2px solid #60a5fa" : "1px solid #374151",
        borderRadius: 10,
        padding: 14,
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>
          {device.user?.name || "—"}
        </div>
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 3,
            background: device.platform === "ANDROID" ? "#14532d22" : "#1e3a5f22",
            color: device.platform === "ANDROID" ? "#22c55e" : "#60a5fa",
            fontWeight: 600,
          }}
        >
          {device.platform}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
        {device.user?.email || "no user"} {device.extension ? `· ext ${device.extension.number}` : ""}
      </div>
      <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 4 }}>
        <strong style={{ color: "#cbd5e1" }}>
          {device.manufacturer || ""} {device.model || device.deviceName || "Unknown device"}
        </strong>
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>
        Android/iOS: {device.osVersion || "?"} · App: {device.appVersion || "?"}
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            background: seen.bg,
            color: seen.color,
            fontWeight: 600,
          }}
        >
          last seen {seen.label}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            background: pushedTone.bg,
            color: pushedTone.color,
            fontWeight: 600,
          }}
        >
          last push: {device.lastPushStatus || "never"}
        </span>
        <PermissionBadge
          label="mic"
          granted={device.permRecordAudio}
          reportedAt={device.permissionsReportedAt}
        />
        <PermissionBadge
          label="notif"
          granted={device.permNotifications}
          reportedAt={device.permissionsReportedAt}
        />
        {!device.active && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              background: "#7f1d1d22",
              color: "#ef4444",
              fontWeight: 600,
            }}
          >
            INACTIVE
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: "#475569", marginTop: 6 }}>
        FCM: …{device.expoPushTokenTail}
      </div>
    </div>
  );
}

function PermissionBadge({
  label,
  granted,
  reportedAt,
}: {
  label: string;
  granted: boolean | null | undefined;
  reportedAt: string | null;
}) {
  // Three states:
  //   • unknown (null/undefined or never reported) — older app build, gray
  //   • granted (true) — green
  //   • denied (false) — red, this is the actionable signal
  let bg: string;
  let color: string;
  let text: string;
  if (granted === true) {
    bg = "#14532d22";
    color = "#22c55e";
    text = `${label} ✓`;
  } else if (granted === false) {
    bg = "#7f1d1d22";
    color = "#ef4444";
    text = `${label} ✕`;
  } else {
    bg = "#1f293722";
    color = "#6b7280";
    text = reportedAt ? `${label} ?` : `${label} (old app)`;
  }
  return (
    <span
      style={{
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: bg,
        color,
        fontWeight: 600,
      }}
      title={
        reportedAt
          ? `Reported ${new Date(reportedAt).toLocaleString()}`
          : "No permission state reported yet (app needs to re-register)"
      }
    >
      {text}
    </span>
  );
}

function StageDot({ stage }: { stage: string }) {
  const color = STAGE_COLOR[stage] || "#6b7280";
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        marginRight: 8,
      }}
    />
  );
}

function CallTimelineCard({ call }: { call: CallSummary }) {
  const [open, setOpen] = useState(false);
  const start = call.events[0];
  const startMs = new Date(start.occurredAt).getTime();
  const last = call.events[call.events.length - 1];

  return (
    <div
      style={{
        background: "#0f172a",
        border: `1px solid ${call.diagnosisColor}33`,
        borderRadius: 10,
        marginBottom: 10,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: 14,
          cursor: "pointer",
          borderLeft: `4px solid ${call.diagnosisColor}`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace" }}>
            {call.pbxCallId}
          </div>
          <div style={{ fontSize: 11, color: "#475569" }}>
            {fmtDate(start.occurredAt)} · {call.events.length} events ·{" "}
            {fmtAgo(last.occurredAt)}
          </div>
        </div>
        <div
          style={{
            fontSize: 13,
            color: call.diagnosisColor,
            fontWeight: 600,
            marginTop: 4,
          }}
        >
          {call.diagnosis}
        </div>
      </div>
      {open && (
        <div style={{ background: "#0a0f1f", padding: 14, borderTop: "1px solid #1f2937" }}>
          {call.events.map((ev) => {
            const elapsed = new Date(ev.occurredAt).getTime() - startMs;
            return (
              <div
                key={ev.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "6px 0",
                  borderBottom: "1px solid #1f2937",
                }}
              >
                <StageDot stage={ev.stage} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: STAGE_COLOR[ev.stage] || "#cbd5e1",
                      }}
                    >
                      {ev.stage}
                    </span>
                    <span style={{ fontSize: 11, color: "#475569" }}>
                      {fmtTime(ev.occurredAt)}{" "}
                      <span style={{ color: "#374151", marginLeft: 4 }}>
                        +{elapsed}ms
                      </span>
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                    source: {SOURCE_LABEL[ev.source] || ev.source}
                    {ev.latencyMs != null ? ` · latency ${ev.latencyMs}ms` : ""}
                  </div>
                  {ev.details && Object.keys(ev.details).length > 0 && (
                    <pre
                      style={{
                        fontSize: 10,
                        color: "#94a3b8",
                        background: "#020617",
                        padding: 6,
                        borderRadius: 4,
                        marginTop: 4,
                        overflowX: "auto",
                        maxHeight: 120,
                      }}
                    >
                      {JSON.stringify(ev.details, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CallWakeDiagnosticsPage() {
  const [devices, setDevices] = useState<AdminMobileDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [events, setEvents] = useState<WakeEvent[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [republishing, setRepublishing] = useState(false);
  const [republishResult, setRepublishResult] = useState<RepublishWakeConfigResponse | null>(null);
  const [republishError, setRepublishError] = useState<string | null>(null);
  const [forcing, setForcing] = useState(false);
  const [forceResult, setForceResult] = useState<ForceReregisterResponse | null>(null);
  const [forceError, setForceError] = useState<string | null>(null);

  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === selectedDeviceId) || null,
    [devices, selectedDeviceId],
  );

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (includeInactive) params.set("includeInactive", "1");
      const res = await apiGet<AdminMobileDevicesResponse>(
        `/admin/mobile/devices?${params.toString()}`,
      );
      const sorted = [...res.devices].sort((a, b) => {
        const ta = new Date(a.lastSeenAt).getTime();
        const tb = new Date(b.lastSeenAt).getTime();
        return tb - ta;
      });
      setDevices(sorted);
      if (!selectedDeviceId && sorted.length > 0) setSelectedDeviceId(sorted[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load devices");
    } finally {
      setLoadingDevices(false);
    }
  }, [includeInactive, selectedDeviceId]);

  const loadEvents = useCallback(async () => {
    if (!selectedDevice?.user?.id) {
      setEvents([]);
      return;
    }
    setLoadingEvents(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("userId", selectedDevice.user.id);
      params.set("limit", "200");
      const res = await apiGet<WakeTimelineResponse>(
        `/mobile/wake/timeline?${params.toString()}`,
      );
      setEvents(res.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load events");
    } finally {
      setLoadingEvents(false);
    }
  }, [selectedDevice?.user?.id]);

  const republishWakeConfig = useCallback(async () => {
    setRepublishing(true);
    setRepublishError(null);
    try {
      const res = await apiPost<RepublishWakeConfigResponse>(
        "/admin/pbx/republish-wake-config",
        { allTenants: true },
      );
      setRepublishResult(res);
    } catch (e) {
      setRepublishError(e instanceof Error ? e.message : "Republish failed");
    } finally {
      setRepublishing(false);
    }
  }, []);

  const forceReregister = useCallback(async (deviceId: string) => {
    setForcing(true);
    setForceError(null);
    setForceResult(null);
    try {
      const res = await apiPost<ForceReregisterResponse>(
        `/admin/mobile/devices/${deviceId}/force-reregister`,
        {},
      );
      setForceResult(res);
      // After a few seconds the wake event timeline should have new
      // entries — auto-refresh so the operator sees the round-trip
      // without manually clicking refresh.
      setTimeout(() => void loadEvents(), 4000);
    } catch (e) {
      setForceError(e instanceof Error ? e.message : "Force re-register failed");
    } finally {
      setForcing(false);
    }
  }, [loadEvents]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const calls = useMemo(() => groupEventsByCall(events, selectedDevice), [events, selectedDevice]);

  return (
    <RoleGate
      allow={["SUPER_ADMIN", "TENANT_ADMIN"]}
      fallback={<div className="state-box">You do not have admin access.</div>}
    >
      <div className="stack">
        <PageHeader
          title="Call Wake Diagnostics"
          subtitle="Per-device wake-then-dial timeline and auto-triage. Use this when a user reports 'phone goes straight to voicemail' or 'calls only ring when app is open'."
        />

        {/* PBX wake config control */}
        <section
          style={{
            background: "#0f172a",
            border: "1px solid #1f2937",
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                PBX wake config
              </div>
              <div style={{ color: "#94a3b8", fontSize: 12, lineHeight: 1.5 }}>
                Pushes <code style={{ color: "#cbd5e1" }}>wake_api_url</code>,{" "}
                <code style={{ color: "#cbd5e1" }}>wake_api_secret</code>, and{" "}
                <code style={{ color: "#cbd5e1" }}>wake_wait_secs</code> into VitalPBX&apos;s AstDB so the{" "}
                <code style={{ color: "#cbd5e1" }}>connect-dial-with-wake</code> dialplan picks up the new
                values. Run this after the API redeploys with a new wake budget — otherwise calls keep using
                the cached value.
              </div>
            </div>
            <button
              onClick={() => void republishWakeConfig()}
              disabled={republishing}
              style={{
                background: republishing ? "#374151" : "#7c3aed",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                cursor: republishing ? "default" : "pointer",
                whiteSpace: "nowrap",
                alignSelf: "center",
              }}
            >
              {republishing ? "Republishing…" : "Republish wake config"}
            </button>
          </div>

          {republishError && (
            <div
              style={{
                marginTop: 10,
                background: "#7f1d1d22",
                border: "1px solid #ef4444",
                color: "#fca5a5",
                padding: 10,
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              {republishError}
            </div>
          )}

          {republishResult && (
            <div
              style={{
                marginTop: 10,
                background: republishResult.systemPublished ? "#14532d22" : "#7f1d1d22",
                border: `1px solid ${republishResult.systemPublished ? "#22c55e" : "#ef4444"}`,
                color: "#cbd5e1",
                padding: 10,
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {republishResult.systemPublished ? "Published" : "Failed"} ·{" "}
                wake_wait_secs = {republishResult.wakeWaitSecs}s · tenants{" "}
                {republishResult.tenantsPublished}/{republishResult.tenantsAttempted}
              </div>
              {republishResult.systemError && (
                <div style={{ color: "#fca5a5", fontFamily: "monospace", fontSize: 11 }}>
                  system: {republishResult.systemError}
                </div>
              )}
              {republishResult.tenants.some((t) => t.error) && (
                <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 11 }}>
                  {republishResult.tenants
                    .filter((t) => t.error)
                    .map((t) => (
                      <li key={t.tenantId} style={{ color: "#fca5a5" }}>
                        {t.slug}: {t.error}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {error && (
          <div
            style={{
              background: "#7f1d1d22",
              border: "1px solid #ef4444",
              color: "#fca5a5",
              padding: 10,
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* Devices */}
        <section style={{ marginBottom: 24 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <h3 style={{ margin: 0, color: "#e2e8f0", fontSize: 16 }}>
              Mobile Devices ({devices.length})
            </h3>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(e) => setIncludeInactive(e.target.checked)}
                />
                Show inactive
              </label>
              <button
                onClick={() => void loadDevices()}
                disabled={loadingDevices}
                style={{
                  background: "#1d4ed8",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 14px",
                  fontSize: 12,
                  cursor: loadingDevices ? "default" : "pointer",
                  opacity: loadingDevices ? 0.6 : 1,
                }}
              >
                {loadingDevices ? "Loading…" : "Refresh"}
              </button>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 10,
            }}
          >
            {devices.length === 0 && !loadingDevices && (
              <div style={{ color: "#6b7280", fontSize: 13 }}>No devices found.</div>
            )}
            {devices.map((d) => (
              <DeviceCard
                key={d.id}
                device={d}
                selected={d.id === selectedDeviceId}
                onSelect={() => setSelectedDeviceId(d.id)}
              />
            ))}
          </div>
        </section>

        {/* Selected device summary + timeline */}
        {selectedDevice && (
          <>
            <section style={{ marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <h3 style={{ margin: 0, color: "#e2e8f0", fontSize: 16 }}>
                  Selected device · {selectedDevice.user?.name || "no user"}
                </h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => void forceReregister(selectedDevice.id)}
                    disabled={forcing || !selectedDevice.active}
                    title={
                      !selectedDevice.active
                        ? "Inactive device — token is stale, cannot force-reregister"
                        : "Send a silent wake push to this device. The phone wakes the FGS, re-registers SIP, and shows no notification (synthetic payload has no caller info)."
                    }
                    style={{
                      background:
                        forcing || !selectedDevice.active ? "#374151" : "#0891b2",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "6px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor:
                        forcing || !selectedDevice.active ? "default" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {forcing ? "Sending\u2026" : "Force re-register"}
                  </button>
                </div>
              </div>

              {forceError && (
                <div
                  style={{
                    marginBottom: 10,
                    background: "#7f1d1d22",
                    border: "1px solid #ef4444",
                    color: "#fca5a5",
                    padding: 10,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  Force re-register failed: {forceError}
                </div>
              )}

              {forceResult && (
                <div
                  style={{
                    marginBottom: 10,
                    background: forceResult.ok ? "#14532d22" : "#7f1d1d22",
                    border: `1px solid ${forceResult.ok ? "#22c55e" : "#ef4444"}`,
                    color: "#cbd5e1",
                    padding: 10,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>
                    {forceResult.ok ? "Wake push queued" : "Wake push failed"}
                    {forceResult.simulated ? " (simulated)" : ""}
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>
                    pbxCallId <code style={{ color: "#cbd5e1" }}>{forceResult.syntheticPbxCallId}</code> · queued{" "}
                    {forceResult.queued} push{forceResult.queued === 1 ? "" : "es"}.
                    Wake timeline will refresh in a few seconds.
                  </div>
                  {forceResult.error && (
                    <div style={{ color: "#fca5a5", marginTop: 4 }}>{forceResult.error}</div>
                  )}
                </div>
              )}

              <div
                style={{
                  background: "#0f172a",
                  border: "1px solid #1f2937",
                  borderRadius: 10,
                  padding: 14,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 14,
                  fontSize: 12,
                  color: "#cbd5e1",
                }}
              >
                <div>
                  <div style={{ color: "#6b7280", fontSize: 10, textTransform: "uppercase" }}>
                    Hardware
                  </div>
                  <div style={{ marginTop: 2 }}>
                    {selectedDevice.manufacturer} {selectedDevice.model || selectedDevice.deviceName}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#6b7280", fontSize: 10, textTransform: "uppercase" }}>
                    OS / App
                  </div>
                  <div style={{ marginTop: 2 }}>
                    {selectedDevice.osVersion || "?"} · v{selectedDevice.appVersion || "?"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#6b7280", fontSize: 10, textTransform: "uppercase" }}>
                    Last seen
                  </div>
                  <div style={{ marginTop: 2 }}>{fmtAgo(selectedDevice.lastSeenAt)}</div>
                </div>
                <div>
                  <div style={{ color: "#6b7280", fontSize: 10, textTransform: "uppercase" }}>
                    Last push
                  </div>
                  <div style={{ marginTop: 2 }}>
                    {selectedDevice.lastPushType || "—"}{" "}
                    <span
                      style={{
                        color:
                          selectedDevice.lastPushStatus === "ok" ||
                          selectedDevice.lastPushStatus === "queued"
                            ? "#22c55e"
                            : "#ef4444",
                      }}
                    >
                      ({selectedDevice.lastPushStatus || "never"})
                    </span>
                    <div style={{ color: "#6b7280", fontSize: 10 }}>
                      {fmtAgo(selectedDevice.lastPushSentAt)}
                    </div>
                  </div>
                </div>
                {selectedDevice.lastPushError && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ color: "#6b7280", fontSize: 10, textTransform: "uppercase" }}>
                      Last push error
                    </div>
                    <div style={{ marginTop: 2, color: "#fca5a5", fontFamily: "monospace" }}>
                      {selectedDevice.lastPushError}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <h3 style={{ margin: 0, color: "#e2e8f0", fontSize: 16 }}>
                  Wake Timeline ({calls.length} call{calls.length === 1 ? "" : "s"} ·{" "}
                  {events.length} events)
                </h3>
                <button
                  onClick={() => void loadEvents()}
                  disabled={loadingEvents}
                  style={{
                    background: "#1d4ed8",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    padding: "6px 14px",
                    fontSize: 12,
                    cursor: loadingEvents ? "default" : "pointer",
                    opacity: loadingEvents ? 0.6 : 1,
                  }}
                >
                  {loadingEvents ? "Loading…" : "Refresh"}
                </button>
              </div>
              {calls.length === 0 && !loadingEvents && (
                <div style={{ color: "#6b7280", fontSize: 13 }}>
                  No wake events recorded for this user. Place a test call to the user&apos;s
                  DID and refresh.
                </div>
              )}
              {calls.map((c) => (
                <CallTimelineCard key={c.pbxCallId} call={c} />
              ))}
            </section>
          </>
        )}
      </div>
    </RoleGate>
  );
}
