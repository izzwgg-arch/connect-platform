import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { notifyTaskAssigned, createNotificationsForUsers, formatEntityStatusChangedMessage } from '@/lib/notifications'
import { formatTaskStatus } from '@/lib/tasks/statuses'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'tasks.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const task = await prisma.task.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        assignee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            companyName: true,
          },
        },
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
          },
        },
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            title: true,
          },
        },
        issue: {
          select: {
            id: true,
            title: true,
            status: true,
          },
        },
        subtasks: {
          orderBy: { sortOrder: 'asc' },
        },
        attachments: {
          orderBy: { createdAt: 'desc' },
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    })

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    return NextResponse.json({ task })
  } catch (error) {
    console.error('Get task error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'tasks.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      title,
      description,
      status,
      priority,
      dueDate,
      scheduledAt,
      assigneeId,
      subtasks,
    } = body

    const resolvedDueDate = dueDate ?? scheduledAt

    // Get existing task
    const existing = await prisma.task.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        assignee: true,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Verify assignee if changed
    if (assigneeId && assigneeId !== existing.assigneeId) {
      const assignee = await prisma.user.findFirst({
        where: {
          id: assigneeId,
          tenantId: user.tenantId,
        },
      })

      if (!assignee) {
        return NextResponse.json({ error: 'Assignee not found' }, { status: 404 })
      }

      // Notify new assignee with push notification
      await notifyTaskAssigned(user.tenantId, assigneeId, existing.id, existing.title)
    }

    // Track status change
    const statusChanged = status && status !== existing.status
    const completedAt = status === 'COMPLETED' && existing.status !== 'COMPLETED' ? new Date() : 
                        status !== 'COMPLETED' && existing.status === 'COMPLETED' ? null : 
                        existing.completedAt

    // Update task
    const task = await prisma.task.update({
      where: { id: params.id },
      data: {
        title: title !== undefined ? title : existing.title,
        description: description !== undefined ? description : existing.description,
        status: status !== undefined ? status : existing.status,
        priority: priority !== undefined ? priority : existing.priority,
        dueDate:
          resolvedDueDate !== undefined ? (resolvedDueDate ? new Date(resolvedDueDate) : null) : existing.dueDate,
        assigneeId: assigneeId !== undefined ? (assigneeId || null) : existing.assigneeId,
        completedAt,
      },
      include: {
        assignee: true,
        creator: true,
      },
    })

    // Update subtasks if provided
    if (subtasks && Array.isArray(subtasks)) {
      await prisma.subtask.deleteMany({
        where: { taskId: params.id },
      })

      for (let i = 0; i < subtasks.length; i++) {
        await prisma.subtask.create({
          data: {
            taskId: params.id,
            title: subtasks[i].title,
            isCompleted: subtasks[i].isCompleted || false,
            sortOrder: i,
          },
        })
      }
    }

    // Create activity for status change
    if (statusChanged) {
      await prisma.activity.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          type: status === 'COMPLETED' ? 'TASK_COMPLETED' : 'TASK_CREATED',
          description: `Task "${task.title}" ${status === 'COMPLETED' ? 'completed' : `status changed to ${status}`}`,
          taskId: task.id,
          clientId: task.clientId || undefined,
          jobId: task.jobId || undefined,
        },
      })
    }

    // Notify assignee about any update (including status changes and other field updates)
    if (task.assigneeId) {
      let notificationTitle = 'Task Updated'
      let notificationMessage = `"${task.title}" has been updated`

      if (statusChanged) {
        notificationTitle = 'Task Update'
        notificationMessage = formatEntityStatusChangedMessage({
          entityType: 'Task',
          entityNumber: task.id.slice(-8).toUpperCase(),
          entityName: task.title,
          oldStatusLabel: formatTaskStatus(existing.status),
          newStatusLabel: formatTaskStatus(status),
        })
      }

      await createNotificationsForUsers(user.tenantId, [task.assigneeId], {
        type: 'TASK_UPDATED',
        title: notificationTitle,
        message: notificationMessage,
        linkType: 'task',
        linkId: task.id,
        linkUrl: `/dashboard/tasks/${task.id}`,
        actorUserId: user.id,
        action: statusChanged ? 'status_changed' : 'task_updated',
      })
    }

    return NextResponse.json({ task })
  } catch (error) {
    console.error('Update task error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'tasks.delete')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const task = await prisma.task.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    await prisma.task.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ message: 'Task deleted successfully' })
  } catch (error) {
    console.error('Delete task error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
