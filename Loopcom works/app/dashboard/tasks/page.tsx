'use client'
import { useListRestore } from '@/hooks/useListRestore'
import { usePersistedSort } from '@/hooks/useListPreferences'
import { openFromList } from '@/lib/navigation/nav-stack'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ViewModeSelector } from '@/components/ui/ViewModeSelector'
import { useViewMode } from '@/hooks/useViewMode'
import { RowCompactItem } from '@/components/lists/RowCompactItem'
import { RowDetailedItem } from '@/components/lists/RowDetailedItem'
import { TableView } from '@/components/lists/TableView'
import { PaginationControls } from '@/components/ui/PaginationControls'
import { formatDate } from '@/lib/utils'
import { Plus, Search, Filter, CheckSquare, Calendar, User, AlertCircle } from 'lucide-react'
import Link from 'next/link'
import { useDocumentListAccess } from '@/hooks/useDocumentListAccess'
import { CreateOnlyAccessCard } from '@/components/permissions/CreateOnlyAccessCard'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'
import {
  canViewAllTasksList,
  defaultTasksListFilter,
  isPersonalTasksListEnabled,
} from '@/lib/tasks/list-scope'
import { TaskStatusSelect, TaskStatusBadge } from '@/components/tasks/TaskStatusSelect'

interface Task {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  dueDate: string | null
  completedAt: string | null
  createdAt: string
  assignee: {
    id: string
    firstName: string
    lastName: string
    email: string
  } | null
  creator: {
    firstName: string
    lastName: string
  }
  client: {
    id: string
    name: string
  } | null
  job: {
    id: string
    jobNumber: string
    title: string
  } | null
  invoice: {
    id: string
    invoiceNumber: string
  } | null
  issue: {
    id: string
    title: string
  } | null
  subtasks: Array<{
    id: string
    title: string
    isCompleted: boolean
  }>
  _count: {
    subtasks: number
  }
}

const priorityColors: Record<string, string> = {
  LOW: 'text-gray-600',
  MEDIUM: 'text-blue-600',
  HIGH: 'text-orange-600',
  URGENT: 'text-red-600',
}

export default function TasksPage() {
  const router = useRouter()
  const { highlightedId } = useListRestore('tasks')
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } = usePersistedSort('tasks')
  const searchParams = useSearchParams()
  const { permissions, loading: permissionsFetchLoading } = usePermissions()
  const { permissionsLoading, canViewList, canCreate } = useDocumentListAccess('tasks.view', 'tasks.create')
  const [tasks, setTasks] = useState<Task[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [status, setStatus] = useState('all')
  const [filter, setFilter] = useState(defaultTasksListFilter)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [viewMode, setViewMode] = useViewMode('tasks', 'grid')
  const [userRole, setUserRole] = useState<string | null>(null)

  useEffect(() => {
    try {
      const userRaw = localStorage.getItem('user')
      setUserRole(userRaw ? (JSON.parse(userRaw)?.role as string | undefined) ?? null : null)
    } catch {
      setUserRole(null)
    }
  }, [])

  const canViewAll = canViewAllTasksList({ role: userRole, permissions })
  const personalTasksEnabled = isPersonalTasksListEnabled()
  const canEditStatus = hasPermission(permissions, 'tasks.edit')

  const handleTaskStatusUpdated = (taskId: string, nextStatus: string) => {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, status: nextStatus } : task))
    )
  }

  useEffect(() => {
    const statusParam = searchParams.get('status')
    if (statusParam) {
      setStatus(statusParam)
    }
  }, [searchParams])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status, filter])

  useEffect(() => {
    if (permissionsFetchLoading) return
    if (filter === 'all' && personalTasksEnabled && !canViewAll) {
      setFilter(defaultTasksListFilter())
    }
  }, [permissionsFetchLoading, filter, personalTasksEnabled, canViewAll])

  useEffect(() => {
    if (permissionsLoading) return
    fetchTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, status, filter, page, permissionsLoading, canViewList])

  const fetchTasks = async () => {
    if (!canViewList) {
      setTasks([])
      setInitialLoading(false)
      setIsFetching(false)
      return
    }

    setIsFetching(true)
    try {
      const token = localStorage.getItem('accessToken')
      const params = new URLSearchParams({
        search: debouncedSearch,
        status,
        filter,
        page: String(page),
        limit: '50',
      })

      const response = await fetch(`/api/tasks?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      const data = await response.json()
      setTasks(data.tasks || [])
      setTotalPages(Number(data?.pagination?.totalPages || 1))
      setTotal(Number(data?.pagination?.total || 0))
    } catch (error) {
      console.error('Failed to fetch tasks:', error)
    } finally {
      setInitialLoading(false)
      setIsFetching(false)
    }
  }

  if (initialLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading tasks...</p>
        </div>
      </div>
    )
  }

  const overdueTasks = tasks.filter(
    (task) => task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'COMPLETED'
  )
  const todayTasks = tasks.filter(
    (task) => task.dueDate && new Date(task.dueDate).toDateString() === new Date().toDateString() && task.status !== 'COMPLETED'
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Tasks</h1>
          <p className="mt-2 text-gray-600">
            {personalTasksEnabled
              ? 'Your personal task inbox — job task lists are unchanged on each job.'
              : 'Manage your tasks and to-dos'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          {canCreate && (
            <Button onClick={() => router.push('/dashboard/tasks/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New Task
            </Button>
          )}
        </div>
      </div>

      {!canViewList && (
        <CreateOnlyAccessCard
          icon={CheckSquare}
          entityLabel="tasks"
          createButtonLabel="New Task"
          canCreate={canCreate}
          onCreate={() => router.push('/dashboard/tasks/new')}
        />
      )}

      {canViewList && (
        <>
      {/* Summary Cards */}
      {(overdueTasks.length > 0 || todayTasks.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {overdueTasks.length > 0 && (
            <Card className="border-red-300 bg-red-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-red-900 flex items-center">
                  <AlertCircle className="mr-2 h-4 w-4" />
                  Overdue Tasks
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">{overdueTasks.length}</div>
                <p className="text-xs text-red-700 mt-1">Requires immediate attention</p>
              </CardContent>
            </Card>
          )}
          {todayTasks.length > 0 && (
            <Card className="border-blue-300 bg-blue-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-blue-900 flex items-center">
                  <Calendar className="mr-2 h-4 w-4" />
                  Due Today
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-blue-600">{todayTasks.length}</div>
                <p className="text-xs text-blue-700 mt-1">Due today</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search tasks by title, client, job, or assignee..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="My Tasks" />
                </SelectTrigger>
                <SelectContent>
                  {canViewAll && <SelectItem value="all">All Tasks</SelectItem>}
                  <SelectItem value="my">My Tasks</SelectItem>
                  <SelectItem value="assigned">Assigned to Me</SelectItem>
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="PLANNING_PENDING">Planning / Pending</SelectItem>
                  <SelectItem value="TODO">To Do</SelectItem>
                  <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                  <SelectItem value="COMPLETED">Completed</SelectItem>
                  <SelectItem value="CANCELLED">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tasks List */}
      {viewMode === 'grid' ? (
      <div className="space-y-4">
        {tasks.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckSquare className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No tasks</h3>
              <p className="mt-1 text-sm text-gray-500">
                {personalTasksEnabled
                  ? 'No tasks assigned to you or created by you yet.'
                  : 'Get started by creating a new task.'}
              </p>
              <div className="mt-6">
                <Button onClick={() => router.push('/dashboard/tasks/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Task
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          tasks.map((task) => {
            const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'COMPLETED'
            const completedSubtasks = task.subtasks.filter((st) => st.isCompleted).length
            
            return (
              <Card
                key={task.id}
                className={`hover:shadow-lg transition-shadow ${
                  isOverdue ? 'border-red-300' : ''
                } ${task.status === 'COMPLETED' ? 'opacity-60' : ''}`}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <Link href={`/dashboard/tasks/${task.id}`}>
                        <CardTitle className="text-lg hover:text-primary cursor-pointer flex items-center">
                          {task.status === 'COMPLETED' && (
                            <CheckSquare className="mr-2 h-4 w-4 text-green-600" />
                          )}
                          {task.title}
                        </CardTitle>
                      </Link>
                      <CardDescription className="mt-1">
                        Assigned to {task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'Unassigned'}
                        {task.client && ` • ${task.client.name}`}
                        {task.job && ` • Job ${task.job.jobNumber}`}
                        {task.invoice && ` • Invoice ${task.invoice.invoiceNumber}`}
                        {task.issue && ` • Issue: ${task.issue.title}`}
                        {task.createdAt && ` • Created ${formatDate(task.createdAt)}`}
                      </CardDescription>
                    </div>
                    <div className="flex items-center space-x-2">
                      {isOverdue && (
                        <AlertCircle className="h-5 w-5 text-red-500" />
                      )}
                      {canEditStatus ? (
                        <TaskStatusSelect
                          taskId={task.id}
                          status={task.status}
                          compact
                          onUpdated={(nextStatus) => handleTaskStatusUpdated(task.id, nextStatus)}
                        />
                      ) : (
                        <TaskStatusBadge status={task.status} />
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {task.description && (
                      <p className="text-sm text-gray-600 line-clamp-2">{task.description}</p>
                    )}

                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center space-x-4">
                        <span className={`font-medium ${priorityColors[task.priority] || 'text-gray-600'}`}>
                          {task.priority}
                        </span>
                        {task.dueDate && (
                          <div className="flex items-center text-gray-600">
                            <Calendar className="mr-1 h-3 w-3" />
                            <span className={isOverdue ? 'text-red-600 font-medium' : ''}>
                              Due {formatDate(task.dueDate)}
                            </span>
                          </div>
                        )}
                        {!task.dueDate && task.createdAt && (
                          <div className="flex items-center text-gray-600">
                            <Calendar className="mr-1 h-3 w-3" />
                            <span>Created {formatDate(task.createdAt)}</span>
                          </div>
                        )}
                        {task._count.subtasks > 0 && (
                          <span className="text-gray-500">
                            {completedSubtasks}/{task._count.subtasks} subtasks
                          </span>
                        )}
                      </div>
                    </div>

                    {task.subtasks.length > 0 && (
                      <div className="pt-2 border-t">
                        <div className="space-y-1">
                          {task.subtasks.slice(0, 3).map((subtask) => (
                            <div key={subtask.id} className="flex items-center text-xs">
                              <CheckSquare
                                className={`mr-2 h-3 w-3 ${
                                  subtask.isCompleted ? 'text-green-600' : 'text-gray-400'
                                }`}
                              />
                              <span
                                className={
                                  subtask.isCompleted ? 'line-through text-gray-400' : 'text-gray-600'
                                }
                              >
                                {subtask.title}
                              </span>
                            </div>
                          ))}
                          {task.subtasks.length > 3 && (
                            <p className="text-xs text-gray-400 ml-5">
                              +{task.subtasks.length - 3} more
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {tasks.map((task) => (
            <RowCompactItem
              key={task.id}
              href={`/dashboard/tasks/${task.id}`}
              primary={task.title}
              secondary={`${task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'Unassigned'} • Created ${formatDate(task.createdAt)}`}
              status={
                canEditStatus ? (
                  <TaskStatusSelect
                    taskId={task.id}
                    status={task.status}
                    compact
                    onUpdated={(nextStatus) => handleTaskStatusUpdated(task.id, nextStatus)}
                  />
                ) : (
                  <TaskStatusBadge status={task.status} />
                )
              }
              amount={task.priority}
              date={task.dueDate ? formatDate(task.dueDate) : '-'}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {tasks.map((task) => (
            <RowDetailedItem
              key={task.id}
              href={`/dashboard/tasks/${task.id}`}
              primary={task.title}
              status={
                canEditStatus ? (
                  <TaskStatusSelect
                    taskId={task.id}
                    status={task.status}
                    compact
                    onUpdated={(nextStatus) => handleTaskStatusUpdated(task.id, nextStatus)}
                  />
                ) : (
                  <TaskStatusBadge status={task.status} />
                )
              }
              line2={`${task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'Unassigned'}${task.client ? ` • ${task.client.name}` : ''} • Created ${formatDate(task.createdAt)}`}
              rightTop={task.priority}
              rightBottom={task.dueDate ? formatDate(task.dueDate) : 'No due date'}
            />
          ))}
        </div>
      ) : (
        <TableView
          highlightedRowId={highlightedId}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          data={tasks}
          rowKey={(task) => task.id}
          onRowClick={(task) => openFromList(router, { entity: 'tasks', detailHref: `/dashboard/tasks/${task.id}`, itemId: task.id })}
          columns={[
            {
              key: 'title',
              header: 'Task',
              sortValue: (task) => task.title,
              render: (task) => <span className="font-medium">{task.title}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (task) => task.status,
              render: (task) =>
                canEditStatus ? (
                  <TaskStatusSelect
                    taskId={task.id}
                    status={task.status}
                    compact
                    onUpdated={(nextStatus) => handleTaskStatusUpdated(task.id, nextStatus)}
                  />
                ) : (
                  <TaskStatusBadge status={task.status} />
                ),
            },
            {
              key: 'assignee',
              header: 'Assignee',
              sortValue: (task) =>
                task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'Unassigned',
              render: (task) =>
                task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}` : 'Unassigned',
            },
            {
              key: 'priority',
              header: 'Priority',
              sortValue: (task) => task.priority,
              render: (task) => task.priority,
            },
            {
              key: 'createdAt',
              header: 'Created',
              sortValue: (task) => task.createdAt,
              render: (task) => formatDate(task.createdAt),
            },
            {
              key: 'dueDate',
              header: 'Due',
              sortValue: (task) => task.dueDate || '',
              render: (task) => (task.dueDate ? formatDate(task.dueDate) : '-'),
            },
          ]}
        />
      )}

      <PaginationControls
        page={page}
        totalPages={totalPages}
        total={total}
        disabled={isFetching}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
        </>
      )}
    </div>
  )
}
