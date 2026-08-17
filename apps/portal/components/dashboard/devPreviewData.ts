import type { DateRangeValue } from "../DateRangeFilter";
import type { LiveCall } from "../../types/liveCall";
import type { TrafficData, TrafficPoint } from "./CallVolumeChart";
import type { CommunicationsData } from "./CommunicationsRow";
import type { IvrAnalyticsData } from "./IvrAnalyticsCard";

const DAY_MS = 86_400_000;

function isoAt(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

function point(label: string, startMs: number, incoming: number, outgoing: number, internal: number, missed = 0, canceled = 0): TrafficPoint {
  return {
    label,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + DAY_MS).toISOString(),
    incoming,
    outgoing,
    internal,
    missed,
    canceled,
    total: incoming + outgoing + internal + missed + canceled,
  };
}

export function buildDashboardDevPreviewTraffic(range: DateRangeValue, now = Date.now()): TrafficData {
  const days = range.key === "today" ? 1 : range.key === "30d" ? 14 : 7;
  const start = now - (days - 1) * DAY_MS;
  const samples = [
    [14, 9, 4, 1, 0],
    [18, 12, 5, 2, 1],
    [21, 16, 4, 1, 1],
    [16, 11, 6, 3, 0],
    [24, 18, 7, 2, 1],
    [19, 14, 3, 1, 0],
    [16, 16, 5, 1, 1],
    [22, 15, 6, 2, 1],
    [27, 19, 8, 2, 0],
    [23, 17, 7, 3, 1],
    [18, 13, 5, 1, 0],
    [20, 16, 6, 2, 1],
    [25, 18, 7, 2, 0],
    [21, 15, 5, 2, 1],
  ];
  const todaySamples = [
    [7, 4, 1, 0, 0],
    [10, 6, 2, 1, 0],
    [15, 9, 3, 1, 1],
    [18, 12, 4, 2, 0],
    [13, 10, 3, 1, 0],
    [9, 7, 2, 0, 1],
  ];

  const points =
    range.key === "today"
      ? todaySamples.map(([incoming, outgoing, internal, missed, canceled], index) => {
          const startMs = now - (todaySamples.length - 1 - index) * 2 * 60 * 60 * 1000;
          return {
            ...point(`${index + 1}`, startMs, incoming, outgoing, internal, missed, canceled),
            end: new Date(startMs + 2 * 60 * 60 * 1000).toISOString(),
          };
        })
      : samples.slice(-days).map(([incoming, outgoing, internal, missed, canceled], index) => {
          const startMs = start + index * DAY_MS;
          return point(`Day ${index + 1}`, startMs, incoming, outgoing, internal, missed, canceled);
        });

  const totals = points.reduce(
    (acc, item) => {
      acc.total += item.total;
      acc.incoming += item.incoming;
      acc.outgoing += item.outgoing;
      acc.internal += item.internal;
      acc.missed += item.missed;
      acc.canceled += item.canceled ?? 0;
      return acc;
    },
    { total: 0, incoming: 0, outgoing: 0, internal: 0, missed: 0, canceled: 0 },
  );

  return {
    range: range.key,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    windowMinutes: range.key === "today" ? 720 : days * 24 * 60,
    bucketMinutes: range.key === "today" ? 120 : 1440,
    totals,
    points,
  };
}

export function buildDashboardDevPreviewCalls(tenantId: string | null, tenantName: string | null | undefined, now = Date.now()): LiveCall[] {
  const tenantLabel = tenantName || "Loopcom Demo Co";
  return [
    {
      id: "dev-preview-call-1",
      linkedId: "dev-preview-linked-1",
      tenantId,
      tenantSlug: "connect-demo",
      tenantName: tenantLabel,
      direction: "inbound",
      state: "ringing",
      from: "+1 (312) 555-0188",
      fromName: "Morgan Lee",
      to: "Sales Queue",
      connectedLine: "101",
      source_extension: null,
      destination_extension: "101",
      channelState: "Ring",
      channels: ["PJSIP/dev-preview-inbound-1"],
      bridgeIds: [],
      extensions: ["101"],
      queueId: "sales",
      trunk: "voipms-chicago",
      startedAt: isoAt(now, -42_000),
      answeredAt: null,
      endedAt: null,
      durationSec: 42,
      billableSec: 0,
      metadata: { preview: true, callerIdNumber: "+1 (312) 555-0188" },
      crmContactId: "dev-preview-contact-1",
      crmContactName: "Morgan Lee",
      crmCompanyName: "Northstar Lending",
      crmProfileUrl: "/crm/contacts/dev-preview-contact-1",
      crmMatchSource: "exact",
    },
    {
      id: "dev-preview-call-2",
      linkedId: "dev-preview-linked-2",
      tenantId,
      tenantSlug: "connect-demo",
      tenantName: tenantLabel,
      direction: "outbound",
      state: "up",
      from: "104",
      fromName: "Avery Patel",
      to: "+1 (646) 555-0142",
      connectedLine: "+1 (646) 555-0142",
      source_extension: "104",
      destination_extension: null,
      channelState: "Up",
      channels: ["PJSIP/dev-preview-outbound-2"],
      bridgeIds: ["dev-preview-bridge-2"],
      extensions: ["104"],
      queueId: null,
      trunk: "voipms-newyork",
      startedAt: isoAt(now, -7 * 60_000),
      answeredAt: isoAt(now, -6 * 60_000),
      endedAt: null,
      durationSec: 420,
      billableSec: 360,
      metadata: { preview: true, remoteNumber: "+1 (646) 555-0142", toNumber: "+1 (646) 555-0142" },
    },
    {
      id: "dev-preview-call-3",
      linkedId: "dev-preview-linked-3",
      tenantId,
      tenantSlug: "connect-demo",
      tenantName: tenantLabel,
      direction: "internal",
      state: "held",
      from: "102",
      fromName: "Jamie Rivera",
      to: "107",
      connectedLine: "107",
      source_extension: "102",
      destination_extension: "107",
      channelState: "Up",
      channels: ["PJSIP/dev-preview-internal-3"],
      bridgeIds: ["dev-preview-bridge-3"],
      extensions: ["102", "107"],
      queueId: null,
      trunk: null,
      startedAt: isoAt(now, -12 * 60_000),
      answeredAt: isoAt(now, -11 * 60_000),
      endedAt: null,
      durationSec: 720,
      billableSec: 660,
      metadata: { preview: true, remoteNumber: "107" },
    },
  ];
}

export function buildDashboardDevPreviewCommunications(now = Date.now()): CommunicationsData {
  return {
    voicemails: {
      unread: 3,
      recent: [
        {
          id: "dev-preview-vm-1",
          callerName: "Taylor Brooks",
          callerNumber: "+1 (206) 555-0191",
          durationSec: 54,
          receivedAt: isoAt(now, -9 * 60_000),
          read: false,
        },
        {
          id: "dev-preview-vm-2",
          callerName: "Dana Mitchell",
          callerNumber: "+1 (415) 555-0167",
          durationSec: 38,
          receivedAt: isoAt(now, -53 * 60_000),
          read: false,
        },
        {
          id: "dev-preview-vm-3",
          callerName: "Riley Chen",
          callerNumber: "+1 (720) 555-0124",
          durationSec: 72,
          receivedAt: isoAt(now, -3 * 60 * 60_000),
          read: true,
        },
      ],
    },
    messages: {
      unread: 5,
      recent: [
        {
          threadId: "dev-preview-thread-1",
          counterpartyLabel: "Jordan at Apex Funding",
          preview: "Can you send the updated quote before our 3pm call?",
          createdAt: isoAt(now, -4 * 60_000),
          unread: true,
        },
        {
          threadId: "dev-preview-thread-2",
          counterpartyLabel: "Mia Rodriguez",
          preview: "Thanks, I uploaded the signed form to the portal.",
          createdAt: isoAt(now, -37 * 60_000),
          unread: true,
        },
        {
          threadId: "dev-preview-thread-3",
          counterpartyLabel: "Loopcom Support Queue",
          preview: "Callback scheduled and assigned to ext 104.",
          createdAt: isoAt(now, -2 * 60 * 60_000),
          unread: false,
        },
      ],
    },
  };
}

export const DASHBOARD_DEV_PREVIEW_IVR: IvrAnalyticsData = {
  range: "preview",
  totals: {
    ivrCalls: 74,
    optionsPressed: 61,
    timeouts: 7,
    invalidEntries: 3,
    directDials: 9,
    dropOffs: 6,
  },
  topOptions: [
    { digit: "1", count: 28, label: "Sales" },
    { digit: "2", count: 18, label: "Support" },
    { digit: "3", count: 10, label: "Billing" },
    { digit: "0", count: 5, label: "Operator" },
  ],
};
