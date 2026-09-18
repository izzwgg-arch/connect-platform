export interface AuthUser {
  id: string
  email: string
  firstName: string
  lastName: string
  avatar?: string | null
  role: string
  tenantId: string
  tenantName?: string
}

export interface ApiError {
  error: string
}

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface Job {
  id: string
  jobNumber: string
  title: string
  description?: string | null
  status: string
  billingStatus?: string | null
  jobType?: string | null
  priority: string | number
  scheduledStart: string | null
  scheduledEnd: string | null
  createdAt?: string | null
  actualStart?: string | null
  actualEnd?: string | null
  estimateAmount?: string | null
  actualAmount?: string | null
  laborCost?: string | null
  materialCost?: string | null
  totalCost?: string | null
  totalInvoicedAmount?: string | null
  openInvoiceBalance?: string | null
  openInvoiceCount?: number
  clientOpenInvoiceBalance?: string | null
  chargeByHour?: boolean
  hourlyRateCents?: number | null
  billableMinutesTotal?: number
  billableHours?: number
  billableAmountCents?: number
  currentUserActiveSession?: {
    id: string
    startedAt: string
  } | null
  currentUserTodayMinutes?: number
  createdAt?: string
  client?: {
    id: string
    name: string
    companyName?: string | null
    phone?: string | null
    email?: string | null
    contacts?: Array<{
      id: string
      firstName: string
      lastName: string
      phone?: string | null
      email?: string | null
      title?: string | null
    }>
  } | null
  address?: {
    street?: string | null
    city?: string | null
    state?: string | null
    zipCode?: string | null
  } | null
  jobSite?: {
    id?: string
    street?: string | null
    city?: string | null
    state?: string | null
    zipCode?: string | null
    country?: string | null
  } | null
  assignedTo?: {
    id: string
    firstName: string
    lastName: string
    email?: string | null
    phone?: string | null
  } | null
  assignments?: Array<{
    id: string
    role?: string | null
    notes?: string | null
    user: {
      id: string
      firstName: string
      lastName: string
      email?: string | null
      phone?: string | null
    }
  }>
  estimates?: Array<{
    id: string
    estimateNumber: string
    title?: string | null
    status: string
    total: string
    createdAt: string
  }>
  invoices?: Array<{
    id: string
    invoiceNumber: string
    total: string
    balance: string
    status: string
    createdAt?: string
  }>
  purchaseOrders?: Array<{
    id: string
    poNumber: string
    status: string
    total: string
    createdAt: string
  }>
  payments?: Array<{
    id: string
    amount: string
    status: string
    paymentDate: string | null
    method?: string | null
    reference?: string | null
    invoiceNumber?: string | null
    invoiceId?: string | null
  }>
  notes?: Array<{
    id: string
    content: string
    createdAt: string
    createdBy?: { id: string; name: string } | null
  }>
  schedules?: Array<{
    id: string
    startTime: string
    endTime: string
    user?: { id: string; firstName: string; lastName: string } | null
  }>
  activeTimers?: Array<{
    id: string
    startedAt: string
    worker?: { id: string; firstName: string; lastName: string; email?: string } | null
  }>
  tasks?: Array<{
    id: string
    title: string
    status: string
    priority: string
    dueDate: string | null
    createdAt: string
    updatedAt: string
    shortDescription: string
    assignedTo: { id: string; name: string } | null
  }>
  issues?: Array<{
    id: string
    title: string
    status: string
    priority: string
    createdAt: string
    updatedAt: string
    shortDescription: string
    assignedTo: { id: string; name: string } | null
  }>
  attachments?: Attachment[]
  _count?: {
    tasks?: number
    issues?: number
    invoices?: number
    estimates?: number
  }
}

export interface TimeEntry {
  id: string
  tenantId: string
  jobId: string
  workerId: string
  startedAt: string | null
  endedAt: string | null
  durationMinutes: number
  source: 'TIMER' | 'MANUAL'
  status: 'ACTIVE' | 'STOPPED'
  note: string | null
  editedReason: string | null
  createdAt: string
  updatedAt: string
  worker?: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
}

export interface Task {
  id: string
  title: string
  description?: string | null
  status: string
  priority: string
  dueDate?: string | null
  assigneeId?: string | null
  clientId?: string | null
  client?: {
    id: string
    name: string
    companyName?: string | null
  } | null
  jobId?: string | null
  createdAt: string
}

export interface Issue {
  id: string
  title: string
  description?: string | null
  type: string
  status: string
  priority: string
  dueDate?: string | null
  assigneeId?: string | null
  clientId?: string | null
  client?: {
    id: string
    name: string
    companyName?: string | null
  } | null
  jobId?: string | null
  createdAt: string
}

export interface ScheduleItem {
  id: string
  title: string
  description?: string | null
  type: string
  startTime: string
  endTime: string
  allDay: boolean
  userId?: string
  user?: {
    id: string
    firstName: string
    lastName: string
    email?: string
  }
  job?: {
    id: string
    jobNumber: string
    title: string
    status?: string
    client?: {
      id: string
      name: string
    } | null
  } | null
  lead?: {
    id: string
    firstName?: string | null
    lastName?: string | null
  } | null
}

export interface Conversation {
  id: string
  type?: 'TEAM' | 'DM' | 'JOB_THREAD'
  title?: string
  pinned?: boolean
  channel?: string
  status?: string
  jobId?: string | null
  jobNumber?: string | null
  jobTitle?: string | null
  threadTitle?: string | null
  displayTitle?: string
  unreadCount: number
  participants?: string[]
  lastMessageAt: string | null
  otherUser?: {
    id: string
    firstName?: string | null
    lastName?: string | null
    email: string
    avatar?: string | null
  } | null
  lastMessage?: {
    id: string
    text?: string | null
    type?: string
    createdAt: string
    status?: string
    senderId?: string
    jobId?: string | null
    jobNumber?: string | null
    jobName?: string | null
  } | null
  client?: {
    id: string
    name: string
    phone?: string | null
    email?: string | null
  } | null
  messages?: Array<{
    id: string
    body: string
    direction: string
    createdAt: string
  }>
}

export interface ChatMessage {
  id: string
  senderId: string
  clientTempId?: string | null
  text?: string | null
  type: 'TEXT' | 'MEDIA' | 'VOICE' | 'LOCATION' | 'SYSTEM'
  status: 'SENT' | 'DELIVERED' | 'READ'
  createdAt: string
  editedAt?: string | null
  deletedForEveryoneAt?: string | null
  isDeletedForEveryone?: boolean
  jobId?: string | null
  jobNumber?: string | null
  jobName?: string | null
  sender?: {
    id: string
    firstName?: string | null
    lastName?: string | null
    email: string
    avatar?: string | null
  } | null
  replyToMessageId?: string | null
  replyTo?: {
    messageId: string
    senderName: string
    textPreview: string
    type?: 'TEXT' | 'MEDIA' | 'VOICE' | 'LOCATION' | 'SYSTEM'
    createdAt?: string | null
  } | null
  attachments?: Array<{
    id: string
    kind: 'IMAGE' | 'VIDEO' | 'FILE' | 'VOICE' | 'LOCATION'
    url: string
    fileName?: string | null
    mimeType?: string | null
    durationMs?: number | null
    thumbnailUrl?: string | null
    latitude?: number | null
    longitude?: number | null
    sizeBytes?: number | null
  }>
}

export interface Attachment {
  id: string
  fileName: string
  url: string
  mimeType: string
  fileSize: number
  createdAt: string
}

