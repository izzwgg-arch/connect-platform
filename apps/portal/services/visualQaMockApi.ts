import { isVisualQaModeEnabled } from "./visualQaMode";

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type MockResult =
  | { handled: true; data: unknown }
  | { handled: false };

const now = new Date("2026-05-26T14:00:00.000Z");

const users = [
  { userId: "visual-qa-user", displayName: "CRM Visual QA", email: "visual-qa@connect.local", crmEnabled: true },
  { userId: "qa-ae-1", displayName: "Avery Brooks", email: "avery@connect.local", crmEnabled: true },
  { userId: "qa-ae-2", displayName: "Maya Chen", email: "maya@connect.local", crmEnabled: true },
];

const campaigns = [
  campaign("cmp-energy", "Energy Savings Outreach", "Growth outreach campaign", "ACTIVE", "HIGH", 98, 18),
  campaign("cmp-renewals", "Renewal Follow-up Sprint", "Priority renewals for May accounts", "ACTIVE", "NORMAL", 42, 8),
  campaign("cmp-winback", "Winback Priority List", "Paused re-engagement list", "PAUSED", "URGENT", 16, 32),
];

const contacts = [
  contact("ct-001", "Jordan Ellis", "Acme Logistics", "LEAD", "+1 (555) 010-1101", "jordan@acme.example", "qa-ae-1", 1),
  contact("ct-002", "Priya Shah", "Northstar Dental", "CONTACTED", "+1 (555) 010-1102", "priya@northstar.example", "qa-ae-2", 2),
  contact("ct-003", "Marcus Lee", "BrightPath Solar", "QUALIFIED", "+1 (555) 010-1103", "marcus@brightpath.example", "qa-ae-1", 3),
  contact("ct-004", "Sofia Ramirez", "Urban Nest Realty", "CUSTOMER", "+1 (555) 010-1104", "sofia@urbannest.example", "qa-ae-2", 4),
  contact("ct-005", "Evan Brooks", "Harbor Supply Co.", "LEAD", "+1 (555) 010-1105", "evan@harbor.example", "qa-ae-1", 5),
  contact("ct-006", "Nina Patel", "Oak & Ivy Clinics", "CONTACTED", "+1 (555) 010-1106", "nina@oakivy.example", "qa-ae-2", 6),
  contact("ct-007", "Theo Martin", "Metro Auto Group", "QUALIFIED", "+1 (555) 010-1107", "theo@metroauto.example", "qa-ae-1", 7),
  contact("ct-008", "Amara Okafor", "Summit Financial", "LEAD", "+1 (555) 010-1108", "amara@summit.example", "qa-ae-2", 8),
];

const queueMembers = [
  queueMember("qm-001", contacts[0], campaigns[0], "PENDING", 0, null, 1),
  queueMember("qm-002", contacts[1], campaigns[0], "CALLBACK", 2, hoursFromNow(-3), 2),
  queueMember("qm-003", contacts[2], campaigns[1], "CALLBACK", 1, hoursFromNow(2), 3),
  queueMember("qm-004", contacts[4], campaigns[0], "PENDING", 0, null, 4),
  queueMember("qm-005", contacts[5], campaigns[1], "PENDING", 1, null, 5),
  queueMember("qm-006", contacts[6], campaigns[0], "CALLBACK", 3, hoursFromNow(26), 6),
  queueMember("qm-007", contacts[7], campaigns[1], "PENDING", 0, null, 7),
];

export function getVisualQaMockResponse(
  method: ApiMethod,
  path: string,
  body?: Record<string, unknown>,
): MockResult {
  if (!isVisualQaModeEnabled()) return { handled: false };

  if (method !== "GET") {
    if (path.startsWith("/crm/")) return { handled: true, data: { ok: true, visualQa: true, body: body ?? null } };
    return { handled: false };
  }

  const parsed = parsePath(path);
  const pathname = parsed.pathname;

  if (pathname === "/me") {
    return {
      handled: true,
      data: {
        tenantId: "visual-qa-tenant",
        tenantName: "Visual QA Workspace",
        role: "SUPER_ADMIN",
        avatarUrl: null,
        portalPermissionSet: [
          "can_view_crm",
          "can_view_section_crm",
          "can_view_crm_dashboard",
          "can_view_crm_contacts",
          "can_manage_crm_contacts",
          "can_view_crm_queue",
          "can_manage_crm_queue",
          "can_view_crm_campaigns",
          "can_view_crm_live_call",
          "can_view_crm_email",
          "can_view_crm_settings",
          "can_manage_crm_campaigns",
          "can_view_crm_import",
          "can_view_crm_reports",
          "can_view_crm_tasks",
          "can_view_crm_scripts",
          "can_view_crm_checklists",
        ],
      },
    };
  }

  if (pathname === "/crm/settings") {
    return { handled: true, data: { enabled: true, defaultQueueSort: "smart", defaultQueueFilter: "pending" } };
  }

  if (pathname === "/crm/contacts/stats") {
    return { handled: true, data: { total: 1284, leads: 412, mine: 86, recentlyAdded: 24 } };
  }

  if (pathname === "/crm/tasks/stats") {
    return {
      handled: true,
      data: {
        myOpen: 12,
        dueToday: 5,
        overdue: 2,
        callsLinkedToday: 18,
        dispositionsToday: 11,
        activeCampaigns: 2,
        queueRemaining: 98,
        myOverdueCallbacks: 1,
        myCallbacksDueToday: 4,
        myTasksOverdue: 1,
        myTasksDueToday: 3,
      },
    };
  }

  if (pathname === "/crm/reports/daily") {
    return {
      handled: true,
      data: {
        dispositionsToday: 11,
        callsLinkedToday: 18,
        contactsCreatedToday: 7,
        tasksDueToday: 5,
        overdueTasks: 2,
        callbacksDueToday: 4,
        overdueCallbacks: 1,
        activeCampaigns: 2,
        queueRemaining: 98,
      },
    };
  }

  if (pathname === "/crm/reports/follow-ups") {
    return {
      handled: true,
      data: {
        callbacks: { overdue: { count: 1 }, dueToday: { count: 4 } },
        tasks: { overdue: { count: 1 }, dueToday: { count: 3 } },
      },
    };
  }

  if (pathname === "/crm/admin/pilot-readiness") {
    return {
      handled: true,
      data: {
        crmEnabled: true,
        usersWithCrmAccess: 8,
        activeCampaigns: 2,
        queuePendingOrInProgress: 98,
        overdueCallbacks: 1,
        smsProviderConfigured: true,
        smsReadinessApplicable: true,
      },
    };
  }

  if (pathname === "/crm/import/batches") {
    return {
      handled: true,
      data: {
        batches: [
          { id: "imp-001", fileName: "energy-leads-may.csv", status: "COMPLETED", createdAt: hoursFromNow(-4), totalRows: 120, processedRows: 120 },
          { id: "imp-002", fileName: "renewals-priority.csv", status: "PROCESSING", createdAt: hoursFromNow(-1), totalRows: 52, processedRows: 37 },
        ],
      },
    };
  }

  if (pathname === "/crm/campaigns") {
    const status = parsed.searchParams.get("status");
    const filtered = status ? campaigns.filter((campaign) => campaign.status === status) : campaigns;
    return { handled: true, data: { campaigns: filtered } };
  }

  if (pathname === "/crm/reports/campaigns") {
    return {
      handled: true,
      data: {
        campaigns: campaigns.map((entry, index) => {
          const related = queueMembers.filter((member) => member.campaign?.id === entry.id);
          const callbacks = related.filter((member) => member.status === "CALLBACK").length;
          const pending = related.filter((member) => member.status === "PENDING" || member.status === "IN_PROGRESS").length;
          const contacted = Math.max(0, Math.round(entry.memberCount * (0.36 + index * 0.08)));
          const converted = Math.max(0, Math.round(entry.memberCount * (0.08 + index * 0.025)));
          return {
            id: entry.id,
            name: entry.name,
            status: entry.status,
            total: entry.memberCount,
            pending,
            contacted,
            callbacks,
            converted,
            dnc: index,
            conversionRate: entry.memberCount > 0 ? Math.round((converted / entry.memberCount) * 1000) / 10 : 0,
            totalAttempts: contacted + callbacks + converted + 12,
            lastActivityAt: entry.updatedAt,
            createdAt: entry.createdAt,
          };
        }),
      },
    };
  }

  const campaignDetailMatch = pathname.match(/^\/crm\/campaigns\/([^/]+)$/);
  if (campaignDetailMatch) {
    const entry = campaigns.find((campaign) => campaign.id === campaignDetailMatch[1]) ?? campaigns[0];
    return {
      handled: true,
      data: {
        campaign: {
          ...entry,
          script: { id: "script-energy", name: "Consultative outreach" },
          checklist: { id: "checklist-standard", name: "Qualification checklist" },
          statusCounts: {
            PENDING: 38,
            IN_PROGRESS: 14,
            CONTACTED: 22,
            CALLBACK: 12,
            CONVERTED: 8,
            SKIPPED: 3,
            DO_NOT_CALL: 1,
          },
        },
      },
    };
  }

  const campaignMembersMatch = pathname.match(/^\/crm\/campaigns\/([^/]+)\/members$/);
  if (campaignMembersMatch) {
    const campaignId = campaignMembersMatch[1];
    const members = queueMembers
      .filter((member) => member.campaign?.id === campaignId)
      .map((member) => ({ ...member, sortOrder: 1, createdAt: hoursFromNow(-36) }));
    return { handled: true, data: { members, total: members.length } };
  }

  const campaignWorkloadMatch = pathname.match(/^\/crm\/campaigns\/([^/]+)\/workload$/);
  if (campaignWorkloadMatch) {
    return {
      handled: true,
      data: {
        workload: [
          { userId: "qa-ae-1", displayName: "Avery Brooks", pending: 22, inProgress: 7, callbacks: 5, contacted: 16, converted: 5, skipped: 1, dnc: 0, total: 56 },
          { userId: "qa-ae-2", displayName: "Maya Chen", pending: 16, inProgress: 7, callbacks: 7, contacted: 14, converted: 3, skipped: 2, dnc: 1, total: 50 },
          { userId: null, displayName: "Unassigned", pending: 6, inProgress: 0, callbacks: 0, contacted: 0, converted: 0, skipped: 0, dnc: 0, total: 6 },
        ],
      },
    };
  }

  if (/^\/crm\/campaigns\/([^/]+)\/imports$/.test(pathname)) {
    return {
      handled: true,
      data: {
        imports: [
          { id: "imp-campaign-1", createdAt: hoursFromNow(-18), completedAt: hoursFromNow(-17), status: "DONE", fileName: "energy-priority.csv", totalRows: 120, processedRows: 120, createdCount: 84, updatedCount: 24, skippedCount: 12, errorCount: 0, createdBy: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
        ],
      },
    };
  }

  if (/^\/crm\/campaigns\/([^/]+)\/contacts\/available$/.test(pathname)) {
    return { handled: true, data: { contacts: contacts.slice(0, 4), total: 4 } };
  }

  if (pathname === "/crm/scripts") {
    return { handled: true, data: { scripts: [{ id: "script-energy", name: "Consultative outreach" }] } };
  }

  if (pathname === "/crm/checklists") {
    return { handled: true, data: { checklists: [{ id: "checklist-standard", name: "Qualification checklist" }] } };
  }

  if (pathname === "/crm/users") {
    return { handled: true, data: { users } };
  }

  if (pathname === "/crm/contacts") {
    const q = (parsed.searchParams.get("q") || "").toLowerCase();
    const stage = parsed.searchParams.get("stage");
    const page = Number(parsed.searchParams.get("page") || 1);
    const limit = Number(parsed.searchParams.get("limit") || 50);
    const filtered = contacts.filter((entry) => {
      if (stage && stage !== "all" && entry.crmStage !== stage) return false;
      if (!q) return true;
      return [entry.displayName, entry.company, entry.primaryEmail?.email].some((value) => String(value || "").toLowerCase().includes(q));
    });
    return { handled: true, data: { rows: filtered.slice(0, limit), total: filtered.length, page, limit } };
  }

  if (pathname === "/crm/queue") {
    const filter = parsed.searchParams.get("filter") || "pending";
    const limit = Number(parsed.searchParams.get("limit") || 25);
    const campaignId = parsed.searchParams.get("campaignId");
    const filtered = queueMembers.filter((member) => {
      if (campaignId && member.campaign?.id !== campaignId) return false;
      if (filter === "due") return Boolean(member.callbackAt && new Date(member.callbackAt).getTime() <= hoursFromNowDate(24).getTime() && new Date(member.callbackAt).getTime() >= now.getTime());
      if (filter === "overdue") return Boolean(member.callbackAt && new Date(member.callbackAt).getTime() < now.getTime());
      if (filter === "upcoming") return Boolean(member.callbackAt && new Date(member.callbackAt).getTime() > hoursFromNowDate(24).getTime());
      return member.status === "PENDING" || member.status === "IN_PROGRESS";
    });
    return {
      handled: true,
      data: {
        queue: filtered.slice(0, limit),
        total: filtered.length,
        counts: { pending: 4, due: 1, overdue: 1, upcoming: 1 },
        sort: parsed.searchParams.get("sort") || "smart",
      },
    };
  }

  return { handled: false };
}

function parsePath(path: string): URL {
  return new URL(path, "http://visual-qa.local");
}

function hoursFromNow(hours: number): string {
  return hoursFromNowDate(hours).toISOString();
}

function hoursFromNowDate(hours: number): Date {
  return new Date(now.getTime() + hours * 3600_000);
}

function campaign(
  id: string,
  name: string,
  description: string,
  status: string,
  priority: string,
  memberCount: number,
  daysAgo: number,
) {
  return {
    id,
    name,
    description,
    status,
    priority,
    scriptId: "script-energy",
    checklistId: "checklist-standard",
    script: { id: "script-energy", name: "Consultative outreach" },
    checklist: { id: "checklist-standard", name: "Qualification checklist" },
    memberCount,
    createdAt: hoursFromNow(-24 * (daysAgo + 24)),
    updatedAt: hoursFromNow(-24 * daysAgo),
  };
}

function contact(
  id: string,
  displayName: string,
  company: string,
  crmStage: string,
  phone: string,
  email: string,
  ownerId: string,
  daysAgo: number,
) {
  const owner = users.find((user) => user.userId === ownerId) ?? users[0];
  return {
    id,
    displayName,
    firstName: displayName.split(" ")[0] ?? displayName,
    lastName: displayName.split(" ").slice(1).join(" ") || null,
    company,
    primaryPhone: { numberRaw: phone },
    primaryEmail: { email },
    crmStage,
    assignedTo: { id: owner.userId, displayName: owner.displayName, email: owner.email },
    doNotCall: false,
    createdAt: hoursFromNow(-24 * (daysAgo + 6)),
    updatedAt: hoursFromNow(-24 * daysAgo),
    lastActivityAt: hoursFromNow(-6 * daysAgo),
    active: true,
    archivedAt: null,
  };
}

function queueMember(
  id: string,
  entry: ReturnType<typeof contact>,
  campaign: (typeof campaigns)[number],
  status: string,
  attemptCount: number,
  callbackAt: string | null,
  sortOrder: number,
) {
  return {
    id,
    contactId: entry.id,
    queueWorkEligible: true,
    contact: {
      id: entry.id,
      displayName: entry.displayName,
      active: true,
      archivedAt: null,
      primaryPhone: entry.primaryPhone?.numberRaw ?? null,
      primaryEmail: entry.primaryEmail?.email ?? null,
      crmStage: entry.crmStage,
      lastActivityAt: entry.lastActivityAt,
      lastDisposition: attemptCount > 0 ? "Left voicemail" : null,
      lastDispositionAt: attemptCount > 0 ? hoursFromNow(-12) : null,
    },
    campaign: { id: campaign.id, name: campaign.name, priority: sortOrder <= 2 ? "HIGH" : "NORMAL", scriptId: null, checklistId: null },
    assignedTo: entry.assignedTo,
    assignedToUserId: entry.assignedTo?.id ?? null,
    status,
    attemptCount,
    lastAttemptAt: attemptCount > 0 ? hoursFromNow(-12) : null,
    callbackAt,
    callbackNote: callbackAt ? "Requested a focused follow-up window." : null,
    sortOrder,
    createdAt: hoursFromNow(-72 + sortOrder),
  };
}

