import React, { useEffect } from 'react'
import { NavigationContainer, DefaultTheme, LinkingOptions, createNavigationContainerRef } from '@react-navigation/native'
import { createDrawerNavigator, DrawerContentComponentProps, DrawerContentScrollView } from '@react-navigation/drawer'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthContext'
import { LoginScreen } from '../screens/auth/LoginScreen'
import { DashboardScreen } from '../screens/dashboard/DashboardScreen'
import { JobsScreen } from '../screens/jobs/JobsScreen'
import { JobDetailScreen } from '../screens/jobs/JobDetailScreen'
import { AllJobsScreen } from '../screens/jobs/AllJobsScreen'
import { ProductionScreen } from '../screens/jobs/ProductionScreen'
import { AdminJobDetailScreen } from '../screens/jobs/AdminJobDetailScreen'
import { CreateJobScreen } from '../screens/jobs/CreateJobScreen'
import { EditJobScreen } from '../screens/jobs/EditJobScreen'
import { ScheduleScreen } from '../screens/schedule/ScheduleScreen'
import { ScheduleDetailScreen } from '../screens/schedule/ScheduleDetailScreen'
import { ScheduleCreateScreen } from '../screens/schedule/ScheduleCreateScreen'
import { TasksScreen } from '../screens/tasks/TasksScreen'
import { MessagesScreen } from '../screens/messages/MessagesScreen'
import { MessageThreadScreen } from '../screens/messages/MessageThreadScreen'
import { TeamChatScreen } from '../screens/messages/TeamChatScreen'
import { CreateRequestScreen } from '../screens/requests/CreateRequestScreen'
import { RequestsListScreen } from '../screens/requests/RequestsListScreen'
import { RequestDetailScreen } from '../screens/requests/RequestDetailScreen'
import { MeasuringRequestsScreen } from '../screens/requests/MeasuringRequestsScreen'
import { MeasuringRequestDetailScreen } from '../screens/requests/MeasuringRequestDetailScreen'
import { IssuesScreen } from '../screens/issues/IssuesScreen'
import { IssueDetailScreen } from '../screens/issues/IssueDetailScreen'
import { CallsScreen } from '../screens/calls/CallsScreen'
import { ProfileScreen } from '../screens/profile/ProfileScreen'
import { OutboxScreen } from '../screens/outbox/OutboxScreen'
import { colors, spacing, typography } from '../theme/tokens'
import {
  JobsStackParamList,
  MessagesStackParamList,
  ScheduleStackParamList,
  TasksStackParamList,
  IssuesStackParamList,
  RootMainTabParamList,
  RootDrawerParamList,
} from '../types/navigation'
import { TaskDetailScreen } from '../screens/tasks/TaskDetailScreen'
import { useOutboxCount } from '../hooks/useOutboxCount'
import { Card } from '../components/Card'
import { useMobilePermissions } from '../hooks/useMobilePermissions'
import { NotificationsScreen } from '../screens/notifications/NotificationsScreen'
import { NotificationSettingsScreen } from '../screens/notifications/NotificationSettingsScreen'
import { ShareIngressScreen } from '../screens/share/ShareIngressScreen'
import { apiRequest } from '../api/client'

const Drawer = createDrawerNavigator<RootDrawerParamList>()
const MainTabs = createBottomTabNavigator<RootMainTabParamList>()
const JobsStack = createNativeStackNavigator<JobsStackParamList>()
const ScheduleStack = createNativeStackNavigator<ScheduleStackParamList>()
const TasksStack = createNativeStackNavigator<TasksStackParamList>()
const MessagesStack = createNativeStackNavigator<MessagesStackParamList>()
const IssuesStack = createNativeStackNavigator<IssuesStackParamList>()
const AuthStack = createNativeStackNavigator()
const TAB_BAR_BASE_HEIGHT = 58
const TAB_BAR_MIN_BOTTOM_INSET = 8
const TAB_ACTIVE_COLOR = colors.brandPrimary
const TAB_INACTIVE_COLOR = colors.muted

const navigationRef = createNavigationContainerRef<RootDrawerParamList>()

const baseLinking: LinkingOptions<RootDrawerParamList> = {
  prefixes: ['trimprofield://', 'trimpro://'],
  config: {
    screens: {
      MainTabs: {
        screens: {
          JobsTab: {
            screens: {
              DashboardHome: 'dashboard',
              JobsList: 'jobs',
              JobDetail: 'jobs/:jobId',
              AllJobsList: 'all-jobs',
              Production: 'production',
              AdminJobDetail: 'all-jobs/:jobId',
              CreateJob: 'all-jobs/new',
              EditJob: 'all-jobs/:jobId/edit',
              RequestsHome: 'requests',
              MeasuringRequestsHome: 'measuring-requests',
              MeasuringRequestDetail: 'measuring-requests/:measuringRequestId',
              RequestCreate: 'requests/new',
              RequestDetail: 'requests/:requestId',
              CallsHome: 'calls',
              OutboxHome: 'outbox',
              ProfileHome: 'profile',
              NotificationsHome: 'notifications',
              ShareIngress: 'share-ingress',
            },
          } as never,
          MessagesTab: {
            screens: {
              MessagesList: 'messages',
              MessageThread: 'messages/:conversationId',
              TeamChat: 'messages/team',
            },
          } as never,
          TasksTab: {
            screens: {
              TasksList: 'tasks',
              TaskDetail: 'tasks/:taskId',
            },
          } as never,
          ScheduleTab: {
            screens: {
              ScheduleHome: 'schedule',
              ScheduleDetail: 'schedule/:scheduleId',
              ScheduleCreate: 'schedule/new',
            },
          } as never,
          IssuesTab: {
            screens: {
              IssuesList: 'issues',
              IssueDetail: 'issues/:issueId',
            },
          } as never,
        },
      } as never,
    },
  },
}

// Do NOT wrap with ShareIntent getInitialURL — that native call can hang forever
// on cold start and leave NavigationContainer blank (looks like a frozen splash).
const linking = baseLinking

function JobsStackNavigator() {
  return (
    <JobsStack.Navigator
      initialRouteName="JobsList"
      screenOptions={stackOptions}
    >
      <JobsStack.Screen name="JobsList" component={JobsScreen} options={mainHeaderOptions('Production Line')} />
      <JobsStack.Screen name="DashboardHome" component={DashboardScreen} options={mainHeaderOptions('Dashboard')} />
      <JobsStack.Screen name="JobDetail" component={JobDetailScreen} options={detailsHeaderOptions('Job Details')} />
      <JobsStack.Screen name="AllJobsList" component={AllJobsScreen} options={mainHeaderOptions('All Jobs')} />
      <JobsStack.Screen name="Production" component={ProductionScreen} options={mainHeaderOptions('Production')} />
      <JobsStack.Screen name="AdminJobDetail" component={AdminJobDetailScreen} options={detailsHeaderOptions('Job Details')} />
      <JobsStack.Screen name="CreateJob" component={CreateJobScreen} options={detailsHeaderOptions('Create Job')} />
      <JobsStack.Screen name="EditJob" component={EditJobScreen} options={detailsHeaderOptions('Edit Job')} />
      <JobsStack.Screen
        name="NotificationsHome"
        component={NotificationsScreen}
        options={mainHeaderOptions('Notifications')}
      />
      <JobsStack.Screen
        name="NotificationSettings"
        component={NotificationSettingsScreen}
        options={detailsHeaderOptions('Notification Settings')}
      />
      <JobsStack.Screen name="RequestsHome" component={RequestsListScreen} options={mainHeaderOptions('Requests')} />
      <JobsStack.Screen
        name="MeasuringRequestsHome"
        component={MeasuringRequestsScreen}
        options={mainHeaderOptions('Measuring Requests')}
      />
      <JobsStack.Screen
        name="MeasuringRequestDetail"
        component={MeasuringRequestDetailScreen}
        options={detailsHeaderOptions('Measuring Request')}
      />
      <JobsStack.Screen name="RequestCreate" component={CreateRequestScreen} options={detailsHeaderOptions('Create Request')} />
      <JobsStack.Screen name="RequestDetail" component={RequestDetailScreen} options={detailsHeaderOptions('Request')} />
      <JobsStack.Screen name="CallsHome" component={CallsScreen} options={mainHeaderOptions('Calls')} />
      <JobsStack.Screen name="OutboxHome" component={OutboxScreen} options={detailsHeaderOptions('Outbox')} />
      <JobsStack.Screen name="ProfileHome" component={ProfileScreen} options={mainHeaderOptions('Profile')} />
      <JobsStack.Screen
        name="ShareIngress"
        component={ShareIngressScreen}
        options={detailsHeaderOptions('Share to TrimPro')}
      />
    </JobsStack.Navigator>
  )
}

function ScheduleStackNavigator() {
  return (
    <ScheduleStack.Navigator screenOptions={stackOptions}>
      <ScheduleStack.Screen name="ScheduleHome" component={ScheduleScreen} options={{ headerShown: false }} />
      <ScheduleStack.Screen name="ScheduleDetail" component={ScheduleDetailScreen} options={detailsHeaderOptions('Schedule')} />
      <ScheduleStack.Screen name="ScheduleCreate" component={ScheduleCreateScreen} options={detailsHeaderOptions('New Schedule')} />
    </ScheduleStack.Navigator>
  )
}

function TasksStackNavigator() {
  return (
    <TasksStack.Navigator screenOptions={stackOptions}>
      <TasksStack.Screen name="TasksList" component={TasksScreen} options={mainHeaderOptions('Tasks')} />
      <TasksStack.Screen name="TaskDetail" component={TaskDetailScreen} options={detailsHeaderOptions('Task Details')} />
    </TasksStack.Navigator>
  )
}

function MessagesStackNavigator() {
  return (
    <MessagesStack.Navigator screenOptions={stackOptions}>
      <MessagesStack.Screen name="MessagesList" component={MessagesScreen} options={mainHeaderOptions('Messages')} />
      <MessagesStack.Screen name="TeamChat" component={TeamChatScreen} options={detailsHeaderOptions('Team Chat')} />
      <MessagesStack.Screen name="MessageThread" component={MessageThreadScreen} options={{ headerShown: false }} />
    </MessagesStack.Navigator>
  )
}

function IssuesStackNavigator() {
  return (
    <IssuesStack.Navigator screenOptions={stackOptions}>
      <IssuesStack.Screen name="IssuesList" component={IssuesScreen} options={mainHeaderOptions('Issues')} />
      <IssuesStack.Screen name="IssueDetail" component={IssueDetailScreen} options={detailsHeaderOptions('Issue Details')} />
    </IssuesStack.Navigator>
  )
}

const stackOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTitleStyle: {
    ...typography.h3,
    color: colors.textPrimary,
  },
  headerShadowVisible: false,
  headerTintColor: colors.textPrimary,
} as const

function mainHeaderOptions(title: string) {
  return ({ navigation }: any) => ({
    title,
    headerLeft: () => (
      <DrawerMenuButton navigation={navigation} />
    ),
  })
}

function detailsHeaderOptions(title: string) {
  return ({ navigation }: any) => ({
    title,
    headerRight: () => <DrawerMenuButton navigation={navigation} />,
  })
}

function DrawerMenuButton({ navigation }: { navigation: any }) {
  return (
    <Pressable
      onPress={() => {
        const drawerParent = navigation.getParent?.()
        if (drawerParent?.toggleDrawer) {
          drawerParent.toggleDrawer()
          return
        }
        if (navigation.toggleDrawer) navigation.toggleDrawer()
      }}
      android_ripple={{ color: 'rgba(15,23,42,0.1)', borderless: true }}
      style={styles.headerMenuButton}
    >
      <Ionicons name="menu" size={20} color={colors.textPrimary} />
    </Pressable>
  )
}

function MainTabsNavigator() {
  const insets = useSafeAreaInsets()
  const bottomInset = Math.max(insets.bottom, TAB_BAR_MIN_BOTTOM_INSET)
  const assignmentsQuery = useQuery({
    queryKey: ['mobile-assignments-tab-counts'],
    queryFn: () =>
      apiRequest<{ openTasksCount?: number; openIssuesCount?: number; jobsTodayCount?: number }>('/api/mobile/assignments'),
    refetchInterval: 30_000,
  })
  const messagesQuery = useQuery({
    queryKey: ['mobile-conversations-tab-counts'],
    queryFn: () =>
      apiRequest<{
        conversations?: Array<{ unreadCount?: number }>
      }>('/api/messages/conversations'),
    refetchInterval: 30_000,
  })

  const unreadMessages = (messagesQuery.data?.conversations || []).reduce(
    (total, row) => total + Number(row.unreadCount || 0),
    0
  )
  const openTasksCount = Number(assignmentsQuery.data?.openTasksCount || 0)
  const openIssuesCount = Number(assignmentsQuery.data?.openIssuesCount || 0)

  return (
    <MainTabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle: [
          styles.tabBar,
          {
            paddingBottom: bottomInset,
            height: TAB_BAR_BASE_HEIGHT + bottomInset,
          },
        ],
        tabBarActiveTintColor: TAB_ACTIVE_COLOR,
        tabBarInactiveTintColor: TAB_INACTIVE_COLOR,
        tabBarActiveBackgroundColor: 'rgba(46,74,89,0.08)',
        tabBarLabelStyle: styles.tabLabel,
        tabBarLabel: ({ focused, children }) => (
          <Text
            style={[
              styles.tabLabel,
              focused ? styles.tabLabelActive : styles.tabLabelInactive,
            ]}
          >
            {children}
          </Text>
        ),
        tabBarIcon: ({ focused, size }) => {
          const iconByRoute: Record<keyof RootMainTabParamList, keyof typeof Ionicons.glyphMap> = {
            JobsTab: 'briefcase-outline',
            MessagesTab: 'chatbubble-ellipses-outline',
            TasksTab: 'checkbox-outline',
            ScheduleTab: 'calendar-outline',
            IssuesTab: 'alert-circle-outline',
          }
          return (
            <Ionicons
              name={iconByRoute[route.name as keyof RootMainTabParamList]}
              color={focused ? TAB_ACTIVE_COLOR : TAB_INACTIVE_COLOR}
              size={size}
            />
          )
        },
      })}
    >
      <MainTabs.Screen
        name="JobsTab"
        component={JobsStackNavigator}
        options={{ title: 'Jobs' }}
        listeners={({ navigation }) => ({
          tabPress: (event) => {
            event.preventDefault()
            navigation.navigate('JobsTab', { screen: 'JobsList' } as never)
          },
        })}
      />
      <MainTabs.Screen
        name="MessagesTab"
        component={MessagesStackNavigator}
        options={{
          title: 'Messages',
          tabBarBadge: unreadMessages > 0 ? unreadMessages : undefined,
          // Keep tab bar visible while the keyboard is open on chat. If the bar hides with
          // the IME and reappears on dismiss, the stack height jumps after keyboard-controller
          // finishes padding — a second, whole-thread snap unrelated to the composer.
          tabBarHideOnKeyboard: false,
        }}
      />
      <MainTabs.Screen
        name="TasksTab"
        component={TasksStackNavigator}
        options={{
          title: 'Tasks',
          tabBarBadge: openTasksCount > 0 ? openTasksCount : undefined,
        }}
      />
      <MainTabs.Screen name="ScheduleTab" component={ScheduleStackNavigator} options={{ title: 'Schedule' }} />
      <MainTabs.Screen
        name="IssuesTab"
        component={IssuesStackNavigator}
        options={{
          title: 'Issues',
          tabBarBadge: openIssuesCount > 0 ? openIssuesCount : undefined,
        }}
      />
    </MainTabs.Navigator>
  )
}

function DrawerContent(props: DrawerContentComponentProps) {
  const { user, signOut } = useAuth()
  const outboxCount = useOutboxCount()
  const { canViewAllJobs, canViewRequests, hasWebPermission } = useMobilePermissions()
  const unreadQuery = useQuery({
    queryKey: ['mobile-notifications-unread'],
    queryFn: () => apiRequest<{ unreadCount: number }>('/api/mobile/notifications?limit=1'),
    refetchInterval: 15000,
  })
  const unreadCount = unreadQuery.data?.unreadCount || 0

  // Navigation items - More option removed, all items now directly in sidebar
  const items: Array<{
    key: string
    label: string
    icon: keyof typeof Ionicons.glyphMap
    target: { screen: keyof RootMainTabParamList; params?: Record<string, any> }
  }> = [
    { key: 'DashboardHome', label: 'Dashboard', icon: 'grid-outline', target: { screen: 'JobsTab', params: { screen: 'DashboardHome' } } },
    {
      key: 'NotificationsHome',
      label: unreadCount > 0 ? `Notifications (${unreadCount})` : 'Notifications',
      icon: 'notifications-outline',
      target: { screen: 'JobsTab', params: { screen: 'NotificationsHome' } },
    },
    ...(canViewAllJobs()
      ? [{ key: 'AllJobsList', label: 'All Jobs', icon: 'list-outline', target: { screen: 'JobsTab', params: { screen: 'AllJobsList' } } } as const]
      : []),
    ...(hasWebPermission('production.view')
      ? [{ key: 'Production', label: 'Production', icon: 'construct-outline', target: { screen: 'JobsTab', params: { screen: 'Production' } } } as const]
      : []),
    ...(canViewRequests()
      ? [{ key: 'RequestsHome', label: 'Requests', icon: 'document-text-outline', target: { screen: 'JobsTab', params: { screen: 'RequestsHome' } } } as const]
      : []),
    { key: 'CallsHome', label: 'Calls', icon: 'call-outline', target: { screen: 'JobsTab', params: { screen: 'CallsHome' } } },
    {
      key: 'OutboxHome',
      label: `Outbox${outboxCount > 0 ? ` (${outboxCount})` : ''}`,
      icon: 'cloud-upload-outline',
      target: { screen: 'JobsTab', params: { screen: 'OutboxHome' } },
    },
    { key: 'ProfileHome', label: 'Profile', icon: 'person-outline', target: { screen: 'JobsTab', params: { screen: 'ProfileHome' } } },
  ]

  const currentNested = getCurrentNestedRouteName(props.state)

  return (
    <View style={styles.drawerRoot}>
      <DrawerContentScrollView {...props} contentContainerStyle={styles.drawerScroll}>
        <View style={styles.brandWrap}>
          <Text style={styles.brandTitle}>TrimPro</Text>
          <Text style={styles.brandSubtitle}>Field Operations</Text>
        </View>
        <Card style={styles.userCard}>
          <Text style={styles.userName}>{user ? `${user.firstName} ${user.lastName}` : 'User'}</Text>
          <Text style={styles.userRole}>{user?.role || 'FIELD'}</Text>
        </Card>

        <View style={styles.navList}>
          {items.map((item, index) => {
            return (
              <Pressable
                key={`${item.key}-${index}`}
                onPress={() => {
                  props.navigation.navigate('MainTabs', item.target as never)
                }}
                android_ripple={{ color: 'rgba(15,76,92,0.12)' }}
                style={({ pressed }) => [
                  styles.navItem,
                  currentNested === item.key && styles.navItemActive,
                  pressed && styles.navPressed,
                ]}
              >
                {currentNested === item.key && <View style={styles.activeBar} />}
                <Ionicons
                  name={item.icon}
                  size={18}
                  color={currentNested === item.key ? colors.brandPrimary : colors.textSecondary}
                />
                <Text style={[styles.navText, currentNested === item.key && styles.navTextActive]}>{item.label}</Text>
              </Pressable>
            )
          })}
        </View>
      </DrawerContentScrollView>

      <View style={styles.drawerBottom}>
        <Pressable
          onPress={() => props.navigation.navigate('MainTabs', { screen: 'JobsTab', params: { screen: 'ProfileHome' } } as never)}
          android_ripple={{ color: 'rgba(15,23,42,0.1)' }}
          style={({ pressed }) => [styles.bottomBtn, pressed && styles.navPressed]}
        >
          <Ionicons name="settings-outline" size={18} color={colors.textSecondary} />
          <Text style={styles.bottomText}>Settings</Text>
        </Pressable>
        <Pressable
          onPress={() => void signOut()}
          android_ripple={{ color: 'rgba(220,38,38,0.1)' }}
          style={({ pressed }) => [styles.bottomBtn, pressed && styles.navPressed]}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          <Text style={[styles.bottomText, { color: colors.danger }]}>Logout</Text>
        </Pressable>
      </View>
    </View>
  )
}

export function RootNavigator() {
  const { token } = useAuth()
  return (
    <NavigationContainer
      ref={navigationRef}
      linking={linking}
      theme={{
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          background: colors.background,
        },
      }}
    >
      {!token ? (
        <AuthStack.Navigator screenOptions={{ headerShown: false }}>
          <AuthStack.Screen name="Login" component={LoginScreen} />
        </AuthStack.Navigator>
      ) : (
        <Drawer.Navigator
          initialRouteName="MainTabs"
          drawerContent={(props) => <DrawerContent {...props} />}
          screenOptions={{
            headerShown: false,
            drawerType: 'slide',
            overlayColor: 'rgba(15,23,42,0.28)',
            drawerStyle: { width: 286, backgroundColor: colors.surface },
            sceneStyle: { backgroundColor: colors.background },
          }}
        >
          <Drawer.Screen name="MainTabs" component={MainTabsNavigator} options={{ title: 'TrimPro' }} />
        </Drawer.Navigator>
      )}
    </NavigationContainer>
  )
}

function getCurrentNestedRouteName(state: any): string {
  if (!state?.routes?.length) return ''
  let route = state.routes[state.index ?? 0]
  while (route?.state?.routes?.length) {
    route = route.state.routes[route.state.index ?? 0]
  }
  return route?.name || ''
}

const styles = StyleSheet.create({
  headerMenuButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBar: {
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
    paddingTop: 6,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
  },
  tabLabel: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: '400',
  },
  tabLabelActive: {
    color: TAB_ACTIVE_COLOR,
    fontWeight: '600',
  },
  tabLabelInactive: {
    color: TAB_INACTIVE_COLOR,
    fontWeight: '400',
  },
  drawerRoot: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  drawerScroll: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  brandWrap: {
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
  },
  brandTitle: {
    ...typography.h2,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  brandSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  userCard: {
    marginBottom: spacing.md,
  },
  userName: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  userRole: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  navList: {
    gap: spacing.xs,
  },
  navItem: {
    minHeight: 46,
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  navItemActive: {
    backgroundColor: 'rgba(15,76,92,0.1)',
  },
  navPressed: {
    opacity: 0.9,
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    top: 9,
    bottom: 9,
    width: 3,
    borderRadius: 999,
    backgroundColor: colors.brandPrimary,
  },
  navText: {
    ...typography.sub,
    color: colors.textSecondary,
  },
  navTextActive: {
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  drawerBottom: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  bottomBtn: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bottomText: {
    ...typography.sub,
    color: colors.textSecondary,
  },
})

