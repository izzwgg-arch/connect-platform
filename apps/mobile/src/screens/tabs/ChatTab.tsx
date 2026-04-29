import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import { Avatar } from '../../components/ui/Avatar';
import { getChatThreads, getMessages, sendChatMessage } from '../../api/client';
import { subscribeToChat } from '../../api/realtime';
import type { ChatMessage, ChatThread } from '../../types';
import { radius, spacing } from '../../theme/spacing';

type ChatFilter = 'all' | 'unread' | 'groups' | 'dms';

function formatThreadTime(iso: string): string {
  const date = new Date(iso);
  const diffH = (Date.now() - date.getTime()) / 3600000;
  if (diffH < 1) return 'Now';
  if (diffH < 24) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffH < 48) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function displayThreadName(thread: ChatThread): string {
  return thread.isDefaultTenantGroup ? thread.title || 'Tenant Group Chat' : thread.title || thread.participantName;
}

function displayThreadPreview(thread: ChatThread): string {
  const body = thread.lastMessage || (thread.type === 'SMS' ? thread.externalSmsE164 : thread.participantExtension || thread.type);
  if (thread.isDefaultTenantGroup || thread.type === 'GROUP' || thread.type === 'TENANT_GROUP') {
    return body.includes(':') ? body : `${thread.participantName}: ${body}`;
  }
  return body;
}

function isGroupThread(thread: ChatThread): boolean {
  return thread.isDefaultTenantGroup || thread.type === 'GROUP' || thread.type === 'TENANT_GROUP';
}

function deliveryIcon(status?: string | null): keyof typeof Ionicons.glyphMap {
  if (status === 'FAILED') return 'alert-circle-outline';
  if (status === 'DELIVERED' || status === 'READ') return 'checkmark-done';
  return 'checkmark';
}

/** In-thread: single tick until read; doubles only for READ (matches mockups). */
function bubbleDeliveryIcon(status?: string | null): keyof typeof Ionicons.glyphMap {
  if (status === 'FAILED') return 'alert-circle-outline';
  if (status === 'READ') return 'checkmark-done';
  return 'checkmark';
}

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const diffSec = (Date.now() - d.getTime()) / 1000;
  if (diffSec >= 0 && diffSec < 60) return 'Now';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ChatTab() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async (isRefresh = false) => {
    if (!token) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const next = await getChatThreads(token);
      setThreads(next);
      setActiveThread((current) => current ? next.find((t) => t.id === current.id) ?? current : null);
    } catch {
      setError('Could not load chat.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  const loadMessages = useCallback(async () => {
    if (!token || !activeThread) {
      setMessages([]);
      return;
    }
    setMessageLoading(true);
    try {
      setMessages(await getMessages(token, activeThread.id));
    } catch {
      setMessages([]);
    } finally {
      setMessageLoading(false);
    }
  }, [activeThread, token]);

  useEffect(() => {
    loadThreads(false);
  }, [loadThreads]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!token) return undefined;
    return subscribeToChat(() => {
      loadThreads(true);
      loadMessages();
    });
  }, [loadMessages, loadThreads, token]);

  const counts = useMemo(() => ({
    all: threads.length,
    unread: threads.filter((t) => t.unread > 0).length,
    groups: threads.filter(isGroupThread).length,
    dms: threads.filter((t) => !isGroupThread(t) && t.type !== 'SMS').length,
  }), [threads]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads
      .filter((thread) => {
        if (filter === 'unread') return thread.unread > 0;
        if (filter === 'groups') return isGroupThread(thread);
        if (filter === 'dms') return !isGroupThread(thread) && thread.type !== 'SMS';
        return true;
      })
      .filter((thread) =>
        !q ||
        displayThreadName(thread).toLowerCase().includes(q) ||
        thread.participantName.toLowerCase().includes(q) ||
        thread.participantExtension.includes(q) ||
        (thread.externalSmsE164 || '').includes(q),
      )
      .sort((a, b) => {
        if (a.isDefaultTenantGroup && !b.isDefaultTenantGroup) return -1;
        if (!a.isDefaultTenantGroup && b.isDefaultTenantGroup) return 1;
        return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
      });
  }, [filter, query, threads]);

  const send = useCallback(async () => {
    if (!token || !activeThread || !draft.trim() || sending) return;
    const body = draft.trim();
    setDraft('');
    setSending(true);
    try {
      await sendChatMessage(token, activeThread.id, body);
      await loadThreads(true);
      await loadMessages();
    } catch {
      setDraft(body);
    } finally {
      setSending(false);
    }
  }, [activeThread, draft, loadMessages, loadThreads, sending, token]);

  const threadTitle = activeThread ? displayThreadName(activeThread) : undefined;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {!activeThread ? (
        <>
          <View style={[styles.inboxHeader, { paddingTop: insets.top + 12 }]}>
            <View>
              <Text style={[styles.headerTitle, { color: colors.text }]}>Chat</Text>
              <Text style={[styles.headerSub, { color: colors.textSecondary }]}>{threads.length} conversations</Text>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity style={[styles.headerIcon, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
                <Ionicons name="filter-outline" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.headerIcon, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
                <Ionicons name="create-outline" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.searchBox, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
            <Ionicons name="search-outline" size={17} color={colors.textTertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search conversations..."
              placeholderTextColor={colors.textTertiary}
              style={[styles.searchInput, { color: colors.text }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>

          <HorizontalFilterScroll marginBottom={spacing['2']}>
            <ChatFilterChip id="all" label="All" count={counts.all} value={filter} onPress={setFilter} />
            <ChatFilterChip id="unread" label="Unread" count={counts.unread} value={filter} onPress={setFilter} />
            <ChatFilterChip id="groups" label="Groups" count={counts.groups} value={filter} onPress={setFilter} />
            <ChatFilterChip id="dms" label="DMs" count={counts.dms} value={filter} onPress={setFilter} />
          </HorizontalFilterScroll>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : error ? (
            <EmptyState icon="alert-circle-outline" title="Could not load chat" subtitle={error} />
          ) : filtered.length === 0 ? (
            <EmptyState icon="chatbubbles-outline" title="No conversations yet." subtitle="Direct messages, tenant chat, and SMS threads will appear here." />
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.id}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadThreads(true)} tintColor={colors.primary} />}
              contentContainerStyle={styles.threadList}
              renderItem={({ item }) => (
                <ThreadRow
                  thread={item}
                  onPress={() => setActiveThread(item)}
                  onArchive={() => Alert.alert('Archive', 'Archive is not available from mobile yet.')}
                  onMarkRead={() => Alert.alert('Marked read', displayThreadName(item))}
                />
              )}
            />
          )}
        </>
      ) : (
        <>
          <View style={[styles.chatHeader, { paddingTop: insets.top + 8 }]}>
            <TouchableOpacity onPress={() => setActiveThread(null)} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={23} color={colors.text} />
            </TouchableOpacity>
            <Avatar name={threadTitle || 'Chat'} size="md" online={true} />
            <View style={styles.chatHeaderInfo}>
              <Text style={[styles.chatTitle, { color: colors.text }]} numberOfLines={1}>{threadTitle}</Text>
              {activeThread && isGroupThread(activeThread) ? (
                <Text style={[styles.chatSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                  <Text style={{ color: colors.textSecondary }}>12 members, </Text>
                  <Text style={{ color: colors.successText }}>5 online</Text>
                </Text>
              ) : activeThread ? (
                <Text style={[styles.chatSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                  {activeThread.type === 'SMS' ? activeThread.externalSmsE164 || 'SMS' : activeThread.participantExtension || activeThread.type}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity style={styles.chatHeaderIcon}>
              <Ionicons name="call-outline" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.chatHeaderIcon}>
              <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>

          {activeThread && isGroupThread(activeThread) && (
            <View style={[styles.pinnedBar, { backgroundColor: colors.surfaceElevated + 'aa', borderBottomColor: colors.borderSubtle }]}>
              <Ionicons name="pin-outline" size={15} color={colors.text} />
              <View style={styles.pinnedTextWrap}>
                <Text style={[styles.pinnedTitle, { color: colors.primary }]}>Pinned</Text>
                <Text style={[styles.pinnedText, { color: colors.textTertiary }]} numberOfLines={1}>Welcome to the tenant group. Keep everyone aligned here.</Text>
              </View>
              <Text style={[styles.pinnedView, { color: colors.primary }]}>View</Text>
            </View>
          )}

          {messageLoading ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : (
            <FlatList
              data={messages}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messageList}
              ListHeaderComponent={messages.length ? (
                <View style={styles.dayDivider}>
                  <Text style={[styles.dayText, { color: colors.textTertiary }]}>Today</Text>
                </View>
              ) : null}
              renderItem={({ item, index }) => {
                const prev = messages[index - 1];
                const grouped = Boolean(prev && prev.senderId === item.senderId && prev.mine === item.mine);
                return (
                  <MessageBubble
                    message={item}
                    grouped={grouped}
                    onAction={() => Alert.alert('Message actions', item.body || item.type, [
                      { text: 'Reply' },
                      { text: 'Copy' },
                      { text: 'Delete', style: 'destructive' },
                      { text: 'Cancel', style: 'cancel' },
                    ])}
                  />
                );
              }}
            />
          )}

          <View style={[styles.composerShell, { backgroundColor: colors.bgSecondary + 'f4', borderTopColor: colors.borderSubtle, paddingBottom: Math.max(insets.bottom, 10) }]}>
            <View style={[styles.composerFieldWrap, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
              <TouchableOpacity style={styles.composerInnerIcon} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Ionicons name="add" size={20} color={colors.text} />
              </TouchableOpacity>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Message..."
                placeholderTextColor={colors.textTertiary}
                style={[styles.composerInputInner, { color: colors.text }]}
                multiline
              />
              {!!draft.trim() && (
                <View style={styles.composerInnerRight}>
                  <TouchableOpacity style={styles.composerInnerSmallIcon} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Ionicons name="camera-outline" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.composerInnerSmallIcon} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Ionicons name="attach-outline" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
            {!draft.trim() ? (
              <TouchableOpacity style={[styles.micButton, { backgroundColor: colors.primary }]}>
                <Ionicons name="mic" size={20} color="#fff" />
              </TouchableOpacity>
            ) : (
              <SendButton onPress={send} disabled={sending} />
            )}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const ChatFilterChip = memo(function ChatFilterChip({
  id,
  label,
  count,
  value,
  onPress,
}: {
  id: ChatFilter;
  label: string;
  count: number;
  value: ChatFilter;
  onPress: (next: ChatFilter) => void;
}) {
  const { colors } = useTheme();
  const active = id === value;
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() => onPress(id)}
      style={[
        styles.filterChip,
        {
          backgroundColor: active ? colors.primary : colors.transparent,
          borderColor: active ? colors.primary : colors.borderSubtle,
        },
      ]}
    >
      <Text style={[styles.filterText, { color: active ? '#fff' : colors.textSecondary }]}>{label}</Text>
      {count > 0 && (
        <View style={[styles.countBadge, { backgroundColor: active ? 'rgba(255,255,255,0.25)' : colors.surfaceElevated }]}>
          <Text style={[styles.countText, { color: active ? '#fff' : colors.textTertiary }]}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

const ThreadRow = memo(function ThreadRow({
  thread,
  onPress,
  onMarkRead,
  onArchive,
}: {
  thread: ChatThread;
  onPress: () => void;
  onMarkRead: () => void;
  onArchive: () => void;
}) {
  const { colors } = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const name = displayThreadName(thread);
  const group = isGroupThread(thread);
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(-92, Math.min(gesture.dx, 84)));
    },
    onPanResponderRelease: (_, gesture) => {
      const action = gesture.dx > 54 ? 'read' : gesture.dx < -54 ? 'archive' : null;
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      if (action === 'read') onMarkRead();
      if (action === 'archive') onArchive();
    },
  }), [onArchive, onMarkRead, translateX]);

  return (
    <View style={styles.threadSwipeWrap}>
      <View style={styles.threadSwipeBg}>
        <View style={[styles.swipeHint, { backgroundColor: colors.primaryMuted }]}>
          <Ionicons name="checkmark-done-outline" size={16} color={colors.primary} />
        </View>
        <View style={[styles.swipeHint, { backgroundColor: colors.dangerMuted }]}>
          <Ionicons name="archive-outline" size={16} color={colors.danger} />
        </View>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <TouchableOpacity
          style={[styles.threadRow, { backgroundColor: colors.bg, borderBottomColor: colors.borderSubtle }]}
          onPress={onPress}
          activeOpacity={0.82}
        >
          <Avatar name={name || thread.type} size="md" online={group || thread.unread > 0} />
          <View style={styles.threadInfo}>
            <View style={styles.threadNameLine}>
              <Text style={[styles.threadName, { color: colors.text }]} numberOfLines={1}>{name}</Text>
              {group && (
                <View style={[styles.groupPill, { backgroundColor: colors.primaryMuted, borderColor: colors.primary + '55' }]}>
                  <Text style={[styles.groupPillText, { color: colors.primary }]}>Group</Text>
                </View>
              )}
            </View>
            <Text style={[styles.previewText, { color: colors.textSecondary }]} numberOfLines={1}>
              {displayThreadPreview(thread)}
            </Text>
          </View>
          <View style={styles.threadRight}>
            <Text style={[styles.threadTime, { color: colors.textTertiary }]}>{formatThreadTime(thread.lastAt)}</Text>
            {thread.unread > 0 ? (
              <View style={[styles.unreadBadge, { backgroundColor: colors.primary }]}>
                <Text style={styles.unreadText}>{thread.unread > 99 ? '99+' : thread.unread}</Text>
              </View>
            ) : thread.deliveryStatus ? (
              <Ionicons name={deliveryIcon(thread.deliveryStatus)} size={13} color={colors.primary} />
            ) : (
              <View style={{ width: 14, height: 14 }} />
            )}
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
});

const MessageBubble = memo(function MessageBubble({
  message,
  grouped,
  onAction,
}: {
  message: ChatMessage;
  grouped: boolean;
  onAction: () => void;
}) {
  const { colors } = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [opacity, y]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 16 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(-44, Math.min(gesture.dx, 44)));
    },
    onPanResponderRelease: (_, gesture) => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      if (Math.abs(gesture.dx) > 36) Alert.alert('Reply', message.body || message.type);
    },
  }), [message, translateX]);

  return (
    <Animated.View
      style={[
        styles.messageRow,
        message.mine ? styles.messageRowMine : styles.messageRowTheirs,
        { opacity, transform: [{ translateY: y }, { translateX }] },
        grouped ? styles.messageGrouped : null,
      ]}
      {...panResponder.panHandlers}
    >
      {!message.mine && !grouped ? <Avatar name={message.senderName || 'Connect'} size="sm" /> : !message.mine ? <View style={styles.avatarSpacer} /> : null}
      {message.mine ? (
        <TouchableOpacity activeOpacity={0.86} onPress={onAction} onLongPress={onAction} style={[styles.bubble, styles.bubbleMine]}>
          <LinearGradient
            colors={[colors.primary, '#1d4ed8']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.bubbleGradient}
          >
            <Text style={[styles.messageText, { color: '#fff' }]}>{message.body || `[${message.type.toLowerCase()}]`}</Text>
            <View style={styles.bubbleMeta}>
              <Text style={[styles.timeText, { color: 'rgba(255,255,255,0.72)' }]}>{formatMessageTime(message.sentAt)}</Text>
              <Ionicons
                name={bubbleDeliveryIcon(message.deliveryStatus)}
                size={12}
                color={message.deliveryStatus === 'READ' ? '#93c5fd' : 'rgba(255,255,255,0.88)'}
              />
            </View>
          </LinearGradient>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          activeOpacity={0.86}
          onPress={onAction}
          onLongPress={onAction}
          style={[
            styles.bubble,
            styles.bubbleTheirs,
            {
              backgroundColor: colors.surfaceElevated + 'e6',
              borderColor: colors.borderSubtle,
            },
          ]}
        >
          {!message.mine && !grouped && (
            <Text style={[styles.senderName, { color: colors.teal }]}>{message.senderName}</Text>
          )}
          <Text style={[styles.messageText, { color: colors.text }]}>{message.body || `[${message.type.toLowerCase()}]`}</Text>
          <View style={styles.bubbleMeta}>
            <Text style={[styles.timeText, { color: colors.textTertiary }]}>{formatMessageTime(message.sentAt)}</Text>
          </View>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
});

function SendButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(0.85)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8 }).start();
  }, [scale]);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity style={[styles.sendBtn, { backgroundColor: colors.primary }]} onPress={onPress} disabled={disabled}>
        <Ionicons name="send" size={18} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  inboxHeader: {
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 27,
    lineHeight: 33,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  headerSub: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    height: 42,
    borderRadius: 17,
    borderWidth: 1,
    paddingHorizontal: 12,
    marginHorizontal: spacing['5'],
    marginBottom: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    letterSpacing: 0,
    paddingVertical: 0,
  },
  /** Android RN clips fully-rounded bordered pills when overflow is hidden. */
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 82,
    height: 34,
    paddingHorizontal: 12,
    paddingVertical: 0,
    borderRadius: radius.full,
    borderWidth: 1,
    gap: 6,
  },
  filterText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.1,
  },
  countBadge: {
    minWidth: 20,
    height: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  countText: {
    fontSize: 10,
    fontWeight: '800',
  },
  threadList: {
    paddingHorizontal: spacing['5'],
    paddingTop: spacing['1'],
    paddingBottom: 110,
  },
  threadSwipeWrap: { overflow: 'hidden' },
  threadSwipeBg: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  swipeHint: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  threadRow: {
    height: 68,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  threadInfo: { flex: 1, minWidth: 0 },
  threadNameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  threadName: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: -0.15,
  },
  previewText: {
    fontSize: 12.5,
    lineHeight: 16,
    opacity: 0.62,
  },
  groupPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  groupPillText: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  threadRight: {
    width: 58,
    alignSelf: 'stretch',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingVertical: 11,
  },
  threadTime: {
    fontSize: 11,
    fontWeight: '700',
    opacity: 0.6,
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    paddingBottom: 10,
    gap: 10,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatHeaderInfo: { flex: 1, minWidth: 0 },
  chatTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
  },
  chatSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  chatHeaderIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinnedBar: {
    marginHorizontal: 0,
    marginTop: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing['4'],
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pinnedTextWrap: { flex: 1, minWidth: 0 },
  pinnedTitle: { fontSize: 12, fontWeight: '800' },
  pinnedText: { fontSize: 12, lineHeight: 16 },
  pinnedView: { fontSize: 12, fontWeight: '800' },
  messageList: {
    paddingHorizontal: spacing['4'],
    paddingTop: spacing['4'],
    paddingBottom: spacing['3'],
  },
  dayDivider: {
    alignItems: 'center',
    marginBottom: spacing['4'],
  },
  dayText: {
    fontSize: 11,
    fontWeight: '700',
    opacity: 0.58,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  messageGrouped: { marginTop: 3 },
  messageRowMine: { justifyContent: 'flex-end' },
  messageRowTheirs: { justifyContent: 'flex-start' },
  avatarSpacer: { width: 32 },
  bubble: {
    maxWidth: '75%',
    borderRadius: 20,
    borderWidth: 1,
    overflow: 'hidden',
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 7,
    padding: 0,
    borderColor: 'transparent',
  },
  bubbleTheirs: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleGradient: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  senderName: {
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 3,
  },
  messageText: {
    fontSize: 14,
    lineHeight: 20,
  },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 5,
  },
  timeText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  composerShell: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing['4'],
    paddingTop: 10,
    paddingBottom: 10,
    gap: 8,
  },
  composerFieldWrap: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 6,
    paddingRight: 8,
    paddingVertical: 4,
  },
  composerInnerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  composerInputInner: {
    flex: 1,
    minHeight: 34,
    maxHeight: 106,
    paddingVertical: 8,
    paddingHorizontal: 6,
    fontSize: 15,
  },
  composerInnerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginBottom: 4,
  },
  composerInnerSmallIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
