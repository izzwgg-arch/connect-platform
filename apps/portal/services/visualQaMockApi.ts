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

const funderTags = [
  { id: "fund-tag-health", name: "Health", color: "#10b981" },
  { id: "fund-tag-wellness", name: "Wellness", color: "#8b5cf6" },
  { id: "fund-tag-community", name: "Community", color: "#f97316" },
  { id: "fund-tag-education", name: "Education", color: "#0ea5e9" },
  { id: "fund-tag-youth", name: "Youth", color: "#ec4899" },
];

const funders = [
  funder("fd-001", "Sun Wellness Foundation", "Foundation", "grants@sunwellness.org", "(555) 123-4567", "Austin", "TX", "ACTIVE", ["fund-tag-health", "fund-tag-wellness"], 1),
  funder("fd-002", "Healthy Futures Grantmakers", "Grantmaker", "info@healthyfutures.org", "(555) 987-6543", "Denver", "CO", "ACTIVE", ["fund-tag-health", "fund-tag-youth"], 2),
  funder("fd-003", "Community Care Fund", "Nonprofit", "partners@communitycare.org", "(555) 456-7890", "Portland", "OR", "PROSPECT", ["fund-tag-community"], 3),
  funder("fd-004", "Wellness Impact Partners", "Foundation", "hello@wellnessimpact.org", "(555) 234-1188", "Seattle", "WA", "ACTIVE", ["fund-tag-wellness"], 4),
  funder("fd-005", "Bright Health Initiative", "Grantmaker", "contact@brighthealth.org", "(555) 564-8821", "Chicago", "IL", "INACTIVE", ["fund-tag-health", "fund-tag-education"], 5),
  funder("fd-006", "Care Access Foundation", "Foundation", "funding@careaccess.org", "(555) 772-4100", "Boston", "MA", "PROSPECT", ["fund-tag-health"], 6),
  funder("fd-007", "Youth Forward Fund", "Nonprofit", "team@youthforward.org", "(555) 310-9090", "Phoenix", "AZ", "PENDING", ["fund-tag-youth"], 7),
  funder("fd-008", "Wellbeing Collective", "Foundation", "hello@wellbeingcollective.org", "(555) 889-1122", "Nashville", "TN", "ACTIVE", ["fund-tag-wellness", "fund-tag-community"], 8),
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

function task(
  id: string,
  entry: ReturnType<typeof contact>,
  title: string,
  body: string,
  priority: string,
  status: string,
  dueAt: string,
  ownerId: string,
  completedAt: string | null,
) {
  const owner = users.find((user) => user.userId === ownerId) ?? users[0];
  return {
    id,
    contactId: entry.id,
    title,
    body,
    dueAt,
    priority,
    status,
    completedAt,
    createdAt: hoursFromNow(-168),
    assignedTo: { id: owner.userId, displayName: owner.displayName },
    contact: { id: entry.id, displayName: entry.displayName, company: entry.company },
  };
}

const tasks = [
  task("task-001", contacts[0], "Follow up call with James Smith", "Solar Summer Outreach", "URGENT", "OPEN", hoursFromNow(-30), "qa-ae-1", null),
  task("task-002", contacts[1], "Send proposal to Maria Garcia", "Solar Summer Outreach", "HIGH", "IN_PROGRESS", hoursFromNow(3), "qa-ae-2", null),
  task("task-003", contacts[2], "Callback Robert Johnson", "Solar Summer Outreach", "MEDIUM", "IN_PROGRESS", hoursFromNow(5), "qa-ae-1", null),
  task("task-004", contacts[3], "Review solar needs assessment", "Enterprise Outreach", "MEDIUM", "OPEN", hoursFromNow(7), "visual-qa-user", null),
  task("task-005", contacts[4], "Schedule site visit with Jennifer Lee", "Enterprise Outreach", "MEDIUM", "OPEN", hoursFromNow(26), "qa-ae-2", null),
  task("task-006", contacts[5], "Send follow-up email", "West Coast Campaign", "LOW", "OPEN", hoursFromNow(50), "visual-qa-user", null),
  task("task-007", contacts[6], "Check in about financing options", "Solar Summer Outreach", "LOW", "OPEN", hoursFromNow(77), "qa-ae-1", null),
  task("task-008", contacts[7], "Update contact notes", "Referral Program", "LOW", "DONE", hoursFromNow(-96), "qa-ae-2", hoursFromNow(-48)),
  task("task-009", contacts[0], "Thank you call", "Solar Summer Outreach", "LOW", "DONE", hoursFromNow(-120), "visual-qa-user", hoursFromNow(-72)),
  task("task-010", contacts[2], "Prepare custom proposal", "Enterprise Outreach", "MEDIUM", "DONE", hoursFromNow(-144), "qa-ae-1", hoursFromNow(-120)),
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
          "can_view_crm_funders",
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
        myOpen: tasks.filter((entry) => entry.assignedTo?.id === "visual-qa-user" && isOpenTask(entry)).length,
        dueToday: tasks.filter((entry) => isOpenTask(entry) && isDueToday(entry)).length,
        overdue: tasks.filter((entry) => isOpenTask(entry) && isOverdue(entry)).length,
        callsLinkedToday: 18,
        dispositionsToday: 11,
        activeCampaigns: 2,
        queueRemaining: 98,
        myOverdueCallbacks: 1,
        myCallbacksDueToday: 4,
        myTasksOverdue: tasks.filter((entry) => entry.assignedTo?.id === "visual-qa-user" && isOpenTask(entry) && isOverdue(entry)).length,
        myTasksDueToday: tasks.filter((entry) => entry.assignedTo?.id === "visual-qa-user" && isOpenTask(entry) && isDueToday(entry)).length,
      },
    };
  }

  if (pathname === "/crm/tasks") {
    let rows = [...tasks];
    const status = parsed.searchParams.get("status") ?? "open";
    const due = parsed.searchParams.get("due");
    const assignedTo = parsed.searchParams.get("assignedTo");
    const limit = Number(parsed.searchParams.get("limit") ?? "50");

    if (assignedTo === "me") rows = rows.filter((entry) => entry.assignedTo?.id === "visual-qa-user");
    if (status === "open") rows = rows.filter(isOpenTask);
    else if (status && status !== "all") rows = rows.filter((entry) => entry.status === status);
    if (due === "today") rows = rows.filter(isDueToday);
    else if (due === "overdue") rows = rows.filter(isOverdue);
    else if (due === "upcoming") rows = rows.filter((entry) => isOpenTask(entry) && !isDueToday(entry) && !isOverdue(entry));

    rows.sort((a, b) => {
      const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aDue - bDue || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return { handled: true, data: { rows: rows.slice(0, limit), total: rows.length, page: 0, limit } };
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
        callbacks: {
          overdue: {
            count: 1,
            rows: queueMembers
              .filter((member) => member.status === "CALLBACK" && member.callbackAt && new Date(member.callbackAt).getTime() < now.getTime())
              .map((member) => followUpMember(member)),
          },
          dueToday: {
            count: 4,
            rows: queueMembers
              .filter((member) => member.status === "CALLBACK")
              .slice(0, 4)
              .map((member) => followUpMember(member)),
          },
        },
        tasks: {
          overdue: {
            count: 1,
            rows: tasks.filter((entry) => isOpenTask(entry) && isOverdue(entry)).slice(0, 2).map((entry) => followUpTask(entry)),
          },
          dueToday: {
            count: 3,
            rows: tasks.filter((entry) => isOpenTask(entry) && isDueToday(entry)).slice(0, 3).map((entry) => followUpTask(entry)),
          },
        },
      },
    };
  }

  if (pathname === "/crm/reports/agents") {
    return {
      handled: true,
      data: {
        agents: [
          agentReport(users[0], "Sales Lead", 32, 5, 24, 3, 2, ["101"]),
          agentReport(users[1], "Account Executive", 28, 2, 19, 2, 4, ["102"]),
          agentReport(users[2], "Account Executive", 21, 1, 13, 1, 3, ["103"]),
          {
            userId: "qa-ae-3",
            displayName: "Elena Torres",
            email: "elena@connect.local",
            crmRole: "Sales Rep",
            assignedQueue: 18,
            callbacksDueToday: 0,
            dispositionsToday: 12,
            convertedLast: 1,
            openTasks: 1,
            extensions: ["104"],
          },
          {
            userId: "qa-ae-4",
            displayName: "David Kim",
            email: "david@connect.local",
            crmRole: "Support",
            assignedQueue: 0,
            callbacksDueToday: 0,
            dispositionsToday: 0,
            convertedLast: 0,
            openTasks: 0,
            extensions: ["105"],
          },
        ],
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
    return {
      handled: true,
      data: {
        scripts: [
          {
            id: "script-energy",
            name: "Consultative outreach",
            isActive: true,
            createdAt: "2026-05-20T14:30:00.000Z",
            updatedAt: "2026-05-26T20:45:00.000Z",
          },
        ],
      },
    };
  }

  if (pathname === "/crm/scripts/script-energy") {
    return {
      handled: true,
      data: {
        script: {
          id: "script-energy",
          name: "Consultative outreach",
          isActive: true,
          createdAt: "2026-05-20T14:30:00.000Z",
          updatedAt: "2026-05-26T20:45:00.000Z",
          body: "# Opening\nHi, this is [Your Name] from Connect Solar. Is this a good time to talk for a minute about lowering your electric bill?\n\n---\n\n# Discovery / Qualification\nHave you looked into solar before?\n\nWhat is your biggest goal with solar?\n\n---\n\n# Value Proposition\nWe help homeowners reduce energy costs and take advantage of available incentives with no pressure.",
        },
      },
    };
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

  if (pathname === "/crm/funders/stats") {
    return {
      handled: true,
      data: {
        total: funders.length,
        active: funders.filter((entry) => entry.status === "ACTIVE").length,
        prospects: funders.filter((entry) => entry.status === "PROSPECT").length,
        recentlyAdded: 3,
      },
    };
  }

  if (pathname === "/crm/funder-tags") {
    return { handled: true, data: { tags: funderTags } };
  }

  if (pathname === "/crm/funders") {
    const q = (parsed.searchParams.get("q") || "").toLowerCase();
    const status = parsed.searchParams.get("status");
    const tagId = parsed.searchParams.get("tagId");
    const page = Number(parsed.searchParams.get("page") || 0);
    const limit = Number(parsed.searchParams.get("limit") || 50);
    const filtered = funders.filter((entry) => {
      if (status && status !== "all" && entry.status !== status) return false;
      if (tagId && !entry.tags.some((tag) => tag.id === tagId)) return false;
      if (!q) return true;
      return [entry.name, entry.organization, entry.email, entry.phone, entry.city, entry.state].some((value) =>
        String(value || "").toLowerCase().includes(q),
      );
    });
    return { handled: true, data: { rows: filtered.slice(page * limit, page * limit + limit), total: filtered.length, page, limit } };
  }

  const contactDetailMatch = pathname.match(/^\/crm\/contacts\/([^/]+)$/);
  if (contactDetailMatch) {
    const entry = contacts.find((contact) => contact.id === contactDetailMatch[1]) ?? contacts[0];
    return {
      handled: true,
      data: {
        contact: {
          ...entry,
          phones: [{ id: `${entry.id}-phone`, type: "MOBILE", numberRaw: entry.primaryPhone.numberRaw, isPrimary: true }],
          emails: [{ id: `${entry.id}-email`, type: "WORK", email: entry.primaryEmail.email, isPrimary: true }],
          location: "San Francisco, CA",
          leadScore: 89,
          lastDisposition: "Interested",
        },
      },
    };
  }

  const contactTasksMatch = pathname.match(/^\/crm\/contacts\/([^/]+)\/tasks$/);
  if (contactTasksMatch) {
    return {
      handled: true,
      data: {
        tasks: [
          { id: "task-live-1", title: "Send solar savings estimate", priority: "HIGH", status: "OPEN", dueAt: hoursFromNow(4), assignedTo: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
          { id: "task-live-2", title: "Confirm financing preference", priority: "MEDIUM", status: "OPEN", dueAt: hoursFromNow(26), assignedTo: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
        ],
      },
    };
  }

  const contactTimelineMatch = pathname.match(/^\/crm\/contacts\/([^/]+)\/timeline$/);
  if (contactTimelineMatch) {
    return {
      handled: true,
      data: {
        events: [
          { id: "tl-live-1", type: "CDR_OUTBOUND", title: "Call connected", body: "Connected with the lead.", createdAt: hoursFromNow(-0.1), createdBy: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
          { id: "tl-live-2", type: "NOTE_ADDED", title: "Note added", body: "Interested in solar after hearing financing options.", createdAt: hoursFromNow(-1.2), createdBy: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
          { id: "tl-live-3", type: "SMS_SENT", title: "Email sent", body: "Sent savings estimate and next steps.", createdAt: hoursFromNow(-3), createdBy: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
          { id: "tl-live-4", type: "DISPOSITION_SET", title: "Disposition set", body: "Interested", createdAt: hoursFromNow(-20), createdBy: { id: "visual-qa-user", displayName: "CRM Visual QA" } },
        ],
      },
    };
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

function startOfVisualQaDay(): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function isOpenTask(entry: ReturnType<typeof task>): boolean {
  return entry.status === "OPEN" || entry.status === "IN_PROGRESS";
}

function isDueToday(entry: ReturnType<typeof task>): boolean {
  if (!entry.dueAt) return false;
  const start = startOfVisualQaDay();
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const due = new Date(entry.dueAt);
  return due >= start && due < end;
}

function isOverdue(entry: ReturnType<typeof task>): boolean {
  if (!entry.dueAt) return false;
  return new Date(entry.dueAt) < startOfVisualQaDay();
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

function funder(
  id: string,
  name: string,
  organization: string,
  email: string,
  phone: string,
  city: string,
  state: string,
  status: string,
  tagIds: string[],
  daysAgo: number,
) {
  return {
    id,
    tenantId: "visual-qa-tenant",
    name,
    organization,
    email,
    phone,
    phone2: null,
    city,
    state,
    zip: "00000",
    notes: null,
    status,
    active: true,
    archivedAt: null,
    tags: funderTags.filter((tag) => tagIds.includes(tag.id)),
    createdAt: hoursFromNow(-24 * (daysAgo + 4)),
    updatedAt: hoursFromNow(-24 * daysAgo),
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

function followUpMember(member: ReturnType<typeof queueMember>) {
  return {
    id: member.id,
    contactId: member.contactId,
    contactName: member.contact.displayName,
    contactPhone: member.contact.primaryPhone,
    campaign: member.campaign ? { id: member.campaign.id, name: member.campaign.name } : null,
    assignedTo: member.assignedTo ? { id: member.assignedTo.id, name: member.assignedTo.displayName } : null,
    callbackAt: member.callbackAt,
    callbackNote: member.callbackNote,
    attemptCount: member.attemptCount,
  };
}

function followUpTask(entry: ReturnType<typeof task>) {
  return {
    id: entry.id,
    contactId: entry.contactId,
    contactName: entry.contact.displayName,
    title: entry.title,
    dueAt: entry.dueAt,
    priority: entry.priority,
    assignedTo: entry.assignedTo ? { id: entry.assignedTo.id, name: entry.assignedTo.displayName } : null,
  };
}

function agentReport(
  user: (typeof users)[number],
  crmRole: string,
  assignedQueue: number,
  callbacksDueToday: number,
  dispositionsToday: number,
  convertedLast: number,
  openTasks: number,
  extensions: string[],
) {
  return {
    userId: user.userId,
    displayName: user.displayName,
    email: user.email,
    crmRole,
    assignedQueue,
    callbacksDueToday,
    dispositionsToday,
    convertedLast,
    openTasks,
    extensions,
  };
}

