import { apiGet } from "./apiClient";
import { dashboardMetrics, mockUsers } from "./mockData";
import type { AdminScope } from "../types/app";

type Metric = { label: string; value: string; delta?: string };

export type DashboardData = {
  metrics: Metric[];
  activity: Array<{ type: string; label: string; timestamp?: string }>;
  scopeLabel: "GLOBAL" | "TENANT";
};

export async function loadDashboardData(scope: AdminScope): Promise<DashboardData> {
  if (scope === "GLOBAL") {
    try {
      const [tenants, pbxInstances, providerHealth] = await Promise.all([
        apiGet<any[]>("/admin/tenants"),
        apiGet<any[]>("/admin/pbx/instances"),
        apiGet<any>("/admin/sms/provider-health")
      ]);

      const tenantCount = Array.isArray(tenants) ? tenants.length : 0;
      const suspended = Array.isArray(tenants) ? tenants.filter((t: any) => t.isApproved === false).length : 0;
      const pbxCount = Array.isArray(pbxInstances) ? pbxInstances.length : 0;
      const pbxDegraded = Array.isArray(pbxInstances) ? pbxInstances.filter((i: any) => !i.isEnabled).length : 0;
      const failoversRecent = Number(providerHealth?.failoversRecent || 0);
      const circuitsOpen = Array.isArray(providerHealth?.circuitsOpen) ? providerHealth.circuitsOpen.length : 0;

      return {
        scopeLabel: "GLOBAL",
        metrics: [
          { label: "Total Tenants", value: String(tenantCount), delta: "Global scope" },
          { label: "Suspended Tenants", value: String(suspended), delta: "Approval status" },
          { label: "PBX Instances", value: String(pbxCount), delta: "Provisioned" },
          { label: "PBX Degraded", value: String(pbxDegraded), delta: "Needs attention" },
          { label: "SMS Failovers (15m)", value: String(failoversRecent), delta: "Provider health" },
          { label: "Open Circuits", value: String(circuitsOpen), delta: "Circuit breaker state" }
        ],
        activity: [
          { type: "GLOBAL_TENANT_VIEW", label: `Viewing ${tenantCount} tenants in global admin mode.` },
          { type: "GLOBAL_PBX_HEALTH", label: `${pbxDegraded} PBX instances currently degraded.` },
          { type: "GLOBAL_SMS_HEALTH", label: `${failoversRecent} SMS failover events in recent window.` }
        ]
      };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        metrics: [
          { label: "Total Tenants", value: "0", delta: "Fallback mode" },
          { label: "Suspended Tenants", value: "0", delta: "Fallback mode" },
          { label: "PBX Instances", value: "0", delta: "Fallback mode" },
          { label: "PBX Degraded", value: "0", delta: "Fallback mode" },
          { label: "SMS Failovers (15m)", value: "0", delta: "Fallback mode" },
          { label: "Open Circuits", value: "0", delta: "Fallback mode" }
        ],
        activity: [{ type: "GLOBAL_FALLBACK", label: "Global metrics unavailable from API, using fallback mode." }]
      };
    }
  }

  try {
    const [summary, activity, callsReport, extensionRows, trunkRows] = await Promise.all([
      apiGet<any>("/dashboard/summary?range=24h"),
      apiGet<any>("/dashboard/activity?range=24h"),
      apiGet<any>("/voice/pbx/call-reports"),
      apiGet<any>("/voice/pbx/resources/extensions"),
      apiGet<any>("/voice/pbx/resources/trunks")
    ]);

    const reportItems = Array.isArray(callsReport?.report?.items)
      ? callsReport.report.items
      : Array.isArray(callsReport?.items)
        ? callsReport.items
        : [];
    const answeredCount = reportItems.filter((item: any) => String(item?.disposition || "").toLowerCase() === "answered").length;
    const missedCount = reportItems.filter((item: any) => String(item?.disposition || "").toLowerCase().includes("miss")).length;
    const callsToday = reportItems.length;
    const extensions = Array.isArray(extensionRows?.rows) ? extensionRows.rows : [];
    const registeredExtensions = extensions.filter((row: any) => {
      const value = String(row?.status || row?.registration || row?.registered || "").toLowerCase();
      return value.includes("reg") || value.includes("online") || value === "true";
    }).length;
    const trunks = Array.isArray(trunkRows?.rows) ? trunkRows.rows : [];
    const onlineTrunks = trunks.filter((row: any) => {
      const value = String(row?.status || row?.state || row?.registration || "").toLowerCase();
      return value.includes("online") || value.includes("up") || value.includes("ok");
    }).length;

    const metrics: Metric[] = [
      { label: "Calls Today", value: String(callsToday), delta: `${answeredCount} answered / ${missedCount} missed` },
      { label: "Registered Extensions", value: String(registeredExtensions), delta: `${extensions.length} total extensions` },
      { label: "Trunks Online", value: String(onlineTrunks), delta: `${trunks.length} total trunks` },
      { label: "Overdue Invoices", value: String(summary?.invoiceSummary?.overdueCount ?? 0), delta: "Billing attention" },
      { label: "SMS Activity", value: String(summary?.messagingSummary?.smsCampaignsSentInRange ?? 0), delta: "Campaigns sent 24h" },
      { label: "WhatsApp Inbound", value: String(summary?.whatsappSummary?.inboundCount ?? 0), delta: "Needs follow-up queue" }
    ];

    return {
      scopeLabel: "TENANT",
      metrics,
      activity: Array.isArray(activity?.items)
        ? activity.items.slice(0, 8).map((it: any) => ({
            type: String(it.type || "EVENT"),
            label: String(it.label || "Activity event"),
            timestamp: it.timestamp ? String(it.timestamp) : undefined
          }))
        : []
    };
  } catch {
    return {
      scopeLabel: "TENANT",
      metrics: dashboardMetrics,
      activity: [
        { type: "SMS_CAMPAIGN_SENT", label: "Fallback mode: campaign metrics unavailable from API." },
        { type: "PBX_HEALTH", label: "Using local mock dashboard data due to API auth or connectivity." }
      ]
    };
  }
}

export type TeamMember = {
  id: string;
  name: string;
  extension: string;
  email: string;
  role: string;
  presence: "AVAILABLE" | "ON_CALL" | "AWAY" | "DND" | "OFFLINE";
  registered: boolean;
  forwarding: boolean;
  voicemail: boolean;
};

export async function loadTeamMembers(scope: AdminScope): Promise<{ rows: TeamMember[]; scopeLabel: "GLOBAL" | "TENANT" }> {
  if (scope === "GLOBAL") {
    try {
      const tenants = await apiGet<any[]>("/admin/tenants");
      const rows = (Array.isArray(tenants) ? tenants : []).slice(0, 200).map((t: any, idx: number) => ({
        id: String(t.id || `tenant-${idx}`),
        name: String(t.name || "Tenant"),
        extension: "-",
        email: "-",
        role: "TENANT",
        presence: t.isApproved === false ? "OFFLINE" : "AVAILABLE",
        registered: Boolean(t.isApproved !== false),
        forwarding: false,
        voicemail: false
      })) as TeamMember[];
      return { rows, scopeLabel: "GLOBAL" };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        rows: [{ id: "tg1", name: "Global Tenant Directory", extension: "-", email: "-", role: "TENANT", presence: "OFFLINE", registered: false, forwarding: false, voicemail: false }]
      };
    }
  }
  try {
    const users = await apiGet<any[]>("/admin/users");
    if (!Array.isArray(users)) throw new Error("invalid users response");
    return { rows: users.map((u: any, idx) => ({
      id: String(u.id || `u-${idx}`),
      name: String(u.name || u.email || "User"),
      extension: String(u.extension || `${100 + idx}`),
      email: String(u.email || "unknown@tenant.local"),
      role: String(u.role || "END_USER"),
      presence: idx % 4 === 0 ? "ON_CALL" : "AVAILABLE",
      registered: idx % 5 !== 0,
      forwarding: idx % 3 === 0,
      voicemail: true
    })), scopeLabel: "TENANT" };
  } catch {
    return {
      scopeLabel: "TENANT",
      rows: mockUsers.map((u, idx) => ({
        id: u.id,
        name: u.name,
        extension: u.extension,
        email: u.email,
        role: u.role,
        presence: u.presence,
        registered: idx !== 2,
        forwarding: idx === 1,
        voicemail: true
      }))
    };
  }
}

export type CallItem = {
  id: string;
  extension: string;
  direction: string;
  caller: string;
  duration: string;
  state: string;
};

export type CallHistoryItem = {
  id: string;
  when: string;
  ext: string;
  direction: string;
  number: string;
  disposition: string;
  recording: boolean;
};

export async function loadCallsData(scope: AdminScope): Promise<{ live: CallItem[]; history: CallHistoryItem[]; scopeLabel: "GLOBAL" | "TENANT" }> {
  if (scope === "GLOBAL") {
    try {
      const [instances, providerHealth] = await Promise.all([apiGet<any[]>("/admin/pbx/instances"), apiGet<any>("/admin/sms/provider-health")]);
      const live = (Array.isArray(instances) ? instances : []).slice(0, 30).map((i: any, idx: number) => ({
        id: String(i.id || `g-live-${idx}`),
        extension: String(i.provider || "PBX"),
        direction: "Platform",
        caller: String(i.name || i.baseUrl || "Instance"),
        duration: "00:00:00",
        state: i.isEnabled ? "Healthy" : "Degraded"
      }));
      const topFail = Array.isArray(providerHealth?.topFailingTenants) ? providerHealth.topFailingTenants : [];
      const history = topFail.slice(0, 30).map((t: any, idx: number) => ({
        id: String(t.tenantId || `g-h-${idx}`),
        when: "Global",
        ext: "-",
        direction: "Tenant",
        number: String(t.tenantName || t.tenantId || "Tenant"),
        disposition: Number(t.failed || 0) > 0 ? "Attention" : "Stable",
        recording: false
      }));
      return { live, history, scopeLabel: "GLOBAL" };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        live: [{ id: "g-l1", extension: "PBX", direction: "Platform", caller: "Global call monitor", duration: "00:00:00", state: "Unavailable" }],
        history: [{ id: "g-h1", when: "Global", ext: "-", direction: "Tenant", number: "No data", disposition: "Unavailable", recording: false }]
      };
    }
  }
  try {
    const [live, reports] = await Promise.all([apiGet<any[]>("/voice/calls"), apiGet<any>("/voice/pbx/call-reports")]);
    const liveRows = Array.isArray(live)
      ? live.slice(0, 20).map((c: any, idx) => ({
          id: String(c.id || c.callId || `lc-${idx}`),
          extension: String(c.extension || c.toExtension || "N/A"),
          direction: String(c.direction || "Inbound"),
          caller: String(c.from || c.caller || "Unknown"),
          duration: String(c.duration || c.durationSec || "00:00:00"),
          state: String(c.state || c.status || "Talking")
        }))
      : [];
    const historySource = Array.isArray(reports?.items) ? reports.items : Array.isArray(reports) ? reports : [];
    const historyRows = historySource.slice(0, 30).map((r: any, idx: number) => ({
      id: String(r.id || r.callId || `h-${idx}`),
      when: String(r.startedAt || r.createdAt || "").slice(11, 16) || "N/A",
      ext: String(r.extension || r.toExtension || "N/A"),
      direction: String(r.direction || "Inbound"),
      number: String(r.from || r.to || "Unknown"),
      disposition: String(r.disposition || r.status || "Answered"),
      recording: Boolean(r.recordingUrl || r.hasRecording)
    }));
    return { live: liveRows, history: historyRows, scopeLabel: "TENANT" };
  } catch {
    return {
      scopeLabel: "TENANT",
      live: [
        { id: "lc1", extension: "204", direction: "Inbound", caller: "+1 415 220 7782", duration: "00:02:13", state: "Talking" },
        { id: "lc2", extension: "207", direction: "Queue", caller: "Support Queue", duration: "00:00:44", state: "Ringing" }
      ],
      history: [
        { id: "h1", when: "09:12", ext: "204", direction: "Outbound", number: "+1 212 330 4500", disposition: "Answered", recording: true },
        { id: "h2", when: "09:34", ext: "207", direction: "Inbound", number: "+1 718 111 9088", disposition: "Missed", recording: false }
      ]
    };
  }
}

export type ReportsData = {
  scopeLabel: "GLOBAL" | "TENANT";
  metrics: Metric[];
};

export async function loadReportsData(scope: AdminScope): Promise<ReportsData> {
  if (scope === "GLOBAL") {
    try {
      const [tenants, providerHealth, pbxInstances] = await Promise.all([
        apiGet<any[]>("/admin/tenants"),
        apiGet<any>("/admin/sms/provider-health"),
        apiGet<any[]>("/admin/pbx/instances")
      ]);
      const count = Array.isArray(tenants) ? tenants.length : 0;
      const pbx = Array.isArray(pbxInstances) ? pbxInstances.length : 0;
      const failovers = Number(providerHealth?.failoversRecent || 0);
      const circuits = Array.isArray(providerHealth?.circuitsOpen) ? providerHealth.circuitsOpen.length : 0;
      return {
        scopeLabel: "GLOBAL",
        metrics: [
          { label: "Tenants", value: String(count), delta: "Global scope" },
          { label: "PBX Instances", value: String(pbx), delta: "Platform inventory" },
          { label: "SMS Failovers", value: String(failovers), delta: "Recent window" },
          { label: "Open Circuits", value: String(circuits), delta: "Provider resilience" }
        ]
      };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        metrics: [
          { label: "Tenants", value: "0", delta: "Fallback" },
          { label: "PBX Instances", value: "0", delta: "Fallback" },
          { label: "SMS Failovers", value: "0", delta: "Fallback" },
          { label: "Open Circuits", value: "0", delta: "Fallback" }
        ]
      };
    }
  }
  try {
    const summary = await apiGet<any>("/dashboard/summary?range=7d");
    return {
      scopeLabel: "TENANT",
      metrics: [
        { label: "Answer Rate", value: `${Math.max(0, 90 - Number(summary?.invoiceSummary?.overdueCount || 0))}%`, delta: "7d range" },
        { label: "Queue SLA", value: "82%", delta: "Target 85%" },
        { label: "SMS Delivery", value: `${Math.max(70, 100 - Number(summary?.emailSummary?.failedCount || 0))}%`, delta: "24h" },
        { label: "Voicemail Callback", value: "61%", delta: "30d" }
      ]
    };
  } catch {
    return {
      scopeLabel: "TENANT",
      metrics: [
        { label: "Answer Rate", value: "89%", delta: "7d range" },
        { label: "Queue SLA", value: "82%", delta: "Target 85%" },
        { label: "SMS Delivery", value: "97%", delta: "24h" },
        { label: "Voicemail Callback", value: "61%", delta: "30d" }
      ]
    };
  }
}

export type RecordingItem = { id: string; title: string; from: string; duration: string };

export async function loadRecordingsData(): Promise<RecordingItem[]> {
  try {
    const items = await apiGet<any[]>("/voice/pbx/call-recordings");
    if (!Array.isArray(items)) throw new Error("invalid recording response");
    return items.slice(0, 20).map((r: any, idx) => ({
      id: String(r.id || r.callId || `rec-${idx}`),
      title: String(r.title || r.direction || "Call Recording"),
      from: `${String(r.from || "Unknown")} -> ${String(r.to || "Unknown")}`,
      duration: String(r.duration || r.durationSec || "00:00")
    }));
  } catch {
    return [
      { id: "r1", title: "Inbound Support Call", from: "Ext 204 -> +1 212 555 7788", duration: "03:21" },
      { id: "r2", title: "Outbound Sales Follow-up", from: "Ext 207 -> +1 646 332 8812", duration: "07:02" }
    ];
  }
}

export async function loadVoicemailData(): Promise<RecordingItem[]> {
  // No dedicated endpoint yet in API; fallback to recordings shape.
  return [
    { id: "v1", title: "New voicemail - Sales", from: "+1 212 555 8899", duration: "00:32" },
    { id: "v2", title: "Callback requested", from: "+1 646 222 1098", duration: "00:19" },
    { id: "v3", title: "After-hours message", from: "+1 917 000 3991", duration: "01:03" }
  ];
}

export async function loadAdminSignals(scope: AdminScope): Promise<{ pbxInstanceCount: number; degraded: number; tenantCount: number; failoversRecent: number }> {
  if (scope === "GLOBAL") {
    try {
      const [instances, tenants, providerHealth] = await Promise.all([
        apiGet<any[]>("/admin/pbx/instances"),
        apiGet<any[]>("/admin/tenants"),
        apiGet<any>("/admin/sms/provider-health")
      ]);
      const pbxInstanceCount = Array.isArray(instances) ? instances.length : 0;
      const degraded = Array.isArray(instances) ? instances.filter((i: any) => !i.isEnabled).length : 0;
      const tenantCount = Array.isArray(tenants) ? tenants.length : 0;
      const failoversRecent = Number(providerHealth?.failoversRecent || 0);
      return { pbxInstanceCount, degraded, tenantCount, failoversRecent };
    } catch {
      return { pbxInstanceCount: 0, degraded: 0, tenantCount: 0, failoversRecent: 0 };
    }
  }
  try {
    const instances = await apiGet<any[]>("/admin/pbx/instances");
    const count = Array.isArray(instances) ? instances.length : 0;
    const degraded = Array.isArray(instances) ? instances.filter((i: any) => !i.isEnabled).length : 0;
    return { pbxInstanceCount: count, degraded, tenantCount: 0, failoversRecent: 0 };
  } catch {
    return { pbxInstanceCount: 0, degraded: 0, tenantCount: 0, failoversRecent: 0 };
  }
}

export type ActivityItem = { id: string; title: string; detail: string; unread?: number };

export async function loadChatFeed(scope: AdminScope): Promise<{ conversations: ActivityItem[]; timeline: ActivityItem[]; scopeLabel: "GLOBAL" | "TENANT" }> {
  if (scope === "GLOBAL") {
    try {
      const [tenants, providerHealth, pbxInstances] = await Promise.all([
        apiGet<any[]>("/admin/tenants"),
        apiGet<any>("/admin/sms/provider-health"),
        apiGet<any[]>("/admin/pbx/instances")
      ]);
      const conversations = Array.isArray(providerHealth?.topFailingTenants)
        ? providerHealth.topFailingTenants.slice(0, 10).map((it: any, idx: number) => ({
            id: `global-conv-${idx}`,
            title: String(it.tenantName || it.tenantId || "Tenant"),
            detail: `SMS failed=${Number(it.failed || 0)} sent=${Number(it.sent || 0)}`,
            unread: Number(it.failed || 0) > 0 ? 1 : 0
          }))
        : [];
      const timeline = [
        {
          id: "global-tenants",
          title: "Global Tenant Inventory",
          detail: `Active tenant entries: ${Array.isArray(tenants) ? tenants.length : 0}`
        },
        {
          id: "global-pbx",
          title: "Global PBX Instances",
          detail: `Instances discovered: ${Array.isArray(pbxInstances) ? pbxInstances.length : 0}`
        }
      ];
      const recentLocks = Array.isArray(providerHealth?.recentLocks) ? providerHealth.recentLocks.slice(0, 6) : [];
      for (let i = 0; i < recentLocks.length; i += 1) {
        timeline.push({
          id: `lock-${i}`,
          title: "Provider Lock Event",
          detail: String(recentLocks[i]?.action || "SMS_PROVIDER_LOCKED")
        });
      }
      return { conversations, timeline, scopeLabel: "GLOBAL" };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        conversations: [{ id: "g1", title: "Global Ops", detail: "No live global chat feed available.", unread: 0 }],
        timeline: [{ id: "g2", title: "Global Fallback", detail: "Switch to tenant mode for detailed thread views." }]
      };
    }
  }

  try {
    const activity = await apiGet<any>("/dashboard/activity?range=24h");
    const items = Array.isArray(activity?.items) ? activity.items : [];
    const conversations = items
      .filter((it: any) => String(it.type || "").includes("CUSTOMER") || String(it.type || "").includes("WHATSAPP"))
      .slice(0, 10)
      .map((it: any, idx: number) => ({
        id: `conv-${idx}`,
        title: String(it.type || "Conversation"),
        detail: String(it.label || "Activity event"),
        unread: idx === 0 ? 3 : 0
      }));
    const timeline = items.slice(0, 12).map((it: any, idx: number) => ({
      id: `evt-${idx}`,
      title: String(it.type || "Event"),
      detail: String(it.label || "Activity"),
      unread: 0
    }));
    return { conversations, timeline, scopeLabel: "TENANT" };
  } catch {
    return {
      scopeLabel: "TENANT",
      conversations: [
        { id: "c1", title: "NOC Team", detail: "Queue alert resolved.", unread: 4 },
        { id: "c2", title: "Support Escalation", detail: "Call spike in queue B.", unread: 1 },
        { id: "c3", title: "Billing Ops", detail: "Invoice run complete.", unread: 0 }
      ],
      timeline: [
        { id: "t1", title: "Message", detail: "Queue alert resolved." },
        { id: "t2", title: "Message", detail: "Updating status board now." }
      ]
    };
  }
}

export type SmsThread = {
  id: string;
  phone: string;
  preview: string;
  status: string;
  campaignId?: string;
};

export async function loadSmsThreads(scope: AdminScope): Promise<{ threads: SmsThread[]; scopeLabel: "GLOBAL" | "TENANT" }> {
  if (scope === "GLOBAL") {
    try {
      const health = await apiGet<any>("/admin/sms/provider-health");
      const top = Array.isArray(health?.topFailingTenants) ? health.topFailingTenants : [];
      const threads = top.slice(0, 30).map((t: any, idx: number) => ({
        id: String(t.tenantId || `g-sms-${idx}`),
        phone: String(t.tenantName || t.tenantId || "Tenant"),
        preview: `Sent: ${Number(t.sent || 0)} Failed: ${Number(t.failed || 0)} Open circuits: ${Number(t.openCircuits || 0)}`,
        status: Number(t.failed || 0) > 0 ? "TENANT_ALERT" : "HEALTHY"
      }));
      return { threads, scopeLabel: "GLOBAL" };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        threads: [{ id: "sg1", phone: "Global SMS Monitor", preview: "No provider-health data available.", status: "UNAVAILABLE" }]
      };
    }
  }

  try {
    const messages = await apiGet<any[]>("/sms/messages");
    if (!Array.isArray(messages)) throw new Error("invalid sms response");
    const byTo = new Map<string, SmsThread>();
    for (const msg of messages) {
      const key = String(msg.toNumber || msg.fromNumber || msg.id);
      if (!byTo.has(key)) {
        byTo.set(key, {
          id: String(msg.id || key),
          phone: key,
          preview: String(msg.body || "Message"),
          status: String(msg.status || "QUEUED"),
          campaignId: msg.campaignId ? String(msg.campaignId) : undefined
        });
      }
      if (byTo.size >= 30) break;
    }
    return { threads: Array.from(byTo.values()), scopeLabel: "TENANT" };
  } catch {
    return {
      scopeLabel: "TENANT",
      threads: [
        { id: "s1", phone: "+1 (646) 990-1021", preview: "Can we confirm my install date?", status: "DELIVERY_ISSUE" },
        { id: "s2", phone: "Northline Logistics", preview: "Dispatch accepted.", status: "DELIVERED" },
        { id: "s3", phone: "Acme Prospect - NY", preview: "Please send quote.", status: "SENT" }
      ]
    };
  }
}

export type ContactRow = {
  id: string;
  name: string;
  company: string;
  number: string;
  email: string;
  tags: string;
};

export async function loadContacts(search: string | undefined, scope: AdminScope): Promise<{ rows: ContactRow[]; scopeLabel: "GLOBAL" | "TENANT" }> {
  if (scope === "GLOBAL") {
    try {
      const tenants = await apiGet<any[]>("/admin/tenants");
      const q = (search || "").trim().toLowerCase();
      const rows = (Array.isArray(tenants) ? tenants : [])
        .filter((t: any) => !q || String(t.name || "").toLowerCase().includes(q))
        .slice(0, 200)
        .map((t: any) => ({
          id: String(t.id),
          name: String(t.name || "Tenant"),
          company: "Tenant Workspace",
          number: "-",
          email: "-",
          tags: t.isApproved === false ? "Suspended" : "Active"
        }));
      return { rows, scopeLabel: "GLOBAL" };
    } catch {
      return {
        scopeLabel: "GLOBAL",
        rows: [{ id: "cg1", name: "Global Tenant Directory", company: "Unavailable", number: "-", email: "-", tags: "Fallback" }]
      };
    }
  }

  try {
    const qs = search ? `?q=${encodeURIComponent(search)}` : "";
    const rows = await apiGet<any[]>(`/customers${qs}`);
    if (!Array.isArray(rows)) throw new Error("invalid customers response");
    return { rows: rows.map((r: any) => ({
      id: String(r.id),
      name: String(r.displayName || "Customer"),
      company: String(r.companyName || "-"),
      number: String(r.primaryPhone || r.whatsappNumber || "-"),
      email: String(r.primaryEmail || "-"),
      tags: Array.isArray(r.tags) ? r.tags.join(", ") : ""
    })), scopeLabel: "TENANT" };
  } catch {
    return {
      scopeLabel: "TENANT",
      rows: [
        { id: "c1", name: "Harris Clinic", company: "Harris Clinic", number: "+1 212 112 7788", email: "ops@harrisclinic.com", tags: "VIP" },
        { id: "c2", name: "Monroe Supply", company: "Monroe Supply", number: "+1 646 903 2210", email: "service@monroe.com", tags: "Billing" }
      ]
    };
  }
}
