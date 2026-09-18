import { NavigatorScreenParams } from '@react-navigation/native'

export type JobsStackParamList = {
  DashboardHome: undefined
  JobsList: undefined
  AllJobsList: undefined
  Production: undefined
  JobDetail: { jobId: string }
  AdminJobDetail: { jobId: string }
  CreateJob: undefined
  EditJob: { jobId: string }
  NotificationsHome: undefined
  NotificationSettings: undefined
  RequestsHome: undefined
  MeasuringRequestsHome: undefined
  MeasuringRequestDetail: { measuringRequestId: string }
  RequestCreate:
    | {
        draftId?: string
      }
    | undefined
  RequestDetail: { requestId: string }
  CallsHome: undefined
  OutboxHome: undefined
  ProfileHome: undefined
  ShareIngress:
    | {
        uri?: string
        name?: string
        mimeType?: string
        size?: string
      }
    | undefined
}

export type ScheduleStackParamList = {
  ScheduleHome: undefined
  ScheduleDetail: { scheduleId: string }
  ScheduleCreate:
    | {
        scheduleId?: string
        jobId?: string
        leadId?: string
        assignedUserId?: string
        title?: string
        description?: string
      }
    | undefined
}

export type TasksStackParamList = {
  TasksList: undefined
  TaskDetail: { taskId: string }
}

export type MessagesStackParamList = {
  MessagesList: undefined
  MessageThread: {
    conversationId: string
    jobContext?: {
      jobId: string
      jobNumber: string
      jobName: string
    }
  }
  TeamChat: undefined
}

export type MoreStackParamList = {
  MoreHome: undefined
  Requests: undefined
  Issues: undefined
  IssueDetail: { issueId: string }
  Calls: undefined
  Outbox: undefined
  Profile: undefined
}

export type IssuesStackParamList = {
  IssuesList: undefined
  IssueDetail: { issueId: string }
}

export type RootMainTabParamList = {
  JobsTab: NavigatorScreenParams<JobsStackParamList> | undefined
  MessagesTab: NavigatorScreenParams<MessagesStackParamList> | undefined
  TasksTab: NavigatorScreenParams<TasksStackParamList> | undefined
  ScheduleTab: NavigatorScreenParams<ScheduleStackParamList> | undefined
  IssuesTab: NavigatorScreenParams<IssuesStackParamList> | undefined
}

export type RootDrawerParamList = {
  MainTabs: undefined
}

// Backward-compatible alias for existing imports.
export type RootTabParamList = RootDrawerParamList