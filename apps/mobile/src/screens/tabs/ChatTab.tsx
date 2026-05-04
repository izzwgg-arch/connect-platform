import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio, ResizeMode, Video } from 'expo-av';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useSip } from '../../context/SipContext';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import {
  createChatThread,
  deleteChatMessage,
  getChatDirectoryFull,
  getChatThreads,
  getChatTyping,
  getMessages,
  markChatThreadRead,
  mobileQueryKeys,
  reactToChatMessage,
  removeChatReaction,
  sendChatMessage,
  setChatTyping,
  uploadChatAttachment,
} from '../../api/client';
import type {
  ChatAttachment,
  ChatDirectoryUser,
  ChatLocation,
  ChatMessage,
  ChatMessageType,
  ChatThread,
  PendingChatAttachment,
} from '../../types';
import { radius, spacing } from '../../theme/spacing';
import { setActiveNotificationChatThread } from '../../notifications/notificationRouting';

type ChatFilter = 'all' | 'unread' | 'sms' | 'dms';
type ComposerMode = 'dm' | 'sms' | null;
type MediaPreview = { type: 'image' | 'video' | 'file' | 'location'; url?: string | null; title: string; subtitle?: string; location?: ChatLocation };

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJIS = ['😀', '😄', '😂', '😊', '😍', '😘', '😎', '🤔', '😢', '😡', '👍', '👏', '🙏', '🔥', '🎉', '❤️', '💙', '✅', '⭐', '🚀', '📞', '💬', '📎', '📍'];

function formatThreadTime(iso: string): string {
  const date = new Date(iso);
  const diffH = (Date.now() - date.getTime()) / 3600000;
  if (!Number.isFinite(date.getTime())) return '';
  if (diffH < 1) return 'Now';
  if (diffH < 24) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffH < 48) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function displayThreadName(thread: ChatThread): string {
  return thread.isDefaultTenantGroup ? thread.title || 'Tenant Group Chat' : thread.title || thread.participantName || 'Chat';
}

function isGroupThread(thread: ChatThread): boolean {
  return thread.isDefaultTenantGroup || thread.type === 'GROUP' || thread.type === 'TENANT_GROUP';
}

function threadKind(thread: ChatThread): string {
  if (thread.type === 'SMS') return 'SMS';
  if (thread.type === 'DM') return 'DM';
  if (isGroupThread(thread)) return 'Group';
  return thread.type;
}

function threadTarget(thread: ChatThread): string {
  return thread.type === 'SMS' ? thread.externalSmsE164 || '' : thread.participantExtension || '';
}

function previewText(thread: ChatThread): string {
  if (thread.lastMessage) return thread.lastMessage;
  if (thread.type === 'SMS') return thread.externalSmsE164 || 'SMS conversation';
  return thread.participantExtension ? `Ext ${thread.participantExtension}` : threadKind(thread);
}

function statusLabel(status?: string | null, clientStatus?: string): string {
  if (clientStatus === 'sending') return 'Sending...';
  if (clientStatus === 'failed') return 'Failed';
  const s = String(status || '').toLowerCase();
  if (s === 'queued') return 'Sending...';
  if (s === 'sent') return 'Sent';
  if (s === 'delivered') return 'Delivered';
  if (s === 'read') return 'Read';
  if (s === 'failed') return 'Failed';
  return s ? s : 'Sent';
}

function statusIcon(status?: string | null, clientStatus?: string): keyof typeof Ionicons.glyphMap {
  if (clientStatus === 'failed' || String(status || '').toLowerCase() === 'failed') return 'alert-circle-outline';
  if (String(status || '').toLowerCase() === 'delivered' || String(status || '').toLowerCase() === 'read') return 'checkmark-done';
  return 'checkmark';
}

function fileKind(mimeType = ''): ChatMessageType {
  const m = mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'IMAGE';
  if (m.startsWith('video/')) return 'VIDEO';
  if (m.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}

function attachmentPreviewType(attachment: ChatAttachment): MediaPreview['type'] {
  const m = attachment.mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

function guessMimeFromUri(uri: string, fallback = 'application/octet-stream'): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return fallback;
}

function fileNameFromUri(uri: string, fallback: string): string {
  const part = uri.split('/').pop()?.split('?')[0];
  return part || fallback;
}

export function ChatTab() {
  const { colors } = useTheme();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { token } = useAuth();
  const sip = useSip();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [query, setQuery] = useState('');
  /** New-chat modal only — must not filter messages inside an open thread. */
  const [newChatDirectorySearch, setNewChatDirectorySearch] = useState('');
  /** In-thread message search (header) only. */
  const [messageSearch, setMessageSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingChatAttachment[]>([]);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [newMode, setNewMode] = useState<ComposerMode>(null);
  const [newSmsPhone, setNewSmsPhone] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState('');
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);

  const threadsQuery = useQuery({
    queryKey: mobileQueryKeys.chatThreads,
    enabled: Boolean(token),
    queryFn: () => getChatThreads(token!),
    staleTime: 30 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchInterval: activeThread ? 7000 : 15000,
  });

  const directoryQuery = useQuery({
    queryKey: ['mobile', 'chatDirectory'],
    enabled: Boolean(token) && Boolean(newMode),
    queryFn: () => getChatDirectoryFull(token!),
    staleTime: 5 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
  });

  const messagesQuery = useQuery({
    queryKey: activeThread ? mobileQueryKeys.chatMessages(activeThread.id) : ['mobile', 'chatMessages', 'none'],
    enabled: Boolean(token && activeThread),
    queryFn: () => getMessages(token!, activeThread!.id),
    staleTime: 15 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchInterval: activeThread ? 5000 : false,
  });

  const typingQuery = useQuery({
    queryKey: activeThread ? ['mobile', 'chatTyping', activeThread.id] : ['mobile', 'chatTyping', 'none'],
    enabled: Boolean(token && activeThread && activeThread.type === 'DM'),
    queryFn: () => getChatTyping(token!, activeThread!.id),
    staleTime: 1500,
    refetchInterval: activeThread?.type === 'DM' ? 2500 : false,
  });

  const threads = threadsQuery.data ?? [];
  const remoteMessages = messagesQuery.data ?? [];
  const messages = useMemo(() => {
    const remoteIds = new Set(remoteMessages.map((m) => m.id));
    return [...remoteMessages, ...localMessages.filter((m) => m.threadId === activeThread?.id && !remoteIds.has(m.id))];
  }, [activeThread?.id, localMessages, remoteMessages]);

  useEffect(() => {
    if (!activeThread || !token) return;
    markChatThreadRead(token, activeThread.id)
      .then(() => queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads }).catch(() => undefined))
      .catch(() => undefined);
  }, [activeThread?.id, queryClient, token]);

  useEffect(() => {
    setActiveThread((current) => current ? threads.find((t) => t.id === current.id) ?? current : null);
  }, [threads]);

  useEffect(() => {
    if (activeThread && messages.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    }
  }, [activeThread?.id, messages.length]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  const counts = useMemo(() => ({
    all: threads.length,
    unread: threads.filter((t) => t.unread > 0).length,
    sms: threads.filter((t) => t.type === 'SMS').length,
    dms: threads.filter((t) => t.type === 'DM').length,
  }), [threads]);

  const filteredThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads
      .filter((thread) => {
        if (filter === 'unread') return thread.unread > 0;
        if (filter === 'sms') return thread.type === 'SMS';
        if (filter === 'dms') return thread.type === 'DM';
        return true;
      })
      .filter((thread) =>
        !q ||
        displayThreadName(thread).toLowerCase().includes(q) ||
        previewText(thread).toLowerCase().includes(q) ||
        (thread.externalSmsE164 || '').includes(q) ||
        (thread.participantExtension || '').includes(q),
      );
  }, [filter, query, threads]);

  const showToast = useCallback((message: string) => setToast(message), []);

  const refreshChat = useCallback(() => {
    threadsQuery.refetch().catch(() => undefined);
    if (activeThread) messagesQuery.refetch().catch(() => undefined);
  }, [activeThread, messagesQuery, threadsQuery]);

  const openThreadById = useCallback(async (threadId: string) => {
    if (!token) return;
    await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads });
    const nextThreads = await getChatThreads(token!);
    queryClient.setQueryData(mobileQueryKeys.chatThreads, nextThreads);
    const found = nextThreads.find((t) => t.id === threadId);
    if (found) setActiveThread(found);
  }, [queryClient, token]);

  useEffect(() => {
    setActiveNotificationChatThread(activeThread?.id ?? null);
    return () => setActiveNotificationChatThread(null);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread) setMessageSearch('');
  }, [activeThread]);

  useEffect(() => {
    const threadId = String(route.params?.threadId || '');
    if (!threadId || !token) return;
    openThreadById(threadId).catch(() => undefined);
    nav.setParams?.({ threadId: undefined });
  }, [nav, openThreadById, route.params?.threadId, token]);

  const startDm = useCallback(async (user: ChatDirectoryUser) => {
    if (!token) return;
    try {
      const res = await createChatThread(token, { type: 'dm', peerUserId: user.id });
      setNewMode(null);
      setNewChatDirectorySearch('');
      await openThreadById(res.threadId);
    } catch (err: any) {
      showToast(err?.message || 'Could not start DM.');
    }
  }, [openThreadById, showToast, token]);

  const startSms = useCallback(async () => {
    if (!token || !newSmsPhone.trim()) return;
    try {
      const res = await createChatThread(token, { type: 'sms', externalPhone: newSmsPhone.trim() });
      setNewSmsPhone('');
      setNewMode(null);
      setNewChatDirectorySearch('');
      await openThreadById(res.threadId);
    } catch (err: any) {
      showToast(err?.message || 'Could not start SMS.');
    }
  }, [newSmsPhone, openThreadById, showToast, token]);

  const uploadLocalFile = useCallback(async (file: { uri: string; name: string; type: string }) => {
    if (!token || !activeThread) return null;
    const uploaded = await uploadChatAttachment(token, activeThread.id, file);
    setPendingAttachments((current) => [...current, uploaded].slice(0, 3));
    return uploaded;
  }, [activeThread, token]);

  const pickDocument = useCallback(async () => {
    setAttachOpen(false);
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    for (const asset of res.assets.slice(0, 3 - pendingAttachments.length)) {
      await uploadLocalFile({
        uri: asset.uri,
        name: asset.name || fileNameFromUri(asset.uri, `document-${Date.now()}`),
        type: asset.mimeType || guessMimeFromUri(asset.uri),
      }).catch((err) => showToast(err?.message || 'Upload failed.'));
    }
  }, [pendingAttachments.length, showToast, uploadLocalFile]);

  const pickLibrary = useCallback(async () => {
    setAttachOpen(false);
    await ImagePicker.requestMediaLibraryPermissionsAsync();
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      quality: 0.86,
    });
    if (res.canceled) return;
    for (const asset of res.assets.slice(0, 3 - pendingAttachments.length)) {
      await uploadLocalFile({
        uri: asset.uri,
        name: asset.fileName || fileNameFromUri(asset.uri, asset.type === 'video' ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
        type: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
      }).catch((err) => showToast(err?.message || 'Upload failed.'));
    }
  }, [pendingAttachments.length, showToast, uploadLocalFile]);

  const captureCamera = useCallback(async (video = false) => {
    setAttachOpen(false);
    await ImagePicker.requestCameraPermissionsAsync();
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: video ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images,
      quality: 0.86,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    await uploadLocalFile({
      uri: asset.uri,
      name: asset.fileName || fileNameFromUri(asset.uri, video ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
      type: asset.mimeType || (video ? 'video/mp4' : 'image/jpeg'),
    }).catch((err) => showToast(err?.message || 'Upload failed.'));
  }, [showToast, uploadLocalFile]);

  const sendPreparedMessage = useCallback(async (options?: { body?: string; type?: Exclude<ChatMessageType, 'SYSTEM'>; location?: ChatLocation; attachments?: PendingChatAttachment[]; retryId?: string }) => {
    if (!token || !activeThread) return;
    const body = options?.body ?? draft.trim();
    const attachments = options?.attachments ?? pendingAttachments;
    const type = (options?.type || (attachments[0] ? fileKind(attachments[0].mimeType) : 'TEXT')) as Exclude<ChatMessageType, 'SYSTEM'>;
    if (!body && attachments.length === 0 && !options?.location) return;
    const reply = replyingTo;
    const localId = options?.retryId || `local:${Date.now()}`;
    const optimistic: ChatMessage = {
      id: localId,
      threadId: activeThread.id,
      senderId: 'me',
      senderName: 'You',
      body,
      sentAt: new Date().toISOString(),
      mine: true,
      type,
      clientStatus: 'sending',
      replyTo: reply ? { id: reply.id, body: reply.body, type: reply.type, senderName: reply.senderName } : null,
      attachments: attachments.map((a, index) => ({
        id: `${localId}:att:${index}`,
        fileName: a.fileName,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        downloadUrl: a.localUri || null,
      })),
      location: options?.location || null,
    };
    if (!options?.retryId) {
      setDraft('');
      setPendingAttachments([]);
      setReplyingTo(null);
      setLocalMessages((current) => [...current, optimistic]);
    } else {
      setLocalMessages((current) => current.map((m) => m.id === localId ? optimistic : m));
    }
    try {
      const sent = await sendChatMessage(token, activeThread.id, {
        body,
        type,
        location: options?.location,
        replyToMessageId: reply?.id,
        attachments,
      });
      setLocalMessages((current) => current.filter((m) => m.id !== localId));
      await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatMessages(activeThread.id) });
      await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads });
      if (sent.deliveryStatus === 'queued') showToast('Message queued.');
    } catch (err: any) {
      setLocalMessages((current) => current.map((m) => m.id === localId ? { ...m, clientStatus: 'failed', deliveryError: err?.message || 'Send failed' } : m));
      showToast(err?.message || 'Message failed. Tap retry.');
    }
  }, [activeThread, draft, pendingAttachments, queryClient, replyingTo, showToast, token]);

  const shareLocation = useCallback(async () => {
    setAttachOpen(false);
    if (!token || !activeThread) return;
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      showToast('Location permission is required.');
      return;
    }
    const pos = await Location.getCurrentPositionAsync({});
    const location = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Current location' };
    if (activeThread.type === 'SMS') {
      setDraft((current) => `${current ? `${current}\n` : ''}Location: https://maps.google.com/?q=${location.lat},${location.lng}`);
    } else {
      await sendPreparedMessage({ body: '', type: 'LOCATION', location });
    }
  }, [activeThread, sendPreparedMessage, showToast, token]);

  const send = useCallback(() => sendPreparedMessage(), [sendPreparedMessage]);

  const startRecording = useCallback(async () => {
    if (!activeThread || !token || recording) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        showToast('Microphone permission is required.');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
      setRecording(true);
    } catch (err: any) {
      setRecording(false);
      showToast(err?.message || 'Could not start recording.');
    }
  }, [activeThread, recording, showToast, token]);

  const stopRecording = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    setRecording(false);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) return;
      const attachment = await uploadLocalFile({ uri, name: `voice-note-${Date.now()}.m4a`, type: 'audio/mp4' });
      if (attachment) await sendPreparedMessage({ body: '', type: 'VOICE_NOTE', attachments: [attachment] });
    } catch (err: any) {
      showToast(err?.message || 'Could not send voice note.');
    }
  }, [sendPreparedMessage, showToast, uploadLocalFile]);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (!token || !activeThread || activeThread.type !== 'DM') return;
    setChatTyping(token, activeThread.id, true).catch(() => undefined);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => setChatTyping(token, activeThread.id, false).catch(() => undefined), 1800);
  }, [activeThread, token]);

  const react = useCallback(async (message: ChatMessage, emoji: string) => {
    if (!token || !activeThread) return;
    await reactToChatMessage(token, activeThread.id, message.id, emoji).catch((err) => showToast(err?.message || 'Reaction failed.'));
    messagesQuery.refetch().catch(() => undefined);
    setSelectedMessage(null);
  }, [activeThread, messagesQuery, showToast, token]);

  const removeReaction = useCallback(async (message: ChatMessage, emoji: string) => {
    if (!token || !activeThread) return;
    await removeChatReaction(token, activeThread.id, message.id, emoji).catch(() => undefined);
    messagesQuery.refetch().catch(() => undefined);
  }, [activeThread, messagesQuery, token]);

  const copyMessage = useCallback(async (message: ChatMessage) => {
    await Clipboard.setStringAsync(message.body || message.attachments?.map((a) => a.fileName).join(', ') || '');
    setSelectedMessage(null);
    showToast('Copied.');
  }, [showToast]);

  const deleteMessage = useCallback((message: ChatMessage, mode: 'me' | 'everyone') => {
    if (!token || !activeThread) return;
    Alert.alert(
      mode === 'everyone' ? 'Delete for everyone?' : 'Delete message?',
      mode === 'everyone' ? 'This removes the message from the conversation for everyone.' : 'This removes the message only for you.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteChatMessage(token, activeThread.id, message.id, mode).catch((err) => showToast(err?.message || 'Delete failed.'));
            setSelectedMessage(null);
            messagesQuery.refetch().catch(() => undefined);
            threadsQuery.refetch().catch(() => undefined);
          },
        },
      ],
    );
  }, [activeThread, messagesQuery, showToast, threadsQuery, token]);

  const callThread = useCallback(() => {
    if (!activeThread) return;
    const target = threadTarget(activeThread);
    if (target && sip.registrationState === 'registered') sip.dial(target);
  }, [activeThread, sip]);

  const retryMessage = useCallback((message: ChatMessage) => {
    const localAtts: PendingChatAttachment[] = (message.attachments || []).map((a) => ({
      storageKey: '',
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      fileName: a.fileName,
      localUri: a.downloadUrl || undefined,
    })).filter((a) => a.storageKey);
    sendPreparedMessage({ body: message.body, type: message.type === 'SYSTEM' ? 'TEXT' : message.type, attachments: localAtts, retryId: message.id });
  }, [sendPreparedMessage]);

  const typingUsers = typingQuery.data ?? [];
  const directoryUsers = directoryQuery.data?.users ?? [];
  const filteredUsers = useMemo(() => {
    const q = newChatDirectorySearch.trim().toLowerCase();
    return directoryUsers
      .filter((u) => !u.self)
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.extensionNumber || '').includes(q));
  }, [directoryUsers, newChatDirectorySearch]);

  const displayedMessages = useMemo(() => {
    const q = messageSearch.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => {
      const hay = `${m.body || ''} ${m.senderName || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [messageSearch, messages]);

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {!activeThread ? (
        <View style={styles.container}>
          <View style={[styles.inboxHeader, { paddingTop: insets.top + 12 }]}>
            <View>
              <Text style={[styles.headerTitle, { color: colors.text }]}>Chat</Text>
              <Text style={[styles.headerSub, { color: colors.textSecondary }]}>{threads.length} conversations</Text>
            </View>
            <TouchableOpacity
              style={[styles.headerIcon, { backgroundColor: colors.primary, borderColor: colors.primary }]}
              onPress={() => setNewMode('dm')}
              activeOpacity={0.8}
            >
              <Ionicons name="add" size={22} color="#fff" />
            </TouchableOpacity>
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
          </View>
          <HorizontalFilterScroll marginBottom={spacing['2']}>
            <ChatFilterChip id="all" label="All" count={counts.all} value={filter} onPress={setFilter} />
            <ChatFilterChip id="unread" label="Unread" count={counts.unread} value={filter} onPress={setFilter} />
            <ChatFilterChip id="sms" label="SMS" count={counts.sms} value={filter} onPress={setFilter} />
            <ChatFilterChip id="dms" label="DMs" count={counts.dms} value={filter} onPress={setFilter} />
          </HorizontalFilterScroll>
          {threadsQuery.isLoading && filteredThreads.length === 0 ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : filteredThreads.length === 0 ? (
            <EmptyState icon="chatbubbles-outline" title="No conversations yet." subtitle="Start a DM or SMS thread with the plus button." />
          ) : (
            <FlatList
              data={filteredThreads}
              keyExtractor={(item) => item.id}
              bounces={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
              refreshControl={<RefreshControl refreshing={threadsQuery.isRefetching} onRefresh={refreshChat} tintColor={colors.primary} />}
              contentContainerStyle={styles.threadList}
              renderItem={({ item }) => <ThreadRow thread={item} onPress={() => setActiveThread(item)} />}
            />
          )}
        </View>
      ) : (
        <View style={styles.container}>
          <View style={[styles.chatHeader, { paddingTop: insets.top + 8, borderBottomColor: colors.borderSubtle }]}>
            <TouchableOpacity
              onPress={() => {
                setMessageSearch('');
                setActiveThread(null);
              }}
              style={styles.backBtn}
            >
              <Ionicons name="chevron-back" size={23} color={colors.text} />
            </TouchableOpacity>
            <Avatar name={displayThreadName(activeThread)} size="md" online={activeThread.type === 'DM'} />
            <View style={styles.chatHeaderInfo}>
              <Text style={[styles.chatTitle, { color: colors.text }]} numberOfLines={1}>{displayThreadName(activeThread)}</Text>
              <Text style={[styles.chatSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                {typingUsers.length ? `${typingUsers[0].name} is typing...` : `${threadKind(activeThread)} ${threadTarget(activeThread) ? `· ${threadTarget(activeThread)}` : ''}`}
              </Text>
            </View>
            <TouchableOpacity style={styles.chatHeaderIcon} onPress={callThread}>
              <Ionicons name="call-outline" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.chatHeaderIcon} onPress={() => setMessageSearch((v) => (v ? '' : ' '))}>
              <Ionicons name="search-outline" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>
          {messageSearch !== '' && (
            <View style={[styles.inThreadSearch, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
              <Ionicons name="search-outline" size={16} color={colors.textTertiary} />
              <TextInput
                value={messageSearch}
                onChangeText={setMessageSearch}
                autoFocus
                placeholder="Search in chat..."
                placeholderTextColor={colors.textTertiary}
                style={[styles.searchInput, { color: colors.text }]}
              />
              <TouchableOpacity onPress={() => setMessageSearch('')}>
                <Ionicons name="close" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}
          {messagesQuery.isLoading && messages.length === 0 ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : (
            <FlatList
              ref={listRef}
              data={displayedMessages}
              keyExtractor={(item) => item.id}
              bounces={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
              contentContainerStyle={styles.messageList}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
              initialNumToRender={18}
              maxToRenderPerBatch={12}
              windowSize={9}
              removeClippedSubviews={Platform.OS === 'android'}
              renderItem={({ item, index }) => {
                const prev = displayedMessages[index - 1];
                const grouped = Boolean(prev && prev.senderId === item.senderId && prev.mine === item.mine);
                return (
                  <MessageBubble
                    message={item}
                    grouped={grouped}
                    search={messageSearch.trim()}
                    onOpenMedia={setMediaPreview}
                    onAction={() => setSelectedMessage(item)}
                    onReply={() => setReplyingTo(item)}
                    onRemoveReaction={(emoji) => removeReaction(item, emoji)}
                    onRetry={() => retryMessage(item)}
                  />
                );
              }}
            />
          )}
          <Composer
            draft={draft}
            onDraft={handleDraftChange}
            pending={pendingAttachments}
            onRemovePending={(index) => setPendingAttachments((current) => current.filter((_, i) => i !== index))}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            onAttach={() => setAttachOpen(true)}
            onCamera={() => captureCamera(false)}
            onEmoji={() => setEmojiOpen((v) => !v)}
            onSend={send}
            onRecordStart={startRecording}
            onRecordEnd={stopRecording}
            recording={recording}
            bottomInset={Math.max(insets.bottom, 10)}
          />
        </View>
      )}

      <NewChatModal
        visible={Boolean(newMode)}
        mode={newMode}
        users={filteredUsers}
        search={newChatDirectorySearch}
        smsPhone={newSmsPhone}
        loading={directoryQuery.isLoading}
        onSearch={setNewChatDirectorySearch}
        onSmsPhone={setNewSmsPhone}
        onMode={setNewMode}
        onClose={() => {
          setNewMode(null);
          setNewChatDirectorySearch('');
        }}
        onStartDm={startDm}
        onStartSms={startSms}
      />
      <AttachmentMenu
        visible={attachOpen}
        onClose={() => setAttachOpen(false)}
        onDocument={pickDocument}
        onLibrary={pickLibrary}
        onCamera={() => captureCamera(false)}
        onVideo={() => captureCamera(true)}
        onLocation={shareLocation}
        onContact={() => showToast('Contact sharing uses directory selection in this build.')}
      />
      <EmojiPanel visible={emojiOpen} onPick={(emoji) => setDraft((v) => `${v}${emoji}`)} onClose={() => setEmojiOpen(false)} />
      <MessageActions
        thread={activeThread}
        message={selectedMessage}
        onClose={() => setSelectedMessage(null)}
        onCopy={copyMessage}
        onReply={(message) => { setReplyingTo(message); setSelectedMessage(null); }}
        onReact={react}
        onDelete={deleteMessage}
      />
      <MediaViewer preview={mediaPreview} onClose={() => setMediaPreview(null)} />
      {toast ? (
        <View style={[styles.toast, { bottom: Math.max(insets.bottom, 10) + 76, backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
          <Text style={[styles.toastText, { color: colors.text }]}>{toast}</Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const ChatFilterChip = memo(function ChatFilterChip({ id, label, count, value, onPress }: {
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
      style={[styles.filterChip, { backgroundColor: active ? colors.primary : colors.transparent, borderColor: active ? colors.primary : colors.borderSubtle }]}
    >
      <Text style={[styles.filterText, { color: active ? '#fff' : colors.textSecondary }]}>{label}</Text>
      {count > 0 ? (
        <View style={[styles.countBadge, { backgroundColor: active ? 'rgba(255,255,255,0.25)' : colors.surfaceElevated }]}>
          <Text style={[styles.countText, { color: active ? '#fff' : colors.textTertiary }]}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

const ThreadRow = memo(function ThreadRow({ thread, onPress }: { thread: ChatThread; onPress: () => void }) {
  const { colors } = useTheme();
  const name = displayThreadName(thread);
  const kind = threadKind(thread);
  return (
    <TouchableOpacity style={[styles.threadRow, { backgroundColor: colors.bg, borderBottomColor: colors.borderSubtle }]} onPress={onPress} activeOpacity={0.82}>
      <Avatar name={name || thread.type} size="md" online={thread.unread > 0 || thread.type === 'DM'} />
      <View style={styles.threadInfo}>
        <View style={styles.threadNameLine}>
          <Text style={[styles.threadName, { color: colors.text }]} numberOfLines={1}>{name}</Text>
          <View style={[styles.kindPill, { backgroundColor: thread.type === 'SMS' ? colors.tealMuted : colors.primaryMuted, borderColor: thread.type === 'SMS' ? colors.teal + '55' : colors.primary + '55' }]}>
            <Text style={[styles.kindPillText, { color: thread.type === 'SMS' ? colors.teal : colors.primary }]}>{kind}</Text>
          </View>
        </View>
        <Text style={[styles.previewText, { color: colors.textSecondary }]} numberOfLines={1}>{previewText(thread)}</Text>
      </View>
      <View style={styles.threadRight}>
        <Text style={[styles.threadTime, { color: colors.textTertiary }]}>{formatThreadTime(thread.lastAt)}</Text>
        {thread.unread > 0 ? (
          <View style={[styles.unreadBadge, { backgroundColor: colors.primary }]}>
            <Text style={styles.unreadText}>{thread.unread > 99 ? '99+' : thread.unread}</Text>
          </View>
        ) : thread.deliveryStatus ? (
          <Ionicons name={statusIcon(thread.deliveryStatus)} size={14} color={colors.primary} />
        ) : <View style={{ width: 14, height: 14 }} />}
      </View>
    </TouchableOpacity>
  );
});

const MessageBubble = memo(function MessageBubble({
  message,
  grouped,
  search,
  onAction,
  onReply,
  onOpenMedia,
  onRemoveReaction,
  onRetry,
}: {
  message: ChatMessage;
  grouped: boolean;
  search: string;
  onAction: () => void;
  onReply: () => void;
  onOpenMedia: (preview: MediaPreview) => void;
  onRemoveReaction: (emoji: string) => void;
  onRetry: () => void;
}) {
  const { colors } = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const deleted = Boolean(message.deletedForEveryoneAt);
  const reactionCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const row of message.reactions || []) out[row.emoji] = (out[row.emoji] || 0) + 1;
    return out;
  }, [message.reactions]);
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 16 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => translateX.setValue(Math.max(-46, Math.min(gesture.dx, 46))),
    onPanResponderRelease: (_, gesture) => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      if (Math.abs(gesture.dx) > 36) onReply();
    },
  }), [onReply, translateX]);
  const highlighted = Boolean(search && (message.body || '').toLowerCase().includes(search.toLowerCase()));
  const bubbleStyle = message.mine
    ? [styles.bubble, styles.bubbleMine, { backgroundColor: highlighted ? colors.warningMuted : colors.primary, borderColor: 'transparent' }]
    : [styles.bubble, styles.bubbleTheirs, { backgroundColor: highlighted ? colors.warningMuted : colors.surfaceElevated, borderColor: colors.borderSubtle }];
  const textColor = message.mine ? '#fff' : colors.text;
  return (
    <Animated.View style={[styles.messageRow, message.mine ? styles.messageRowMine : styles.messageRowTheirs, grouped ? styles.messageGrouped : null, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
      {!message.mine && !grouped ? <Avatar name={message.senderName || 'Connect'} size="sm" /> : !message.mine ? <View style={styles.avatarSpacer} /> : null}
      <View style={styles.messageStack}>
        <TouchableOpacity activeOpacity={0.86} onPress={onAction} onLongPress={onAction} style={bubbleStyle}>
          {!message.mine && !grouped ? <Text style={[styles.senderName, { color: colors.teal }]}>{message.senderName}</Text> : null}
          {message.replyTo ? (
            <View style={[styles.replyInline, { backgroundColor: message.mine ? 'rgba(255,255,255,0.16)' : colors.bgSecondary }]}>
              <Ionicons name="return-up-back-outline" size={12} color={message.mine ? '#fff' : colors.primary} />
              <Text style={[styles.replyInlineText, { color: message.mine ? '#eaf2ff' : colors.textSecondary }]} numberOfLines={1}>
                {message.replyTo.senderName}: {message.replyTo.body || message.replyTo.type}
              </Text>
            </View>
          ) : null}
          {deleted ? (
            <Text style={[styles.messageText, { color: textColor, fontStyle: 'italic', opacity: 0.75 }]}>This message was deleted</Text>
          ) : (
            <>
              {message.body ? <Text style={[styles.messageText, { color: textColor }]}>{message.body}</Text> : null}
              {message.location ? (
                <TouchableOpacity
                  style={[styles.locationCard, { backgroundColor: message.mine ? 'rgba(255,255,255,0.16)' : colors.bgSecondary }]}
                  onPress={() => onOpenMedia({ type: 'location', title: message.location?.label || 'Shared location', subtitle: `${message.location?.lat.toFixed(5)}, ${message.location?.lng.toFixed(5)}`, location: message.location || undefined })}
                >
                  <Ionicons name="location" size={18} color={message.mine ? '#fff' : colors.primary} />
                  <Text style={[styles.locationText, { color: textColor }]}>Shared location</Text>
                </TouchableOpacity>
              ) : null}
              {message.attachments?.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  mine={message.mine}
                  onPress={() => onOpenMedia({ type: attachmentPreviewType(attachment), url: attachment.downloadUrl, title: attachment.fileName, subtitle: attachment.mimeType })}
                />
              ))}
              {message.mmsUrls?.map((url) => (
                <AttachmentChip
                  key={url}
                  attachment={{ id: url, fileName: 'MMS media', mimeType: 'image/*', sizeBytes: 0, downloadUrl: url }}
                  mine={message.mine}
                  onPress={() => onOpenMedia({ type: 'image', url, title: 'MMS media' })}
                />
              ))}
            </>
          )}
          <View style={styles.bubbleMeta}>
            <Text style={[styles.timeText, { color: message.mine ? 'rgba(255,255,255,0.75)' : colors.textTertiary }]}>{formatMessageTime(message.sentAt)}</Text>
            {message.mine ? <Ionicons name={statusIcon(message.deliveryStatus, message.clientStatus)} size={12} color={message.clientStatus === 'failed' ? colors.danger : '#dbeafe'} /> : null}
            {message.clientStatus === 'failed' ? (
              <TouchableOpacity onPress={onRetry}>
                <Text style={[styles.retryText, { color: message.mine ? '#fff' : colors.danger }]}>Retry</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {message.mine ? <Text style={[styles.statusTiny, { color: 'rgba(255,255,255,0.7)' }]}>{statusLabel(message.deliveryStatus, message.clientStatus)}</Text> : null}
        </TouchableOpacity>
        {Object.keys(reactionCounts).length ? (
          <View style={[styles.reactionSummary, message.mine ? styles.reactionMine : styles.reactionTheirs, { backgroundColor: colors.surfaceElevated, borderColor: colors.borderSubtle }]}>
            {Object.entries(reactionCounts).map(([emoji, count]) => (
              <TouchableOpacity key={emoji} onPress={() => onRemoveReaction(emoji)}>
                <Text style={styles.reactionSummaryText}>{emoji}{count > 1 ? ` ${count}` : ''}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
});

function AttachmentChip({ attachment, mine, onPress }: { attachment: ChatAttachment; mine: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const isImage = attachment.mimeType.toLowerCase().startsWith('image/') && attachment.downloadUrl;
  return (
    <TouchableOpacity style={[styles.attachmentChip, { backgroundColor: mine ? 'rgba(255,255,255,0.16)' : colors.bgSecondary }]} onPress={onPress} activeOpacity={0.84}>
      {isImage ? <Image source={{ uri: attachment.downloadUrl! }} style={styles.attachmentThumb} /> : <Ionicons name="document-attach-outline" size={18} color={mine ? '#fff' : colors.primary} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.attachmentName, { color: mine ? '#fff' : colors.text }]} numberOfLines={1}>{attachment.fileName}</Text>
        <Text style={[styles.attachmentMeta, { color: mine ? 'rgba(255,255,255,0.72)' : colors.textTertiary }]} numberOfLines={1}>{attachment.mimeType}</Text>
      </View>
    </TouchableOpacity>
  );
}

function Composer({
  draft,
  onDraft,
  pending,
  onRemovePending,
  replyingTo,
  onCancelReply,
  onAttach,
  onCamera,
  onEmoji,
  onSend,
  onRecordStart,
  onRecordEnd,
  recording,
  bottomInset,
}: {
  draft: string;
  onDraft: (value: string) => void;
  pending: PendingChatAttachment[];
  onRemovePending: (index: number) => void;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  onAttach: () => void;
  onCamera: () => void;
  onEmoji: () => void;
  onSend: () => void;
  onRecordStart: () => void;
  onRecordEnd: () => void;
  recording: boolean;
  bottomInset: number;
}) {
  const { colors } = useTheme();
  const canSend = Boolean(draft.trim() || pending.length);
  return (
    <View style={[styles.composerShell, { paddingBottom: bottomInset }]}>
      {replyingTo ? (
        <View style={[styles.replyPreview, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
          <Ionicons name="return-up-back-outline" size={15} color={colors.primary} />
          <Text style={[styles.replyPreviewText, { color: colors.textSecondary }]} numberOfLines={1}>Replying to {replyingTo.senderName}: {replyingTo.body || replyingTo.type}</Text>
          <TouchableOpacity onPress={onCancelReply}><Ionicons name="close" size={17} color={colors.textTertiary} /></TouchableOpacity>
        </View>
      ) : null}
      {pending.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} overScrollMode="never" style={styles.pendingRow}>
          {pending.map((item, index) => (
            <View key={`${item.storageKey}:${index}`} style={[styles.pendingChip, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
              <Text style={[styles.pendingText, { color: colors.text }]} numberOfLines={1}>{item.fileName}</Text>
              <TouchableOpacity onPress={() => onRemovePending(index)}><Ionicons name="close-circle" size={16} color={colors.textTertiary} /></TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      ) : null}
      {recording ? (
        <View style={[styles.recordingBar, { backgroundColor: colors.dangerMuted, borderColor: colors.danger }]}>
          <View style={[styles.recordDot, { backgroundColor: colors.danger }]} />
          <Text style={[styles.recordingText, { color: colors.dangerText }]}>Recording... release to send</Text>
        </View>
      ) : null}
      <View style={styles.composeRow}>
        <View style={[styles.composerField, { borderColor: colors.border }]}>
          <TouchableOpacity style={styles.composerIcon} onPress={onEmoji}>
            <Ionicons name="happy-outline" size={25} color={colors.textSecondary} />
          </TouchableOpacity>
          <TextInput
            value={draft}
            onChangeText={onDraft}
            placeholder="Message"
            placeholderTextColor={colors.textTertiary}
            style={[styles.composerInput, { color: colors.text }]}
            multiline
          />
          <TouchableOpacity style={styles.composerIcon} onPress={onAttach}>
            <Ionicons name="attach-outline" size={25} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.composerIcon} onPress={onCamera}>
            <Ionicons name="camera-outline" size={25} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        {canSend ? (
          <TouchableOpacity style={[styles.sendBtn, { backgroundColor: colors.primary }]} onPress={onSend}><Ionicons name="send" size={18} color="#fff" /></TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.sendBtn, { backgroundColor: colors.primary }]} onPressIn={onRecordStart} onPressOut={onRecordEnd}><Ionicons name="mic" size={19} color="#fff" /></TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function NewChatModal({
  visible,
  mode,
  users,
  search,
  smsPhone,
  loading,
  onSearch,
  onSmsPhone,
  onMode,
  onClose,
  onStartDm,
  onStartSms,
}: {
  visible: boolean;
  mode: ComposerMode;
  users: ChatDirectoryUser[];
  search: string;
  smsPhone: string;
  loading: boolean;
  onSearch: (value: string) => void;
  onSmsPhone: (value: string) => void;
  onMode: (mode: ComposerMode) => void;
  onClose: () => void;
  onStartDm: (user: ChatDirectoryUser) => void;
  onStartSms: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheetCard, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => undefined}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={[styles.modalTitle, { color: colors.text }]}>New message</Text>
              <Text style={[styles.modalSub, { color: colors.textSecondary }]}>Start a DM or SMS thread.</Text>
            </View>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={colors.textSecondary} /></TouchableOpacity>
          </View>
          <View style={styles.modeRow}>
            <TouchableOpacity style={[styles.modeButton, { backgroundColor: mode === 'dm' ? colors.primary : colors.surfaceElevated }]} onPress={() => onMode('dm')}>
              <Text style={[styles.modeText, { color: mode === 'dm' ? '#fff' : colors.text }]}>Direct Message</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modeButton, { backgroundColor: mode === 'sms' ? colors.primary : colors.surfaceElevated }]} onPress={() => onMode('sms')}>
              <Text style={[styles.modeText, { color: mode === 'sms' ? '#fff' : colors.text }]}>SMS</Text>
            </TouchableOpacity>
          </View>
          {mode === 'sms' ? (
            <View style={styles.smsComposer}>
              <TextInput
                value={smsPhone}
                onChangeText={onSmsPhone}
                placeholder="Enter phone number"
                keyboardType="phone-pad"
                placeholderTextColor={colors.textTertiary}
                style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
              />
              <TouchableOpacity style={[styles.primaryButton, { backgroundColor: colors.primary }]} onPress={onStartSms}>
                <Text style={styles.primaryButtonText}>Open SMS thread</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TextInput
                value={search}
                onChangeText={onSearch}
                placeholder="Search team or extension"
                placeholderTextColor={colors.textTertiary}
                style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
              />
              {loading ? <ActivityIndicator color={colors.primary} /> : (
                <FlatList
                  data={users}
                  keyExtractor={(item) => item.id}
                  style={styles.userList}
                  bounces={false}
                  overScrollMode="never"
                  renderItem={({ item }) => (
                    <TouchableOpacity style={[styles.userRow, { borderBottomColor: colors.borderSubtle }]} onPress={() => onStartDm(item)}>
                      <Avatar name={item.name} size="sm" />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.userName, { color: colors.text }]}>{item.name}</Text>
                        <Text style={[styles.userMeta, { color: colors.textSecondary }]}>{item.extensionNumber ? `Ext ${item.extensionNumber}` : item.email}</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              )}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function AttachmentMenu({ visible, onClose, onDocument, onLibrary, onCamera, onVideo, onLocation, onContact }: {
  visible: boolean;
  onClose: () => void;
  onDocument: () => void;
  onLibrary: () => void;
  onCamera: () => void;
  onVideo: () => void;
  onLocation: () => void;
  onContact: () => void;
}) {
  const { colors } = useTheme();
  const actions = [
    { label: 'Location', icon: 'location-outline' as const, onPress: onLocation },
    { label: 'Contact', icon: 'person-circle-outline' as const, onPress: onContact },
    { label: 'Document', icon: 'document-attach-outline' as const, onPress: onDocument },
    { label: 'Photo Library', icon: 'images-outline' as const, onPress: onLibrary },
    { label: 'Record Video', icon: 'videocam-outline' as const, onPress: onVideo },
    { label: 'Camera', icon: 'camera-outline' as const, onPress: onCamera },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheetCard, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => undefined}>
          <Text style={[styles.modalTitle, { color: colors.text }]}>Attach</Text>
          <View style={styles.attachGrid}>
            {actions.map((action) => (
              <TouchableOpacity key={action.label} style={[styles.attachItem, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={action.onPress}>
                <Ionicons name={action.icon} size={22} color={colors.primary} />
                <Text style={[styles.attachLabel, { color: colors.text }]}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function EmojiPanel({ visible, onPick, onClose }: { visible: boolean; onPick: (emoji: string) => void; onClose: () => void }) {
  const { colors } = useTheme();
  if (!visible) return null;
  return (
    <View style={[styles.emojiPanel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.emojiHeader}>
        <Text style={[styles.emojiTitle, { color: colors.text }]}>Emoji</Text>
        <TouchableOpacity onPress={onClose}><Ionicons name="close" size={18} color={colors.textSecondary} /></TouchableOpacity>
      </View>
      <View style={styles.emojiGrid}>
        {EMOJIS.map((emoji) => (
          <TouchableOpacity key={emoji} style={styles.emojiCell} onPress={() => onPick(emoji)}>
            <Text style={styles.emojiLarge}>{emoji}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function MessageActions({ thread, message, onClose, onCopy, onReply, onReact, onDelete }: {
  thread: ChatThread | null;
  message: ChatMessage | null;
  onClose: () => void;
  onCopy: (message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onDelete: (message: ChatMessage, mode: 'me' | 'everyone') => void;
}) {
  const { colors } = useTheme();
  if (!message) return null;
  const canEveryone = thread?.type !== 'SMS' && message.mine && !message.deletedForEveryoneAt;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.actionCard, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => undefined}>
          <View style={styles.reactionBar}>
            {QUICK_REACTIONS.map((emoji) => (
              <TouchableOpacity key={emoji} style={styles.reactionButton} onPress={() => onReact(message, emoji)}>
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <ActionRow icon="copy-outline" label="Copy" onPress={() => onCopy(message)} />
          <ActionRow icon="return-up-back-outline" label="Reply" onPress={() => onReply(message)} />
          <ActionRow icon="trash-outline" label={thread?.type === 'SMS' ? 'Delete for me' : 'Delete for me'} destructive onPress={() => onDelete(message, 'me')} />
          {canEveryone ? <ActionRow icon="trash-bin-outline" label="Delete for everyone" destructive onPress={() => onDelete(message, 'everyone')} /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({ icon, label, destructive, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; destructive?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity style={styles.actionRow} onPress={onPress}>
      <Ionicons name={icon} size={18} color={destructive ? colors.danger : colors.primary} />
      <Text style={[styles.actionText, { color: destructive ? colors.danger : colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function MediaViewer({ preview, onClose }: { preview: MediaPreview | null; onClose: () => void }) {
  const { colors } = useTheme();
  if (!preview) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.viewer, { backgroundColor: 'rgba(0,0,0,0.92)' }]}>
        <TouchableOpacity style={styles.viewerClose} onPress={onClose}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
        {preview.type === 'image' && preview.url ? (
          <Image source={{ uri: preview.url }} style={styles.viewerImage} resizeMode="contain" />
        ) : preview.type === 'video' && preview.url ? (
          <Video source={{ uri: preview.url }} style={styles.viewerVideo} useNativeControls resizeMode={ResizeMode.CONTAIN} />
        ) : (
          <View style={[styles.viewerFile, { backgroundColor: colors.surface }]}>
            <Ionicons name={preview.type === 'location' ? 'location-outline' : 'document-text-outline'} size={34} color={colors.primary} />
            <Text style={[styles.viewerTitle, { color: colors.text }]}>{preview.title}</Text>
            {preview.subtitle ? <Text style={[styles.viewerSub, { color: colors.textSecondary }]}>{preview.subtitle}</Text> : null}
          </View>
        )}
      </View>
    </Modal>
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
  headerTitle: { fontSize: 27, lineHeight: 33, fontWeight: '900', letterSpacing: -0.8 },
  headerSub: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  headerIcon: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
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
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  filterChip: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    gap: 6,
  },
  filterText: { fontSize: 12, fontWeight: '800', includeFontPadding: false, textAlignVertical: 'center' },
  countBadge: { minWidth: 20, height: 18, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  countText: { fontSize: 10, fontWeight: '800' },
  threadList: { paddingHorizontal: spacing['5'], paddingTop: spacing['1'], paddingBottom: spacing['5'] },
  threadRow: { height: 72, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  threadInfo: { flex: 1, minWidth: 0 },
  threadNameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  threadName: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: '900', letterSpacing: -0.15 },
  previewText: { fontSize: 12.5, lineHeight: 16, opacity: 0.68 },
  kindPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, borderWidth: 1 },
  kindPillText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.2 },
  threadRight: { width: 58, alignSelf: 'stretch', alignItems: 'flex-end', justifyContent: 'space-between', paddingVertical: 12 },
  threadTime: { fontSize: 11, fontWeight: '700', opacity: 0.68 },
  unreadBadge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '900' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing['4'], paddingBottom: 10, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  chatHeaderInfo: { flex: 1, minWidth: 0 },
  chatTitle: { fontSize: 15, lineHeight: 20, fontWeight: '900' },
  chatSubtitle: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
  chatHeaderIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  inThreadSearch: { height: 40, margin: spacing['3'], borderRadius: 15, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 },
  messageList: { paddingHorizontal: spacing['4'], paddingTop: spacing['4'], paddingBottom: spacing['3'] },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 8 },
  messageGrouped: { marginTop: 3 },
  messageRowMine: { justifyContent: 'flex-end' },
  messageRowTheirs: { justifyContent: 'flex-start' },
  avatarSpacer: { width: 32 },
  messageStack: { maxWidth: '78%' },
  bubble: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine: { alignSelf: 'flex-end', borderBottomRightRadius: 7 },
  bubbleTheirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 7 },
  senderName: { fontSize: 11, fontWeight: '900', marginBottom: 3 },
  messageText: { fontSize: 14, lineHeight: 20 },
  replyInline: { borderRadius: 12, padding: 8, marginBottom: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  replyInlineText: { flex: 1, fontSize: 11.5, fontWeight: '700' },
  locationCard: { marginTop: 7, borderRadius: 14, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  locationText: { fontSize: 13, fontWeight: '800' },
  attachmentChip: { marginTop: 7, borderRadius: 14, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  attachmentThumb: { width: 44, height: 44, borderRadius: 11 },
  attachmentName: { fontSize: 12.5, fontWeight: '900' },
  attachmentMeta: { fontSize: 10.5, fontWeight: '700', marginTop: 2 },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 5 },
  timeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  retryText: { fontSize: 10, fontWeight: '900', marginLeft: 4 },
  statusTiny: { marginTop: 2, alignSelf: 'flex-end', fontSize: 9, fontWeight: '800' },
  reactionSummary: { marginTop: -3, borderRadius: 12, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3, flexDirection: 'row', gap: 5 },
  reactionMine: { alignSelf: 'flex-end', marginRight: 8 },
  reactionTheirs: { alignSelf: 'flex-start', marginLeft: 8 },
  reactionSummaryText: { fontSize: 12 },
  composerShell: { paddingHorizontal: spacing['2'], paddingTop: 8, gap: 7, backgroundColor: 'transparent' },
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  composerIcon: { width: 38, height: 46, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  composerField: { flex: 1, minHeight: 46, maxHeight: 116, borderRadius: 23, borderWidth: 1, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: 'transparent' },
  composerInput: { flex: 1, minHeight: 42, maxHeight: 112, paddingHorizontal: 4, paddingVertical: 10, fontSize: 17 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  replyPreview: { borderRadius: 16, borderWidth: 1, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 8 },
  replyPreviewText: { flex: 1, fontSize: 12, fontWeight: '800' },
  pendingRow: { flexGrow: 0 },
  pendingChip: { height: 32, borderRadius: 16, borderWidth: 1, paddingHorizontal: 10, marginRight: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pendingText: { maxWidth: 180, fontSize: 12, fontWeight: '800' },
  recordingBar: { borderRadius: 16, borderWidth: 1, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordDot: { width: 9, height: 9, borderRadius: 5 },
  recordingText: { fontSize: 12, fontWeight: '900' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.58)', padding: spacing['5'] },
  sheetCard: { borderRadius: 24, borderWidth: 1, padding: spacing['4'], maxHeight: '82%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing['3'] },
  modalTitle: { fontSize: 18, lineHeight: 24, fontWeight: '900' },
  modalSub: { fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 2 },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: spacing['3'] },
  modeButton: { flex: 1, height: 42, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  modeText: { fontSize: 13, fontWeight: '900' },
  modalInput: { height: 44, borderRadius: 16, borderWidth: 1, paddingHorizontal: 13, marginBottom: spacing['3'], fontSize: 14 },
  smsComposer: { gap: 4 },
  primaryButton: { height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  userList: { maxHeight: 360 },
  userRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  userName: { fontSize: 14, fontWeight: '900' },
  userMeta: { fontSize: 12, fontWeight: '700', marginTop: 2 },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: spacing['3'] },
  attachItem: { width: '47%', minHeight: 78, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 7 },
  attachLabel: { fontSize: 12, fontWeight: '900', textAlign: 'center' },
  emojiPanel: { position: 'absolute', left: spacing['4'], right: spacing['4'], bottom: 96, borderRadius: 22, borderWidth: 1, padding: spacing['3'] },
  emojiHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  emojiTitle: { fontSize: 14, fontWeight: '900' },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  emojiCell: { width: '12.5%', height: 38, alignItems: 'center', justifyContent: 'center' },
  emojiLarge: { fontSize: 24 },
  actionCard: { marginTop: 'auto', borderRadius: 24, borderWidth: 1, padding: spacing['4'] },
  reactionBar: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing['3'] },
  reactionButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  reactionEmoji: { fontSize: 25 },
  actionRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  actionText: { fontSize: 14, fontWeight: '900' },
  viewer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerClose: { position: 'absolute', top: 50, right: 22, zIndex: 3 },
  viewerImage: { width: '100%', height: '82%' },
  viewerVideo: { width: '100%', height: '72%' },
  viewerFile: { margin: spacing['5'], borderRadius: 24, padding: spacing['6'], alignItems: 'center', gap: 10 },
  viewerTitle: { fontSize: 16, fontWeight: '900', textAlign: 'center' },
  viewerSub: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  toast: { position: 'absolute', left: spacing['5'], right: spacing['5'], borderRadius: 16, borderWidth: 1, padding: 12, alignItems: 'center' },
  toastText: { fontSize: 13, fontWeight: '800' },
});
