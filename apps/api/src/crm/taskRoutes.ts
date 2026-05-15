import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, isAdminRole } from "./guard";
import { writeTimelineEvent } from "./timelineHelper";
import { todayBounds } from "./crmAggregateBounds";
import {
  crmCallbackDueInCalendarDayWhere,
  crmCallbackOverdueWhere,
  crmMemberQueueNonTerminalWhere,
} from "./crmMemberQueryFragments";

// ── Schemas ────────────────────────────────────────────────────────────────────

const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const STATUS_VALUES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELED"] as const;

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(5_000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  assignedToUserId: z.string().optional().nullable(),
  priority: z.enum(PRIORITY_VALUES).default("MEDIUM"),
});

const patchTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(5_000).optional().nullable(),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  assignedToUserId: z.string().optional().nullable(),
  priority: z.enum(PRIORITY_VALUES).optional(),
  status: z.enum(STATUS_VALUES).optional(),
});

// ── Shared contact resolver ────────────────────────────────────────────────────

async function resolveContact(
  contactId: string,
  tenantId: string,
  mode: "read" | "mutate",
  role: string | undefined,
) {
  const allowInactive = mode === "read" && isAdminRole(role);
  return (db as any).contact.findFirst({
    where: allowInactive
      ? { id: contactId, tenantId }
      : { id: contactId, tenantId, active: true },
    select: { id: true, displayName: true },
  });
}

// ── Shared task formatter ─────────────────────────────────────────────────────

function formatTask(t: any) {
  return {
    id: t.id,
    contactId: t.contactId,
    title: t.title,
    body: t.body ?? null,
    dueAt: t.dueAt ?? null,
    priority: t.priority as string,
    status: t.status as string,
    completedAt: t.completedAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    assignedTo: t.assignedTo
      ? {
          id: t.assignedTo.id,
          displayName:
            t.assignedTo.displayName ||
            [t.assignedTo.firstName, t.assignedTo.lastName].filter(Boolean).join(" ") ||
            t.assignedTo.email,
        }
      : null,
    completedBy: t.completedBy
      ? {
          id: t.completedBy.id,
          displayName:
            t.completedBy.displayName ||
            [t.completedBy.firstName, t.completedBy.lastName].filter(Boolean).join(" ") ||
            t.completedBy.email,
        }
      : null,
    createdBy: t.createdBy
      ? {
          id: t.createdBy.id,
          displayName:
            t.createdBy.displayName ||
            [t.createdBy.firstName, t.createdBy.lastName].filter(Boolean).join(" ") ||
            t.createdBy.email,
        }
      : null,
    contact: t.contact
      ? { id: t.contact.id, displayName: t.contact.displayName, company: t.contact.company ?? null }
      : undefined,
  };
}

const TASK_INCLUDE = {
  assignedTo: { select: { id: true, firstName: true, lastName: true, displayName: true, email: true } },
  completedBy: { select: { id: true, firstName: true, lastName: true, displayName: true, email: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, displayName: true, email: true } },
} as const;

const TASK_WITH_CONTACT_INCLUDE = {
  ...TASK_INCLUDE,
  contact: { select: { id: true, displayName: true, company: true } },
} as const;

// ── Route registrar ────────────────────────────────────────────────────────────

export async function registerCrmTaskRoutes(app: FastifyInstance) {

  // ── GET /crm/tasks/stats ─────────────────────────────────────────────────
  // Dashboard stat counts. Registered before /crm/tasks to avoid :id capture.
  app.get("/crm/tasks/stats", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const { start: todayStart, end: todayEnd } = todayBounds();

    const [
      myOpen,
      dueToday,
      overdue,
      callsLinkedToday,
      dispositionsToday,
      activeCampaigns,
      queueRemaining,
      myOverdueCallbacks,
      myCallbacksDueToday,
      myTasksOverdue,
      myTasksDueToday,
    ] = await Promise.all([
      (db as any).crmContactTask.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      }),
      (db as any).crmContactTask.count({
        where: {
          tenantId,
          status: { in: ["OPEN", "IN_PROGRESS"] },
          dueAt: { gte: todayStart, lte: todayEnd },
        },
      }),
      (db as any).crmContactTask.count({
        where: {
          tenantId,
          status: { in: ["OPEN", "IN_PROGRESS"] },
          dueAt: { lt: todayStart },
        },
      }),
      (db as any).crmTimelineEvent.count({
        where: {
          tenantId,
          type: { in: ["CDR_INBOUND", "CDR_OUTBOUND"] },
          createdAt: { gte: todayStart },
        },
      }),
      (db as any).crmTimelineEvent.count({
        where: {
          tenantId,
          type: "DISPOSITION_SET",
          createdAt: { gte: todayStart },
        },
      }),
      (db as any).crmCampaign.count({
        where: { tenantId, status: "ACTIVE" },
      }),
      (db as any).crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmMemberQueueNonTerminalWhere({ status: "ACTIVE" }),
        },
      }),
      (db as any).crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmCallbackOverdueWhere(todayStart),
        },
      }),
      (db as any).crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmCallbackDueInCalendarDayWhere(todayStart, todayEnd),
        },
      }),
      (db as any).crmContactTask.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          status: { in: ["OPEN", "IN_PROGRESS"] },
          dueAt: { lt: todayStart },
        },
      }),
      (db as any).crmContactTask.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          status: { in: ["OPEN", "IN_PROGRESS"] },
          dueAt: { gte: todayStart, lte: todayEnd },
        },
      }),
    ]);

    return {
      myOpen,
      dueToday,
      overdue,
      callsLinkedToday,
      dispositionsToday,
      activeCampaigns,
      queueRemaining,
      myOverdueCallbacks,
      myCallbacksDueToday,
      myTasksOverdue,
      myTasksDueToday,
    };
  });

  // ── GET /crm/tasks ───────────────────────────────────────────────────────
  // Global tasks list for the /crm/tasks page. Supports filters.
  app.get("/crm/tasks", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const q = req.query as Record<string, string>;
    const assignedToMe = q.assignedTo === "me";
    const rawStatus = q.status ?? "open";
    const due = q.due; // "today" | "overdue" | "upcoming"
    const page = Math.max(0, parseInt(q.page ?? "0", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "50", 10)));

    const { start: todayStart, end: todayEnd } = todayBounds();

    // Status filter
    let statusFilter: string[] | undefined;
    if (rawStatus === "open") statusFilter = ["OPEN", "IN_PROGRESS"];
    else if (STATUS_VALUES.includes(rawStatus as any)) statusFilter = [rawStatus];
    // else all statuses

    // Due-date filter
    let dueFilter: Record<string, unknown> | undefined;
    if (due === "today") dueFilter = { gte: todayStart, lte: todayEnd };
    else if (due === "overdue") dueFilter = { lt: todayStart };
    else if (due === "upcoming") dueFilter = { gt: todayEnd };

    const where: Record<string, unknown> = { tenantId };
    if (assignedToMe) where.assignedToUserId = userId;
    if (statusFilter) where.status = { in: statusFilter };
    if (dueFilter) where.dueAt = dueFilter;

    const [rows, total] = await Promise.all([
      (db as any).crmContactTask.findMany({
        where,
        include: TASK_WITH_CONTACT_INCLUDE,
        orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip: page * limit,
      }),
      (db as any).crmContactTask.count({ where }),
    ]);

    return { rows: rows.map(formatTask), total, page, limit };
  });

  // ── GET /crm/contacts/:id/tasks ───────────────────────────────────────────
  app.get("/crm/contacts/:id/tasks", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id: contactId } = req.params as { id: string };

    const contact = await resolveContact(contactId, tenantId, "read", role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const q = req.query as Record<string, string>;
    const statusParam = q.status;

    const where: Record<string, unknown> = { contactId, tenantId };
    if (statusParam === "open") where.status = { in: ["OPEN", "IN_PROGRESS"] };
    else if (STATUS_VALUES.includes(statusParam as any)) where.status = statusParam;
    // default: all

    const tasks = await (db as any).crmContactTask.findMany({
      where,
      include: TASK_INCLUDE,
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    });

    return { contactId, tasks: tasks.map(formatTask) };
  });

  // ── POST /crm/contacts/:id/tasks ──────────────────────────────────────────
  app.post("/crm/contacts/:id/tasks", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId } = req.params as { id: string };

    const contact = await resolveContact(contactId, tenantId, "mutate", user.role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const data = parsed.data;

    // Validate assignedToUserId belongs to tenant
    if (data.assignedToUserId) {
      const target = await db.user.findFirst({
        where: { id: data.assignedToUserId, tenantId },
        select: { id: true },
      });
      if (!target) {
        return reply.status(400).send({ error: "invalid_assigned_user" });
      }
    }

    const task = await (db as any).crmContactTask.create({
      data: {
        tenantId,
        contactId,
        title: data.title,
        body: data.body ?? null,
        dueAt: data.dueAt ? new Date(data.dueAt) : null,
        assignedToUserId: data.assignedToUserId ?? null,
        priority: data.priority,
        status: "OPEN",
        createdByUserId: userId,
      },
      include: TASK_INCLUDE,
    });

    // Write timeline event — non-throwing
    const duePart = task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleDateString()}` : "";
    await writeTimelineEvent({
      tenantId,
      contactId,
      type: "TASK_CREATED",
      title: `Task created: ${task.title}`,
      body: `${task.title}${duePart}`,
      linkedId: task.id,
      metadata: { priority: task.priority },
      createdByUserId: userId,
    });

    reply.status(201).send(formatTask(task));
  });

  // ── PATCH /crm/contacts/:id/tasks/:taskId ─────────────────────────────────
  app.patch("/crm/contacts/:id/tasks/:taskId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId, taskId } = req.params as { id: string; taskId: string };

    const contact = await resolveContact(contactId, tenantId, "mutate", user.role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const existing = await (db as any).crmContactTask.findFirst({
      where: { id: taskId, contactId, tenantId },
      select: { id: true, status: true, title: true },
    });
    if (!existing) return reply.status(404).send({ error: "task_not_found" });

    const parsed = patchTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const data = parsed.data;

    if (data.assignedToUserId) {
      const target = await db.user.findFirst({
        where: { id: data.assignedToUserId, tenantId },
        select: { id: true },
      });
      if (!target) {
        return reply.status(400).send({ error: "invalid_assigned_user" });
      }
    }

    // Determine status transition for timeline events
    const prevStatus: string = existing.status;
    const nextStatus: string | undefined = data.status;
    const completingNow = nextStatus === "DONE" && prevStatus !== "DONE";
    const cancelingNow = nextStatus === "CANCELED" && prevStatus !== "CANCELED";

    const updateData: Record<string, unknown> = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.body !== undefined) updateData.body = data.body ?? null;
    if (data.dueAt !== undefined) updateData.dueAt = data.dueAt ? new Date(data.dueAt) : null;
    if ("assignedToUserId" in data) updateData.assignedToUserId = data.assignedToUserId ?? null;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.status !== undefined) updateData.status = data.status;
    if (completingNow) {
      updateData.completedAt = new Date();
      updateData.completedByUserId = userId;
    }

    const updated = await (db as any).crmContactTask.update({
      where: { id: taskId },
      data: updateData,
      include: TASK_INCLUDE,
    });

    // Write timeline event only for significant status changes
    if (completingNow) {
      await writeTimelineEvent({
        tenantId,
        contactId,
        type: "TASK_COMPLETED",
        title: `Task completed: ${updated.title}`,
        linkedId: taskId,
        createdByUserId: userId,
      });
    } else if (cancelingNow) {
      await writeTimelineEvent({
        tenantId,
        contactId,
        type: "TASK_CANCELED",
        title: `Task canceled: ${updated.title}`,
        linkedId: taskId,
        createdByUserId: userId,
      });
    }

    return formatTask(updated);
  });

  // ── DELETE /crm/contacts/:id/tasks/:taskId ────────────────────────────────
  // Hard-deletes the task row. Writes a TASK_CANCELED timeline event for audit.
  app.delete("/crm/contacts/:id/tasks/:taskId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId, taskId } = req.params as { id: string; taskId: string };

    const contact = await resolveContact(contactId, tenantId, "mutate", user.role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const existing = await (db as any).crmContactTask.findFirst({
      where: { id: taskId, contactId, tenantId },
      select: { id: true, title: true, status: true },
    });
    if (!existing) return reply.status(404).send({ error: "task_not_found" });

    await (db as any).crmContactTask.delete({ where: { id: taskId } });

    // Write TASK_CANCELED event for non-canceled tasks only
    if (existing.status !== "CANCELED" && existing.status !== "DONE") {
      await writeTimelineEvent({
        tenantId,
        contactId,
        type: "TASK_CANCELED",
        title: `Task removed: ${existing.title}`,
        linkedId: taskId,
        createdByUserId: userId,
      });
    }

    return reply.status(204).send();
  });
}
