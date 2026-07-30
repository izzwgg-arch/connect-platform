import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  FlatList,
  Image,
  Keyboard,
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
import { Audio, InterruptionModeAndroid, ResizeMode, Video } from 'expo-av';
import { playVoiceNoteSentTone, playVoiceNoteStartTone } from '../../audio/telephonyAudio';
import {
  GestureHandlerRootView,
  PanGestureHandler,
  PinchGestureHandler,
  State as GestureState,
  TapGestureHandler,
} from 'react-native-gesture-handler';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
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
import { showAppAlert } from '../../components/ui/appAlert';
import { AppActionSheet } from '../../components/ui/AppPopup';
import { AddContactModal, type AddContactPrefill } from '../../components/AddContactModal';
import { useContactNameResolver } from '../../contacts/useContactNameResolver';
import {
  archiveChatThread,
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
import { teamFilterChipColors } from '../../theme/filterChipColors';
import { setActiveNotificationChatThread } from '../../notifications/notificationRouting';
import {
  EMOJI_CATALOG,
  loadRecentEmojis,
  recentToEntries,
  recordRecentEmoji,
  searchEmojis,
  type EmojiEntry,
} from '../../chat/emojiCatalog';

type ChatFilter = 'all' | 'unread' | 'sms' | 'dms';
type ComposerMode = 'dm' | 'sms' | null;
type MediaPreview = { type: 'image' | 'video' | 'file' | 'location'; url?: string | null; title: string; subtitle?: string; location?: ChatLocation };

const CHAT_MEDIA_MAX_WIDTH = Math.round(Dimensions.get('window').width * 0.7);

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

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

/**
 * Formats a phone number for display in chat. US/NANP numbers render as
 * (XXX) XXX-XXXX with the "+1" country code dropped — we never show "+1"
 * anywhere in chat. Non-NANP inputs only have a leading "+1"/"1" country code
 * stripped; anything unexpected is returned unchanged.
 */
function formatChatPhone(raw: string): string {
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, '');
  let local = digits;
  if (digits.length === 11 && digits.startsWith('1')) local = digits.slice(1);
  if (local.length === 10) {
    return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  }
  return raw.replace(/^\+?1(?=\d)/, '').trim();
}

/**
 * Display label for an SMS/phone contact. Strips the redundant leading "SMS "
 * tag (the SMS pill already conveys the type) and formats any phone number so
 * the "+1" country code is never shown. Real names (group titles, DM names,
 * saved contacts) are returned untouched.
 */
function prettyContactLabel(raw: string | null | undefined): string {
  if (!raw) return raw ?? '';
  const stripped = raw.replace(/^\s*SMS\s+/i, '').trim();
  const isPhoneLike =
    /^\+?[\d\s().-]+$/.test(stripped) && stripped.replace(/\D/g, '').length >= 7;
  return isPhoneLike ? formatChatPhone(stripped) : raw;
}

function displayThreadName(thread: ChatThread): string {
  if (thread.isDefaultTenantGroup) {
    // Server stores the title as "<Tenant> — Tenant Group Chat"; show only the
    // tenant/group name (everything before the em-dash suffix).
    const title = thread.title || 'Team Chat';
    return title.split(/\s*—\s*/)[0].trim() || title;
  }
  const base = thread.title || thread.participantName || 'Chat';
  return prettyContactLabel(base);
}

function isGroupThread(thread: ChatThread): boolean {
  return thread.isDefaultTenantGroup || thread.type === 'GROUP' || thread.type === 'TENANT_GROUP';
}

function threadKind(thread: ChatThread): string {
  if (thread.type === 'SMS') return 'SMS';
  if (thread.type === 'DM') return 'DM';
  if (isGroupThread(thread)) return 'Team chat';
  return thread.type;
}

/** Turn server media placeholders ("[audio]", "[image]", …) into friendly text. */
function prettyPreview(text: string): string {
  const key = text.trim().toLowerCase();
  switch (key) {
    case '[audio]':
    case '[voice_note]':
      return 'Voice note';
    case '[image]':
      return 'Photo';
    case '[video]':
      return 'Video';
    case '[file]':
      return 'Attachment';
    case '[location]':
      return 'Location';
    default:
      return text;
  }
}

/** Turn raw server error codes from /chat/threads into human-readable toasts. */
function friendlyComposeError(code?: string): string {
  switch (code) {
    case 'NO_SMS_NUMBER':
      return 'No SMS number is set up for your account — ask your admin to assign one.';
    case 'INVALID_PHONE':
      return "Can't message this number — it isn't textable.";
    case 'FORBIDDEN':
      return "You don't have permission to send messages to this contact.";
    case 'PEER_NOT_FOUND':
      return 'That person is no longer available to chat.';
    default:
      return 'Could not open chat. Please try again.';
  }
}

function threadTarget(thread: ChatThread): string {
  return thread.type === 'SMS' ? formatChatPhone(thread.externalSmsE164 || '') : thread.participantExtension || '';
}

function previewText(thread: ChatThread): string {
  if (thread.lastMessage) return prettyPreview(thread.lastMessage);
  // No duplicate info (Izzy 2026-07-28): a nameless SMS thread already shows
  // the number as its title — repeating it as the preview reads as a bug.
  if (thread.type === 'SMS') return 'No messages yet';
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

function attachmentPreviewType(attachment: ChatAttachment, messageType?: ChatMessageType): MediaPreview['type'] {
  const m = attachment.mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/') || messageType === 'VIDEO') return 'video';
  const fn = (attachment.fileName || '').toLowerCase();
  if (/\.(jpe?g|png|gif|webp|heic)$/i.test(fn)) return 'image';
  if (/\.(mp4|mov|webm)$/i.test(fn)) return 'video';
  if (m.startsWith('audio/') || messageType === 'AUDIO' || messageType === 'VOICE_NOTE') return 'file';
  return 'file';
}

function attachmentShowsImageThumb(attachment: ChatAttachment, messageType?: ChatMessageType): boolean {
  if (!attachment.downloadUrl) return false;
  const m = attachment.mimeType.toLowerCase();
  if (m.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic)$/i.test(attachment.fileName || '');
}

function isImageAttachment(attachment: ChatAttachment, messageType?: ChatMessageType): boolean {
  if (messageType === 'VOICE_NOTE') return false;
  const kind = String(attachment.mediaKind || '').toLowerCase();
  if (kind === 'video' || kind === 'audio') return false;
  const name = String(attachment.fileName || '').toLowerCase();
  // Carriers sometimes lie with image/* on voice MMS; never reserve an image tile for known-audio names.
  if (/\.(m4a|aac|mp3|wav|ogg|opus|amr|webm)$/i.test(name)) return false;
  const mime = String(attachment.mimeType || '').toLowerCase();
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return false;
  // DB default mediaKind is "file" — still infer images from MIME / extension; only reject explicit non-image kinds.
  if (kind && kind !== 'image' && kind !== 'file') return false;
  if (kind === 'image' || mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic)$/i.test(name)) return true;
  return false;
}

function isAudioAttachment(attachment: ChatAttachment, messageType?: ChatMessageType): boolean {
  const kind = String(attachment.mediaKind || '').toLowerCase();
  const mime = String(attachment.mimeType || '').toLowerCase();
  const name = String(attachment.fileName || '').toLowerCase();
  // A voice note (incl. the carrier MP4 copy) always plays as a voice note,
  // never as a video — Audio.Sound plays the MP4's audio track.
  if (isVoiceNoteFileName(name)) return true;
  if (kind === 'video' || mime.startsWith('video/')) return false;
  return kind === 'audio' || mime.startsWith('audio/') || messageType === 'AUDIO' || messageType === 'VOICE_NOTE' || /\.(m4a|aac|mp3|wav|ogg|webm)$/i.test(name);
}

/** A playable video attachment (never a voice note, which is handled as audio). */
function isVideoAttachment(attachment: ChatAttachment, messageType?: ChatMessageType): boolean {
  const name = String(attachment.fileName || '').toLowerCase();
  if (isVoiceNoteFileName(name)) return false;
  const kind = String(attachment.mediaKind || '').toLowerCase();
  const mime = String(attachment.mimeType || '').toLowerCase();
  if (kind === 'video' || mime.startsWith('video/')) return true;
  if (messageType === 'VIDEO') return true;
  return /\.(mp4|mov|webm|3gp|3gpp|m4v)$/i.test(name);
}

/** Connect voice notes are stored as `voice-note-*` files. */
function isVoiceNoteFileName(name?: string | null): boolean {
  return /voice-note/i.test(String(name || ''));
}

function attachmentBaseName(name?: string | null): string {
  return String(name || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '');
}

function isTrueAudioAttachment(a: ChatAttachment): boolean {
  const kind = String(a.mediaKind || '').toLowerCase();
  const mime = String(a.mimeType || '').toLowerCase();
  const name = String(a.fileName || '').toLowerCase();
  return kind === 'audio' || mime.startsWith('audio/') || /\.(m4a|aac|mp3|wav|ogg|opus|amr|webm)$/i.test(name);
}

/** A video/MP4 (or legacy MP3) attachment that could be the carrier MMS copy of a voice note. */
function isTransportMediaCandidate(a: ChatAttachment): boolean {
  const kind = String(a.mediaKind || '').toLowerCase();
  const mime = String(a.mimeType || '').toLowerCase();
  const name = String(a.fileName || '').toLowerCase();
  return kind === 'video' || mime.startsWith('video/') || /\.(mp4|3gp|3gpp|mpeg|mp3)$/i.test(name);
}

/**
 * Drop the carrier MP4/MP3 copy of a voice note when its audio original is
 * present (the worker names the copy after the original's basename), so a sent
 * voice note shows ONE voice-note bubble — never a video.
 */
function dropVoiceTransportDuplicates(attachments: ChatAttachment[]): ChatAttachment[] {
  const originalAudioBaseNames = new Set(
    attachments
      .filter((a) => isTrueAudioAttachment(a) && !isTransportMediaCandidate(a))
      .map((a) => attachmentBaseName(a.fileName)),
  );
  if (originalAudioBaseNames.size === 0) return attachments;
  return attachments.filter(
    (a) => !(isTransportMediaCandidate(a) && originalAudioBaseNames.has(attachmentBaseName(a.fileName))),
  );
}

/** Inbound MMS URLs (e.g. VoIP.ms media.php) — infer kind so we do not feed video/audio into Image. */
function mmsUrlToAttachment(url: string, messageId: string, index: number): ChatAttachment {
  const lower = url.toLowerCase();
  const path = lower.split(/[?#]/)[0];
  if (/\.(jpe?g|png|gif|webp|heic)(\?|$)/.test(path)) {
    return {
      id: `${messageId}:mms:${index}`,
      fileName: 'MMS image',
      mimeType: 'image/jpeg',
      sizeBytes: 0,
      downloadUrl: url,
      mediaKind: 'image',
    };
  }
  if (/\.(mp3|m4a|aac|wav|ogg|amr)(\?|$)/.test(path)) {
    return {
      id: `${messageId}:mms:${index}`,
      fileName: 'MMS audio',
      mimeType: 'audio/mpeg',
      sizeBytes: 0,
      downloadUrl: url,
      mediaKind: 'audio',
    };
  }
  if (/\.(mp4|webm|3gp|mov)(\?|$)/.test(path)) {
    return {
      id: `${messageId}:mms:${index}`,
      fileName: 'MMS video',
      mimeType: 'video/mp4',
      sizeBytes: 0,
      downloadUrl: url,
      mediaKind: 'video',
    };
  }
  if (lower.includes('media.php')) {
    return {
      id: `${messageId}:mms:${index}`,
      fileName: 'MMS media',
      mimeType: 'video/mp4',
      sizeBytes: 0,
      downloadUrl: url,
      mediaKind: 'video',
    };
  }
  return {
    id: `${messageId}:mms:${index}`,
    fileName: 'MMS attachment',
    mimeType: 'application/octet-stream',
    sizeBytes: 0,
    downloadUrl: url,
    mediaKind: 'file',
  };
}

/**
 * The API issues a fresh HMAC-signed download URL (new `exp`/`sig`) on every
 * messages fetch. Because the chat polls every 5s, an unstabilised URL changes
 * on each poll, which makes <Image> re-download and visibly flash. We cache the
 * first URL seen per attachment id and keep reusing it until it is close to
 * expiry, so the `uri` string stays identical across refetches (no flash).
 */
const stableAttachmentUrlCache = new Map<string, string>();

function signedUrlExpSeconds(url: string): number {
  const m = url.match(/[?&](?:exp|e)=(\d+)/);
  return m ? Number(m[1]) : 0;
}

function stabilizeAttachmentUrl(attachmentId: string, url: string | null | undefined): string | null {
  if (!url) return url ?? null;
  // Only stabilise our own signed URLs; external (MMS) URLs are already stable.
  if (!/[?&](?:exp|e)=\d+/.test(url)) return url;
  const cached = stableAttachmentUrlCache.get(attachmentId);
  if (cached) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (signedUrlExpSeconds(cached) - nowSec > 120) return cached;
  }
  stableAttachmentUrlCache.set(attachmentId, url);
  return url;
}

function stabilizeMessageAttachmentUrls(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) return m;
    let changed = false;
    const attachments = m.attachments.map((a) => {
      const stable = stabilizeAttachmentUrl(a.id, a.downloadUrl);
      if (stable === a.downloadUrl) return a;
      changed = true;
      return { ...a, downloadUrl: stable };
    });
    return changed ? { ...m, attachments } : m;
  });
}

function formatVoiceDuration(ms?: number | null): string {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Friendly label for a message kind when there is no text body to show. */
function friendlyTypeLabel(type?: string | null): string {
  switch (String(type || '').toUpperCase()) {
    case 'VOICE_NOTE':
    case 'AUDIO':
      return 'Voice note';
    case 'IMAGE':
      return 'Photo';
    case 'VIDEO':
      return 'Video';
    case 'FILE':
      return 'Attachment';
    case 'LOCATION':
      return 'Location';
    default:
      return 'Message';
  }
}

type ReplyPreviewMeta = { label: string; duration: string | null; thumbUri: string | null; thumbIsVideo: boolean };

/** Describe a message being replied to: friendly label, voice-note duration, and a photo/video thumbnail. */
function describeReplyTarget(msg: ChatMessage): ReplyPreviewMeta {
  const atts = msg.attachments || [];
  const audio = atts.find((a) => isAudioAttachment(a, msg.type));
  if (audio || msg.type === 'VOICE_NOTE' || msg.type === 'AUDIO') {
    const ms = audio?.durationMs ?? null;
    return { label: 'Voice note', duration: ms && ms > 0 ? formatVoiceDuration(ms) : null, thumbUri: null, thumbIsVideo: false };
  }
  const video = atts.find((a) => isVideoAttachment(a, msg.type));
  if (video || msg.type === 'VIDEO') {
    return { label: 'Video', duration: null, thumbUri: video?.downloadUrl ?? null, thumbIsVideo: true };
  }
  const image = atts.find((a) => isImageAttachment(a, msg.type));
  if (image || msg.type === 'IMAGE') {
    return { label: 'Photo', duration: null, thumbUri: image?.downloadUrl ?? null, thumbIsVideo: false };
  }
  const body = (msg.body || '').trim();
  if (body) return { label: body, duration: null, thumbUri: null, thumbIsVideo: false };
  return { label: friendlyTypeLabel(msg.type), duration: null, thumbUri: null, thumbIsVideo: false };
}

function bodyWithoutMediaLinks(body: string, hasRenderedMedia: boolean): string {
  if (!hasRenderedMedia) return body;
  return String(body || '')
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return false;
      if (/^Media:\s*https?:\/\//i.test(s)) return false;
      if (/^https?:\/\/[^ ]+\/chat\/attachments\/download\//i.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
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

/**
 * Shared voice-note player. The whole thread uses ONE Audio.Sound at a time so
 * that:
 *   - a note plays through once and STOPS (no looping), and
 *   - when it finishes, the next voice note in the thread auto-plays, chaining
 *     through every later note until they have each played once, then stops.
 * Tapping play/pause on the active note, or starting a different note, takes
 * over the chain. Pausing stops the chain (no `didJustFinish` fires).
 */
type VoiceNotePlayer = {
  activeId: string | null;
  playing: boolean;
  progress: number;
  durationMs: number | null;
  toggle: (id: string, url: string) => void;
  /** Seek the currently-active note to a 0..1 fraction of its duration. */
  seek: (id: string, fraction: number) => void;
};
const VoiceNotePlayerContext = createContext<VoiceNotePlayer | null>(null);

function useVoiceNotePlayerController(order: { id: string; url: string }[]): VoiceNotePlayer {
  const soundRef = useRef<Audio.Sound | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  const teardownSound = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    if (s) {
      try { s.setOnPlaybackStatusUpdate(null); } catch { /* ignore */ }
      await s.unloadAsync().catch(() => undefined);
    }
  }, []);

  const stop = useCallback(async () => {
    activeIdRef.current = null;
    setActiveId(null);
    setPlaying(false);
    setProgress(0);
    await teardownSound();
  }, [teardownSound]);

  const playId = useCallback(async (id: string, url: string) => {
    console.log('[VOICE_NOTE_PLAY] playId id=' + id + ' url=' + url);
    await teardownSound();
    activeIdRef.current = id;
    setActiveId(id);
    setPlaying(true);
    setProgress(0);
    setDurationMs(null);
    // Always play voice notes out of the loudspeaker, never the earpiece.
    // Recording leaves the global audio mode in a record/earpiece-routed
    // state, so reset it here before every playback.
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    }).catch(() => undefined);
    // iOS: AVPlayer cannot stream our signed download URL — the endpoint returns
    // no HTTP Range support, so AVFoundation fails with error -11850. Download the
    // note to a local cache file first and play THAT, mirroring the voicemail
    // player (which already plays source=disk). Android streams the remote URL
    // fine, so it is left completely unchanged.
    let playUri = url;
    if (Platform.OS === 'ios') {
      try {
        const safe = id.replace(/[^a-zA-Z0-9]/g, '');
        const target = (FileSystem.cacheDirectory || '') + 'cc-voice-note-' + safe + '.m4a';
        const info = await FileSystem.getInfoAsync(target).catch(() => null);
        if (info && info.exists) {
          playUri = target;
        } else {
          const dl = await FileSystem.downloadAsync(url, target);
          playUri = dl.uri;
        }
      } catch (e) {
        console.warn('[VOICE_NOTE_PLAY] ios cache download failed, using remote url: ' + (e instanceof Error ? e.message : String(e)));
        playUri = url;
      }
      // A newer note may have started while we were downloading — bail out.
      if (activeIdRef.current !== id) return;
    }
    let sound: Audio.Sound;
    try {
      ({ sound } = await Audio.Sound.createAsync(
        { uri: playUri },
        { shouldPlay: true, progressUpdateIntervalMillis: 120 },
      ));
    } catch (e) {
      console.warn('[VOICE_NOTE_PLAY] createAsync FAILED id=' + id + ' url=' + url + ' err=' + (e instanceof Error ? e.message : String(e)));
      if (activeIdRef.current === id) await stop();
      return;
    }
    // A newer note may have started while we were loading — discard this one.
    if (activeIdRef.current !== id) {
      await sound.unloadAsync().catch(() => undefined);
      return;
    }
    soundRef.current = sound;
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded || activeIdRef.current !== id) return;
      setPlaying(Boolean(status.isPlaying));
      const dur = status.durationMillis || 0;
      if (dur > 0) {
        setDurationMs(dur);
        setProgress(Math.max(0, Math.min(1, (status.positionMillis || 0) / dur)));
      }
      if (status.didJustFinish) {
        // Played through once. Advance to the next voice note in the thread,
        // or stop if this was the last one. We never reset+replay the same
        // sound (that is what caused the infinite loop).
        const ord = orderRef.current;
        const idx = ord.findIndex((o) => o.id === id);
        const next = idx >= 0 ? ord[idx + 1] : undefined;
        if (next) {
          void playId(next.id, next.url);
        } else {
          void stop();
        }
      }
    });
  }, [stop, teardownSound]);

  const toggle = useCallback(async (id: string, url: string) => {
    if (activeIdRef.current === id && soundRef.current) {
      try {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded && status.isPlaying) {
          // User stop → halt the auto-play chain (no didJustFinish fires).
          await soundRef.current.pauseAsync().catch(() => undefined);
          setPlaying(false);
          return;
        }
        if (status.isLoaded) {
          await soundRef.current.playAsync().catch(() => undefined);
          setPlaying(true);
          return;
        }
      } catch { /* fall through to reload */ }
    }
    await playId(id, url);
  }, [playId]);

  const seek = useCallback(async (id: string, fraction: number) => {
    const s = soundRef.current;
    if (activeIdRef.current !== id || !s) return;
    try {
      const status = await s.getStatusAsync();
      if (!status.isLoaded || !status.durationMillis) return;
      const f = Math.max(0, Math.min(1, fraction));
      await s.setPositionAsync(Math.round(f * status.durationMillis));
      setProgress(f);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => () => { void teardownSound(); }, [teardownSound]);

  return useMemo(
    () => ({ activeId, playing, progress, durationMs, toggle, seek }),
    [activeId, playing, progress, durationMs, toggle, seek],
  );
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
  const invertedMessagesRef = useRef<ChatMessage[]>([]);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  // Long-press → per-user delete ("archive"): hides the conversation from this
  // list only; the other side keeps their history and any new message
  // resurfaces the thread (Izzy 2026-07-28).
  const [threadPendingDelete, setThreadPendingDelete] = useState<ChatThread | null>(null);

  // Add-to-contacts from an SMS thread (Izzy 2026-07-28): offered on the
  // long-press sheet for nameless SMS numbers; reuses the shared modal.
  const [addContactPrefill, setAddContactPrefill] = useState<AddContactPrefill | null>(null);
  const handleContactCreated = useCallback(
    (saved?: { displayName: string }) => {
      setAddContactPrefill(null);
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.contacts('') }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads }).catch(() => undefined);
      if (saved?.displayName) showAppAlert('Saved', `${saved.displayName} added to contacts.`);
    },
    [queryClient],
  );

  // Contact-name backfill (Izzy 2026-07-28): saved contact names replace raw
  // numbers everywhere, live from the shared contacts cache.
  const resolveContactName = useContactNameResolver();

  // Stable renderItem (freeze investigation 2026-07-28): keeps ThreadRow's
  // memo effective across unrelated ChatTab re-renders (poll ticks, typing).
  const renderThreadItem = useCallback(
    ({ item }: { item: ChatThread }) => (
      <ThreadRow
        thread={item}
        nameOverride={item.type === 'SMS' ? resolveContactName(item.externalSmsE164) : null}
        onPress={() => setActiveThread(item)}
        onLongPress={() => setThreadPendingDelete(item)}
      />
    ),
    [resolveContactName],
  );
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
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState('');
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [mediaLinkError, setMediaLinkError] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // Whether the message list is pinned to the bottom. We only auto-scroll on
  // new content when the user is already at the bottom, so reading older
  // messages isn't interrupted by background refetches or incoming messages.
  const atBottomRef = useRef(true);
  // True from the moment a thread is opened until its messages have been placed
  // at the bottom once. While true we only ever jump (never animate) so opening
  // a chat lands flat at the newest message instead of visibly rolling down.
  const pendingInitialScrollRef = useRef(false);

  const scrollToBottom = useCallback((animated: boolean) => {
    // Inverted list: the newest message lives at offset 0 (the visual bottom).
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated }));
  }, []);

  // Tapping a reply quote scrolls to (and briefly highlights) the original message.
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpToMessage = useCallback((id: string) => {
    const idx = invertedMessagesRef.current.findIndex((m) => m.id === id);
    if (idx < 0) return;
    try {
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
    } catch {
      /* onScrollToIndexFailed handles the unmeasured case */
    }
    setFlashMessageId(id);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashMessageId(null), 1400);
  }, []);

  const handleListScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      // Inverted list: contentOffset.y ~0 means pinned to the newest message.
      atBottomRef.current = e.nativeEvent.contentOffset.y < 120;
    },
    [],
  );

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
    enabled: Boolean(token) && (Boolean(newMode) || contactPickerOpen),
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
    select: stabilizeMessageAttachmentUrls,
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

  // Preload chat photos to a local disk cache (keyed by attachment id) as soon as
  // the messages are known, so they are instant on open and never re-downloaded
  // when the signed URL rotates. See CachedChatImage.
  useEffect(() => {
    const seen = new Set<string>();
    for (const m of messages.slice(-40)) {
      for (const a of m.attachments || []) {
        const url = a.downloadUrl;
        if (!url || seen.has(a.id)) continue;
        const isImage =
          a.mediaKind === 'image' || String(a.mimeType || '').toLowerCase().startsWith('image/');
        if (!isImage) continue;
        seen.add(a.id);
        const target = chatImageCachePath(a);
        FileSystem.getInfoAsync(target)
          .then((info) => (info.exists ? undefined : FileSystem.downloadAsync(url, target)))
          .catch(() => undefined);
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!activeThread || !token) return;
    markChatThreadRead(token, activeThread.id)
      .then(() => queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads }).catch(() => undefined))
      .catch(() => undefined);
  }, [activeThread?.id, queryClient, token]);

  useEffect(() => {
    setActiveThread((current) => current ? threads.find((t) => t.id === current.id) ?? current : null);
  }, [threads]);

  // Intercept Android hardware back when a thread is open so the user returns
  // to the thread list instead of being sent to the previous tab (Team).
  useEffect(() => {
    if (!activeThread) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMessageSearch('');
      setActiveThread(null);
      return true;
    });
    return () => sub.remove();
  }, [activeThread]);

  // Opening a thread always jumps to the newest message.
  useEffect(() => {
    if (activeThread) {
      atBottomRef.current = true;
      pendingInitialScrollRef.current = true;
      if (messages.length > 0) scrollToBottom(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id]);

  // New content (incoming message / background refetch): only follow to the
  // bottom when the user is already pinned there. The very first time a thread's
  // messages land we jump instantly (no animation) so the chat opens flat at the
  // bottom; only later live messages animate.
  useEffect(() => {
    if (!activeThread || messages.length === 0) return;
    if (pendingInitialScrollRef.current) {
      pendingInitialScrollRef.current = false;
      scrollToBottom(false);
    } else if (atBottomRef.current) {
      scrollToBottom(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // When the keyboard opens, snap to the latest message and never leave a
  // bubble hidden behind it. Also dismiss the emoji panel so the two never
  // fight for the same space.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, () => {
      setKeyboardOpen(true);
      // NOTE: do NOT close the emoji panel here — the panel has its own search
      // box that needs the keyboard. The panel is closed instead when the
      // message composer input gains focus (see Composer onInputFocus).
      atBottomRef.current = true;
      // Keep the newest message above the keyboard. Jump immediately and again
      // after the window has finished resizing (Android adjustResize / iOS
      // padding) so the last bubble is never left hidden behind the keyboard.
      scrollToBottom(false);
      setTimeout(() => scrollToBottom(false), 120);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardOpen(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [scrollToBottom]);

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

  // Pull-to-refresh spinner is shown ONLY for a user-initiated pull. Background
  // polling (refetchInterval) must stay invisible — never flash the wheel.
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const refreshChat = useCallback(() => {
    setManualRefreshing(true);
    Promise.all([
      threadsQuery.refetch().catch(() => undefined),
      activeThread ? messagesQuery.refetch().catch(() => undefined) : Promise.resolve(),
    ]).finally(() => setManualRefreshing(false));
  }, [activeThread, messagesQuery, threadsQuery]);

  const openThreadById = useCallback(async (threadId: string) => {
    if (!token) return;
    // Cache-first (2026-07-30, swipe-to-message lag): if the thread is already
    // in the cached list, open it INSTANTLY and refresh the list in the
    // background. The old path awaited an invalidate plus a full re-download
    // of the thread list before the chat could appear — that round-trip was
    // the visible "takes a while to open the chat" stall.
    const cachedThreads =
      (queryClient.getQueryData(mobileQueryKeys.chatThreads) as ChatThread[] | undefined) ?? [];
    const cachedHit = cachedThreads.find((t) => t.id === threadId);
    if (cachedHit) {
      setActiveThread(cachedHit);
      getChatThreads(token)
        .then((next) => {
          queryClient.setQueryData(mobileQueryKeys.chatThreads, next);
          const fresh = next.find((t) => t.id === threadId);
          if (fresh) {
            setActiveThread((prev) => (prev && prev.id === threadId ? fresh : prev));
          }
        })
        .catch(() => undefined);
      return;
    }
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

  // Deep-link from elsewhere in the app (Team / Contacts / Recent / Voicemail
  // "Message" buttons) to open a chat with a given number/extension. Resolution:
  //   • internal extension (kind 'internal', or a 2–6 digit number that maps to
  //     a directory user) → opens a DM with that user.
  //   • anything else → opens an SMS thread keyed on the number.
  // Reuses the same create-or-reuse endpoint as the New Chat sheet, so an
  // existing thread is returned instead of duplicated.
  const composeWithNumber = useCallback(
    async (rawNumber: string, kind?: 'internal' | 'external') => {
      if (!token) return;
      const number = rawNumber.trim();
      if (!number) {
        showToast('No number is available for this contact.');
        return;
      }
      const digits = number.replace(/\D/g, '');
      const looksInternal = kind === 'internal' || (kind !== 'external' && /^\d{2,6}$/.test(number));

      // Instant-open fast path (2026-07-30, swipe-to-message lag): before any
      // network work, look for the target thread in the cached list — a DM
      // whose peer extension matches, or an SMS thread on the same number
      // (last-10-digit match tolerates +1/formatting differences). A hit opens
      // the chat with ZERO round-trips. Misses fall through to the original
      // directory-resolve + create-or-reuse path, which dedupes server-side,
      // so behavior is unchanged for never-seen threads.
      const cachedThreads =
        (queryClient.getQueryData(mobileQueryKeys.chatThreads) as ChatThread[] | undefined) ?? [];
      const sameExternalNumber = (a: string, b: string) => {
        const da = (a || '').replace(/\D/g, '');
        const db = (b || '').replace(/\D/g, '');
        if (!da || !db) return false;
        if (da === db) return true;
        return da.length >= 10 && db.length >= 10 && da.slice(-10) === db.slice(-10);
      };
      const cachedHit = looksInternal
        ? cachedThreads.find(
            (t) => t.type === 'DM' && (t.participantExtension || '').replace(/\D/g, '') === digits && digits.length > 0,
          )
        : cachedThreads.find(
            (t) => t.type === 'SMS' && sameExternalNumber(t.externalSmsE164 || '', number),
          );
      if (cachedHit) {
        setActiveThread(cachedHit);
        return;
      }

      try {
        let peerUserId: string | null = null;
        if (looksInternal) {
          const dir = await getChatDirectoryFull(token).catch(() => null);
          const ext = (dir?.extensions ?? []).find((e) => String(e.extNumber) === digits);
          if (ext?.ownerUserId) {
            // Messaging your own extension is a no-op DM-with-yourself — guard
            // it with a clear message instead of opening an empty self-thread.
            const me = (dir?.users ?? []).find((u) => u.self);
            if (me && ext.ownerUserId === me.id) {
              showToast("That's your own extension — you can't message yourself.");
              return;
            }
            peerUserId = ext.ownerUserId;
          }
          // An explicitly-internal caller with no linked chat user can't be a
          // DM and must NOT fall through to SMS (that would fail with an
          // INVALID_PHONE on an extension number). Tell the user plainly.
          if (!peerUserId && kind === 'internal') {
            showToast(`No chat user is linked to extension ${digits}.`);
            return;
          }
        }
        const res = peerUserId
          ? await createChatThread(token, { type: 'dm', peerUserId })
          : await createChatThread(token, { type: 'sms', externalPhone: number });
        await openThreadById(res.threadId);
      } catch (err: any) {
        showToast(friendlyComposeError(err?.message));
      }
    },
    [openThreadById, queryClient, showToast, token],
  );

  useEffect(() => {
    const composeNumber = String(route.params?.composeNumber || '');
    if (!composeNumber || !token) return;
    const composeKind = route.params?.composeKind;
    nav.setParams?.({ composeNumber: undefined, composeName: undefined, composeKind: undefined });
    composeWithNumber(composeNumber, composeKind).catch(() => undefined);
  }, [nav, composeWithNumber, route.params?.composeNumber, route.params?.composeKind, token]);

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
    const smsCompress = activeThread?.type === 'SMS';
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      quality: smsCompress ? 0.48 : 0.86,
    });
    if (res.canceled) return;
    for (const asset of res.assets.slice(0, 3 - pendingAttachments.length)) {
      await uploadLocalFile({
        uri: asset.uri,
        name: asset.fileName || fileNameFromUri(asset.uri, asset.type === 'video' ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
        type: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
      }).catch((err) => showToast(err?.message || 'Upload failed.'));
    }
  }, [activeThread?.type, pendingAttachments.length, showToast, uploadLocalFile]);

  const captureCamera = useCallback(async (video = false) => {
    setAttachOpen(false);
    await ImagePicker.requestCameraPermissionsAsync();
    const smsCompress = activeThread?.type === 'SMS';
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: video ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images,
      quality: video ? 0.86 : smsCompress ? 0.48 : 0.86,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    await uploadLocalFile({
      uri: asset.uri,
      name: asset.fileName || fileNameFromUri(asset.uri, video ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
      type: asset.mimeType || (video ? 'video/mp4' : 'image/jpeg'),
    }).catch((err) => showToast(err?.message || 'Upload failed.'));
  }, [activeThread?.type, showToast, uploadLocalFile]);

  const sendPreparedMessage = useCallback(async (options?: { body?: string; type?: Exclude<ChatMessageType, 'SYSTEM'>; location?: ChatLocation; attachments?: PendingChatAttachment[]; retryId?: string }) => {
    if (!token || !activeThread) return;
    const body = options?.body ?? draft.trim();
    const attachments = options?.attachments ?? pendingAttachments;
    const type = (options?.type || (attachments[0] ? fileKind(attachments[0].mimeType) : 'TEXT')) as Exclude<ChatMessageType, 'SYSTEM'>;
    if (!body && attachments.length === 0 && !options?.location) return;
    const reply = replyingTo;
    const localId = options?.retryId || `local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
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
        mediaKind: a.mediaKind ?? null,
        durationMs: a.durationMs ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
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
      const realId = sent.messageId;
      if (realId) {
        // Promote the optimistic bubble to the confirmed server id and keep
        // it on screen. The merge in `messages` dedupes it the moment the
        // background refetch returns the same id, so the bubble never blinks
        // out-and-back (the previous filter-then-refetch caused a flash).
        setLocalMessages((current) =>
          current.map((m) =>
            m.id === localId
              ? { ...m, id: realId, clientStatus: undefined, deliveryStatus: sent.deliveryStatus ?? m.deliveryStatus }
              : m,
          ),
        );
        void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatMessages(activeThread.id) });
      } else {
        // No server id to dedupe against — wait for the refetch to land the
        // real message, *then* drop the optimistic so it never disappears
        // (no gap) and never duplicates.
        await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatMessages(activeThread.id) });
        setLocalMessages((current) => current.filter((m) => m.id !== localId));
      }
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads });
      setMediaLinkError(false);
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg === 'MEDIA_LINK_BASE_UNAVAILABLE') {
        setMediaLinkError(true);
        setLocalMessages((current) => current.filter((m) => m.id !== localId));
        showToast('Cannot send media over SMS.');
      } else {
        setLocalMessages((current) => current.map((m) => m.id === localId ? { ...m, clientStatus: 'failed', deliveryError: msg || 'Send failed' } : m));
        showToast(msg || 'Message failed. Tap retry.');
      }
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

  const send = useCallback(() => {
    // Sending always snaps back to the newest message.
    atBottomRef.current = true;
    scrollToBottom(true);
    void sendPreparedMessage();
  }, [scrollToBottom, sendPreparedMessage]);

  const startRecording = useCallback(async () => {
    if (!activeThread || !token || recording) return;
    // Connect "recording armed" cue. Played on press — before the recorder
    // actually starts a few ms later — so it gives instant feedback and is not
    // captured into the voice note itself.
    playVoiceNoteStartTone();
    // Guard against a silently-stalled audio session: if any step hangs
    // (e.g. WebRTC/SIP still owns the mic), reject instead of hanging forever.
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out: ${label} (${ms}ms)`)), ms),
        ),
      ]);
    let rec: Audio.Recording | null = null;
    try {
      console.log('[VOICE_NOTE] startRecording: begin');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

      console.log('[VOICE_NOTE] requesting permission');
      const perm = await withTimeout(Audio.requestPermissionsAsync(), 8000, 'requestPermissions');
      console.log('[VOICE_NOTE] permission granted=', perm.granted);
      if (!perm.granted) {
        showAppAlert('Microphone needed', 'Please allow microphone access to record a voice note.');
        return;
      }

      console.log('[VOICE_NOTE] setAudioMode');
      await withTimeout(
        Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        }),
        8000,
        'setAudioMode',
      );

      console.log('[VOICE_NOTE] prepare');
      rec = new Audio.Recording();
      await withTimeout(
        rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY),
        8000,
        'prepareToRecord',
      );

      console.log('[VOICE_NOTE] start');
      await withTimeout(rec.startAsync(), 8000, 'startAsync');

      recordingRef.current = rec;
      setRecording(true);
      console.log('[VOICE_NOTE] recording started OK');
    } catch (err: any) {
      console.log('[VOICE_NOTE] FAILED:', err?.message || String(err));
      setRecording(false);
      // Best-effort cleanup of a half-initialised recorder so the next
      // attempt isn't blocked by a lingering native session.
      if (rec) {
        try {
          await rec.stopAndUnloadAsync();
        } catch {
          /* ignore — may never have started */
        }
      }
      recordingRef.current = null;
      showAppAlert('Could not start recording', err?.message || 'Please try again.');
    }
  }, [activeThread, recording, token]);

  // Send a finished voice note. Shows the bubble *immediately* using the
  // local file, then uploads + sends in the background and promotes the
  // optimistic bubble to the real server id so the refetch dedupes it in
  // place — no "dead second" with nothing on screen and no flash.
  const commitVoiceNote = useCallback(
    async (localUri: string, durationMs?: number) => {
      if (!token || !activeThread) return;
      const threadId = activeThread.id;
      const localId = `local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `voice-note-${Date.now()}.m4a`;
      const optimistic: ChatMessage = {
        id: localId,
        threadId,
        senderId: 'me',
        senderName: 'You',
        body: '',
        sentAt: new Date().toISOString(),
        mine: true,
        type: 'VOICE_NOTE',
        clientStatus: 'sending',
        replyTo: null,
        attachments: [
          {
            id: `${localId}:att:0`,
            fileName,
            mimeType: 'audio/mp4',
            sizeBytes: 0,
            downloadUrl: localUri,
            mediaKind: 'audio',
            durationMs: durationMs ?? null,
            width: null,
            height: null,
          },
        ],
        location: null,
      };
      setLocalMessages((current) => [...current, optimistic]);
      scrollToBottom(true);
      try {
        const uploaded = await uploadChatAttachment(token, threadId, {
          uri: localUri,
          name: fileName,
          type: 'audio/mp4',
        });
        const enriched: PendingChatAttachment = {
          ...uploaded,
          mediaKind: uploaded.mediaKind ?? 'audio',
          durationMs: uploaded.durationMs ?? durationMs ?? null,
        };
        const sent = await sendChatMessage(token, threadId, {
          body: '',
          type: 'VOICE_NOTE',
          attachments: [enriched],
        });
        const realId = sent.messageId;
        if (realId) {
          setLocalMessages((current) =>
            current.map((m) =>
              m.id === localId
                ? { ...m, id: realId, clientStatus: undefined, deliveryStatus: sent.deliveryStatus ?? m.deliveryStatus }
                : m,
            ),
          );
          void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatMessages(threadId) });
        } else {
          await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatMessages(threadId) });
          setLocalMessages((current) => current.filter((m) => m.id !== localId));
        }
        void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads });
      } catch (err: any) {
        const msg = String(err?.message || '');
        if (msg === 'MEDIA_LINK_BASE_UNAVAILABLE') {
          setLocalMessages((current) => current.filter((m) => m.id !== localId));
          showToast('Cannot send media over SMS.');
        } else {
          setLocalMessages((current) =>
            current.map((m) =>
              m.id === localId ? { ...m, clientStatus: 'failed', deliveryError: msg || 'Send failed' } : m,
            ),
          );
          showToast(msg || 'Could not send voice note.');
        }
      }
    },
    [activeThread, queryClient, scrollToBottom, showToast, token],
  );

  const stopRecording = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    setRecording(false);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    try {
      // Capture the duration *before* stopAndUnloadAsync — once the
      // recorder is unloaded its status no longer reports a duration.
      let durationMs: number | undefined;
      try {
        const status = await rec.getStatusAsync();
        if (status?.isRecording || status?.isDoneRecording !== undefined) {
          const ms = Number((status as any)?.durationMillis);
          if (Number.isFinite(ms) && ms > 0) durationMs = Math.round(ms);
        }
      } catch {
        /* non-fatal — read it back from the finished file below */
      }
      await rec.stopAndUnloadAsync();
      // Hand the audio session back to playback (loudspeaker) so the voice
      // note we just recorded doesn't play out of the earpiece.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      }).catch(() => undefined);
      // On some devices (e.g. the Oplus AudioRecord retry path) the live
      // recorder status reports no duration even though the saved file is
      // fine. Read the true duration straight from the finished file so the
      // voice note never shows "0:00".
      if (durationMs === undefined) {
        const finishedUri = rec.getURI();
        if (finishedUri) {
          try {
            const { sound, status } = await Audio.Sound.createAsync(
              { uri: finishedUri },
              { shouldPlay: false },
            );
            const ms = Number((status as any)?.durationMillis);
            if (Number.isFinite(ms) && ms > 0) durationMs = Math.round(ms);
            await sound.unloadAsync().catch(() => undefined);
          } catch {
            /* non-fatal — server-side ffprobe will fill in durationMs */
          }
        }
      }
      // Discard ultra-short taps (under 600ms) — almost certainly an
      // accidental press, not a voice note.
      if (durationMs !== undefined && durationMs < 600) {
        const uri = rec.getURI();
        if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
        return;
      }
      const uri = rec.getURI();
      if (!uri) return;
      // Connect "message away" cue on release (only for a real, sent note —
      // after the <600ms accidental-tap guard above). Audio mode was reset to
      // playback just above, so this plays out of the loudspeaker.
      playVoiceNoteSentTone();
      // Fire-and-forget: shows the bubble instantly and uploads in the
      // background so releasing the mic feels immediate.
      void commitVoiceNote(uri, durationMs);
    } catch (err: any) {
      showToast(err?.message || 'Could not send voice note.');
    }
  }, [commitVoiceNote, showToast]);

  const cancelRecording = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec) {
      setRecording(false);
      return;
    }
    recordingRef.current = null;
    setRecording(false);
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    } catch {
      /* recorder already torn down */
    }
    // Restore loudspeaker playback routing after the record session.
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    }).catch(() => undefined);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, []);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (!token || !activeThread || activeThread.type !== 'DM') return;
    setChatTyping(token, activeThread.id, true).catch(() => undefined);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => setChatTyping(token, activeThread.id, false).catch(() => undefined), 1800);
  }, [activeThread, token]);

  // Stable handlers so the (memoized) emoji panel never re-renders when `draft`
  // changes — that re-render was what made emoji insertion feel laggy.
  const handleEmojiPick = useCallback((emoji: string) => {
    setDraft((current) => `${current}${emoji}`);
  }, []);
  const closeEmojiPanel = useCallback(() => setEmojiOpen(false), []);
  const focusClosesEmoji = useCallback(() => setEmojiOpen(false), []);

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
    showAppAlert(
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

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (!token || !activeThread) return;
      const localFiles = (message.attachments || [])
        .map((a) => {
          const u = a.downloadUrl || '';
          const isLocal =
            u.startsWith('file:') ||
            u.startsWith('content:') ||
            u.startsWith('ph://') ||
            u.startsWith('ph:') ||
            u.startsWith('asset:');
          if (!isLocal) return null;
          return {
            uri: u,
            name: a.fileName,
            type: a.mimeType || guessMimeFromUri(u, 'image/jpeg'),
          };
        })
        .filter(Boolean) as { uri: string; name: string; type: string }[];

      if (!localFiles.length) {
        showToast('Pick the photo again — retry uses your original file from this device.');
        return;
      }

      let uploaded: PendingChatAttachment[] = [];
      try {
        for (const file of localFiles) {
          uploaded.push(await uploadChatAttachment(token, activeThread.id, file));
        }
      } catch (err: any) {
        showToast(err?.message || 'Upload failed.');
        return;
      }

      await sendPreparedMessage({
        body: message.body,
        type: message.type === 'SYSTEM' ? 'TEXT' : message.type,
        attachments: uploaded,
        retryId: message.id,
      });
    },
    [activeThread, sendPreparedMessage, showToast, token],
  );

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

  // The message list renders INVERTED (newest at offset 0 == the visual bottom).
  // That makes a chat always open flat at the latest message with zero scroll
  // timing, and keeps the newest bubble pinned above the keyboard. The data must
  // therefore be newest-first.
  const invertedMessages = useMemo(() => displayedMessages.slice().reverse(), [displayedMessages]);
  invertedMessagesRef.current = invertedMessages;
  // id → message lookup so a reply bubble can resolve the original it quotes.
  const messageById = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of displayedMessages) map.set(m.id, m);
    return map;
  }, [displayedMessages]);

  // Ordered list of every voice note in the thread (oldest → newest). Drives the
  // shared player's auto-advance: when one note ends, the next in this list plays.
  const voiceNoteOrder = useMemo(() => {
    const out: { id: string; url: string }[] = [];
    for (const message of messages) {
      const attachments = message.attachments || [];
      const mmsSource =
        attachments.length > 0
          ? []
          : (message.mmsUrls || []).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
      const mmsDerived = mmsSource.map((url, index) => mmsUrlToAttachment(url, message.id, index));
      const combined = dropVoiceTransportDuplicates([...attachments, ...mmsDerived].filter((a) => Boolean(a.downloadUrl)));
      for (const a of combined) {
        if (isAudioAttachment(a, message.type) && a.downloadUrl) out.push({ id: a.id, url: a.downloadUrl });
      }
    }
    return out;
  }, [messages]);
  const voiceNotePlayer = useVoiceNotePlayerController(voiceNoteOrder);

  // Stable renderItem so typing/emoji insertion (which only changes `draft`)
  // never forces the message list to re-render its visible bubbles.
  const renderMessageItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      // Inverted data: the bubble visually ABOVE this one is the older message,
      // which sits at index + 1 in the reversed array.
      const prev = invertedMessages[index + 1];
      const grouped = Boolean(prev && prev.senderId === item.senderId && prev.mine === item.mine);
      // Resolve the replied-to message (usually still loaded in this thread) so
      // the quote can show a media thumbnail / voice-note duration, not just text.
      const replySource = item.replyTo ? messageById.get(item.replyTo.id) : null;
      const replyPreview = replySource ? describeReplyTarget(replySource) : null;
      return (
        <MessageBubble
          message={item}
          grouped={grouped}
          search={messageSearch.trim()}
          replyPreview={replyPreview}
          flashing={flashMessageId === item.id}
          onJumpToReply={jumpToMessage}
          onOpenMedia={setMediaPreview}
          onAction={() => setSelectedMessage(item)}
          onReply={() => setReplyingTo(item)}
          onRemoveReaction={(emoji) => removeReaction(item, emoji)}
          onRetry={() => retryMessage(item)}
        />
      );
    },
    [invertedMessages, messageById, messageSearch, removeReaction, retryMessage, flashMessageId, jumpToMessage],
  );

  return (
    <VoiceNotePlayerContext.Provider value={voiceNotePlayer}>
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
              // iOS needs the list to be able to bounce for pull-to-refresh to fire;
              // Android's RefreshControl works without it. Gate on iOS so Android is
              // byte-for-byte unchanged (see IOS_WORK_ANDROID_GUARDRAILS.md).
              bounces={Platform.OS === 'ios'}
              alwaysBounceVertical={Platform.OS === 'ios'}
              overScrollMode="never"
              initialNumToRender={10}
              maxToRenderPerBatch={8}
              updateCellsBatchingPeriod={60}
              windowSize={5}
              removeClippedSubviews
              refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={refreshChat} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />}
              contentContainerStyle={styles.threadList}
              renderItem={renderThreadItem}
            />
          )}

          <AppActionSheet
            visible={Boolean(threadPendingDelete)}
            title={threadPendingDelete ? displayThreadName(threadPendingDelete) : ''}
            message="Delete this conversation from your list? The other side keeps their copy, and a new message will bring it back."
            onClose={() => setThreadPendingDelete(null)}
            actions={[
              ...(threadPendingDelete?.type === 'SMS' && threadPendingDelete.externalSmsE164
                ? [{
                    label: 'Add to contacts',
                    icon: 'person-add-outline' as const,
                    onPress: () => {
                      const t = threadPendingDelete;
                      setThreadPendingDelete(null);
                      if (t?.externalSmsE164) setAddContactPrefill({ phone: t.externalSmsE164 });
                    },
                  }]
                : []),
              {
                label: 'Delete conversation',
                icon: 'trash-outline',
                destructive: true,
                onPress: () => {
                  const t = threadPendingDelete;
                  setThreadPendingDelete(null);
                  if (!t || !token) return;
                  // Optimistic removal; server archive follows. Restore via
                  // refetch on failure.
                  queryClient.setQueryData(mobileQueryKeys.chatThreads, (prev: unknown) =>
                    Array.isArray(prev) ? prev.filter((th: ChatThread) => th.id !== t.id) : prev,
                  );
                  archiveChatThread(token, t.id).catch(() => {
                    showAppAlert('Delete failed', 'Could not delete the conversation. Pull to refresh.');
                    queryClient.invalidateQueries({ queryKey: mobileQueryKeys.chatThreads }).catch(() => undefined);
                  });
                },
              },
            ]}
          />

          <AddContactModal
            visible={Boolean(addContactPrefill)}
            prefill={addContactPrefill ?? undefined}
            title="Add to Contacts"
            onClose={() => setAddContactPrefill(null)}
            onCreated={handleContactCreated}
          />
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
            <Avatar name={resolveContactName(activeThread.externalSmsE164) || displayThreadName(activeThread)} size="md" online={activeThread.type === 'DM'} />
            <View style={styles.chatHeaderInfo}>
              <Text style={[styles.chatTitle, { color: colors.text }]} numberOfLines={1}>
                {resolveContactName(activeThread.externalSmsE164) || displayThreadName(activeThread)}
              </Text>
              <Text style={[styles.chatSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                {typingUsers.length
                  ? `${typingUsers[0].name} is typing...`
                  : (() => {
                      // No duplicate info (Izzy 2026-07-28): when the title IS
                      // the number (no contact name), the subtitle shows just
                      // the kind — never "SMS · <same number>" twice. With a
                      // resolved contact name as title, the number is useful
                      // context and comes back.
                      const target = threadTarget(activeThread);
                      const effectiveTitle = resolveContactName(activeThread.externalSmsE164) || displayThreadName(activeThread);
                      const titleIsTarget = target && effectiveTitle === target;
                      return `${threadKind(activeThread)}${target && !titleIsTarget ? ` · ${target}` : ''}`;
                    })()}
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
              data={invertedMessages}
              inverted
              keyExtractor={(item) => item.id}
              bounces={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
              contentContainerStyle={styles.messageList}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              onScroll={handleListScroll}
              scrollEventThrottle={64}
              initialNumToRender={18}
              maxToRenderPerBatch={12}
              windowSize={9}
              removeClippedSubviews={false}
              renderItem={renderMessageItem}
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: true });
                setTimeout(() => {
                  try {
                    listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
                  } catch {
                    /* give up silently if still unmeasured */
                  }
                }, 320);
              }}
            />
          )}
          {mediaLinkError && activeThread?.type === 'SMS' ? (
            <View style={[styles.inThreadSearch, { backgroundColor: colors.dangerMuted, borderColor: colors.danger }]}> 
              <Ionicons name="alert-circle" size={16} color={colors.danger} />
              <Text style={[styles.searchInput, { color: colors.dangerText }]} numberOfLines={2}>Cannot send media over SMS. Ask admin to set PUBLIC_API_BASE_URL.</Text>
            </View>
          ) : null}
          <Composer
            draft={draft}
            onDraft={handleDraftChange}
            pending={pendingAttachments}
            onRemovePending={(index) => setPendingAttachments((current) => current.filter((_, i) => i !== index))}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            onAttach={() => setAttachOpen(true)}
            onCamera={() => captureCamera(false)}
            onEmoji={() => {
              // Open the picker over the keyboard's space: dismiss the keyboard
              // first so all 1,000 emojis are visible instead of being hidden
              // behind it. Toggling closed just hides the panel.
              setEmojiOpen((open) => {
                if (!open) Keyboard.dismiss();
                return !open;
              });
            }}
            onInputFocus={focusClosesEmoji}
            onSend={send}
            onRecordStart={startRecording}
            onRecordEnd={stopRecording}
            onRecordCancel={cancelRecording}
            recording={recording}
            compact={keyboardOpen}
            bottomInset={Platform.OS === 'ios' ? (keyboardOpen ? 10 : 12) : Math.max(insets.bottom, 10)}
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
        onContact={() => {
          setAttachOpen(false);
          setContactPickerOpen(true);
        }}
      />
      <ContactPicker
        visible={contactPickerOpen}
        users={(directoryQuery.data?.users ?? []).filter((u) => !u.self)}
        loading={directoryQuery.isLoading}
        onClose={() => setContactPickerOpen(false)}
        onPick={(user) => {
          // Build a tiny vCard-style snippet that survives both DM rendering
          // and SMS character encoding. The recipient can copy/paste into
          // their own contacts app — no native Contacts permission needed.
          const lines = [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${user.name || user.email}`,
            user.email ? `EMAIL:${user.email}` : null,
            user.extensionNumber ? `TEL;TYPE=WORK,VOICE:Ext ${user.extensionNumber}` : null,
            'END:VCARD',
          ].filter(Boolean).join('\n');
          setDraft((current) => current ? `${current}\n${lines}` : lines);
          setContactPickerOpen(false);
        }}
      />
      <EmojiPanel visible={emojiOpen} onPick={handleEmojiPick} onClose={closeEmojiPanel} />
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
    </VoiceNotePlayerContext.Provider>
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
      style={[styles.filterChip, teamFilterChipColors(active, colors.primary, colors)]}
    >
      <Text style={[styles.filterText, { color: active ? colors.primary : colors.textSecondary }]}>{label}</Text>
      {count > 0 ? (
        <View style={[styles.countBadge, { backgroundColor: active ? `${colors.primary}26` : colors.surfaceElevated }]}>
          <Text style={[styles.countText, { color: active ? colors.primary : colors.textTertiary }]}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

const ThreadRow = memo(function ThreadRow({ thread, onPress, onLongPress, nameOverride }: { thread: ChatThread; onPress: () => void; onLongPress?: () => void; nameOverride?: string | null }) {
  const { colors } = useTheme();
  const name = nameOverride || displayThreadName(thread);
  const kind = threadKind(thread);
  return (
    <TouchableOpacity style={[styles.threadRow, { backgroundColor: colors.bg, borderBottomColor: colors.borderSubtle }]} onPress={onPress} onLongPress={onLongPress} delayLongPress={350} activeOpacity={0.82}>
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
  replyPreview,
  onJumpToReply,
  flashing,
}: {
  message: ChatMessage;
  grouped: boolean;
  search: string;
  onAction: () => void;
  onReply: () => void;
  onOpenMedia: (preview: MediaPreview) => void;
  onRemoveReaction: (emoji: string) => void;
  onRetry: () => void;
  replyPreview?: ReplyPreviewMeta | null;
  onJumpToReply?: (id: string) => void;
  flashing?: boolean;
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
  const attachments = message.attachments || [];
  const mmsSource =
    attachments.length > 0
      ? []
      : (message.mmsUrls || []).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
  const mmsDerived = mmsSource.map((url, index) => mmsUrlToAttachment(url, message.id, index));
  const combined = dropVoiceTransportDuplicates([...attachments, ...mmsDerived].filter((a) => Boolean(a.downloadUrl)));
  const audioAttachments = combined.filter((attachment) => isAudioAttachment(attachment, message.type));
  const audioIds = new Set(audioAttachments.map((a) => a.id));
  const imageAttachments = combined.filter(
    (attachment) => isImageAttachment(attachment, message.type) && !audioIds.has(attachment.id),
  );
  const imageIds = new Set(imageAttachments.map((a) => a.id));
  const videoAttachments = combined.filter(
    (attachment) => !audioIds.has(attachment.id) && !imageIds.has(attachment.id) && isVideoAttachment(attachment, message.type),
  );
  const videoIds = new Set(videoAttachments.map((a) => a.id));
  const otherAttachments = combined.filter(
    (attachment) => !audioIds.has(attachment.id) && !imageIds.has(attachment.id) && !videoIds.has(attachment.id),
  );
  const renderedImages = imageAttachments;
  const hasVisualMedia = renderedImages.length > 0 || videoAttachments.length > 0;
  const visibleBody = bodyWithoutMediaLinks(message.body || '', hasVisualMedia || audioAttachments.length > 0 || otherAttachments.length > 0);
  const mediaOnly = !deleted && !visibleBody && !message.location && (hasVisualMedia || audioAttachments.length > 0) && otherAttachments.length === 0;
  return (
    <Animated.View style={[styles.messageRow, message.mine ? styles.messageRowMine : styles.messageRowTheirs, grouped ? styles.messageGrouped : null, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
      <View style={styles.messageStack}>
        <TouchableOpacity activeOpacity={0.86} onPress={onAction} onLongPress={onAction} style={[mediaOnly ? [styles.bubbleMediaOnly, message.mine ? styles.bubbleMine : styles.bubbleTheirs] : bubbleStyle, flashing ? { borderColor: colors.primary, borderWidth: 2 } : null]}>
          {!message.mine && !grouped ? <Text style={[styles.senderName, { color: colors.teal }]}>{prettyContactLabel(message.senderName)}</Text> : null}
          {message.replyTo ? (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => message.replyTo && onJumpToReply?.(message.replyTo.id)}
              onLongPress={onAction}
              delayLongPress={280}
              style={[styles.replyInline, { backgroundColor: message.mine ? 'rgba(255,255,255,0.16)' : colors.bgSecondary }]}
            >
              <Ionicons name="return-up-back-outline" size={12} color={message.mine ? '#fff' : colors.primary} />
              {replyPreview?.thumbUri ? (
                <View style={styles.replyInlineThumbWrap}>
                  {replyPreview.thumbIsVideo ? (
                    <Video source={{ uri: replyPreview.thumbUri }} style={styles.replyInlineThumb} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted positionMillis={1} useNativeControls={false} />
                  ) : (
                    <Image source={{ uri: replyPreview.thumbUri }} style={styles.replyInlineThumb} />
                  )}
                  {replyPreview.thumbIsVideo ? (
                    <View style={styles.replyInlineThumbPlay}><Ionicons name="play" size={7} color="#fff" style={{ marginLeft: 1 }} /></View>
                  ) : null}
                </View>
              ) : null}
              <Text style={[styles.replyInlineText, { color: message.mine ? '#eaf2ff' : colors.textSecondary }]} numberOfLines={1}>
                {prettyContactLabel(message.replyTo.senderName)}: {replyPreview?.label || message.replyTo.body || friendlyTypeLabel(message.replyTo.type)}{replyPreview?.duration ? ` · ${replyPreview.duration}` : ''}
              </Text>
            </TouchableOpacity>
          ) : null}
          {deleted ? (
            <Text style={[styles.messageText, { color: textColor, fontStyle: 'italic', opacity: 0.75 }]}>This message was deleted</Text>
          ) : (
            <>
              {visibleBody ? <Text style={[styles.messageText, { color: textColor }]}>{visibleBody}</Text> : null}
              {message.location ? (
                <TouchableOpacity
                  style={[styles.locationCard, { backgroundColor: message.mine ? 'rgba(255,255,255,0.16)' : colors.bgSecondary }]}
                  onPress={() => onOpenMedia({ type: 'location', title: message.location?.label || 'Shared location', subtitle: `${message.location?.lat.toFixed(5)}, ${message.location?.lng.toFixed(5)}`, location: message.location || undefined })}
                >
                  <Ionicons name="location" size={18} color={message.mine ? '#fff' : colors.primary} />
                  <Text style={[styles.locationText, { color: textColor }]}>Shared location</Text>
                </TouchableOpacity>
              ) : null}
              {renderedImages.length ? (
                <ImageGrid
                  attachments={renderedImages}
                  mine={message.mine}
                  failed={message.clientStatus === 'failed' || String(message.deliveryStatus || '').toLowerCase() === 'failed'}
                  sending={message.clientStatus === 'sending' || String(message.deliveryStatus || '').toLowerCase() === 'queued'}
                  onOpen={(attachment) => onOpenMedia({ type: 'image', url: attachment.downloadUrl, title: attachment.fileName || 'Image', subtitle: attachment.mimeType })}
                  onLongPress={onAction}
                  onRetry={onRetry}
                />
              ) : null}
              {videoAttachments.map((attachment) => (
                <VideoThumb
                  key={attachment.id}
                  attachment={attachment}
                  failed={message.clientStatus === 'failed' || String(message.deliveryStatus || '').toLowerCase() === 'failed'}
                  sending={message.clientStatus === 'sending' || String(message.deliveryStatus || '').toLowerCase() === 'queued'}
                  onOpen={() => onOpenMedia({ type: 'video', url: attachment.downloadUrl, title: attachment.fileName || 'Video', subtitle: attachment.mimeType })}
                  onLongPress={onAction}
                  onRetry={onRetry}
                />
              ))}
              {audioAttachments.map((attachment) => (
                <VoiceNoteBubble key={attachment.id} attachment={attachment} mine={message.mine} failed={message.clientStatus === 'failed'} onRetry={onRetry} />
              ))}
              {otherAttachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  messageType={message.type}
                  mine={message.mine}
                  onPress={() =>
                    onOpenMedia({
                      type: attachmentPreviewType(attachment, message.type),
                      url: attachment.downloadUrl,
                      title: attachment.fileName,
                      subtitle: attachment.mimeType,
                    })
                  }
                />
              ))}
            </>
          )}
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
        {/* Timestamp + delivery status live OUTSIDE the bubble, on the chat background. */}
        <View style={[styles.metaOutside, message.mine ? styles.metaOutsideMine : styles.metaOutsideTheirs]}>
          <Text style={[styles.timeText, { color: colors.textTertiary }]}>{formatMessageTime(message.sentAt)}</Text>
          {message.mine ? <Ionicons name={statusIcon(message.deliveryStatus, message.clientStatus)} size={11} color={message.clientStatus === 'failed' ? colors.danger : colors.textTertiary} /> : null}
          {message.mine ? <Text style={[styles.statusTiny, { color: colors.textTertiary }]}>{statusLabel(message.deliveryStatus, message.clientStatus)}</Text> : null}
          {message.clientStatus === 'failed' ? (
            <TouchableOpacity onPress={onRetry}>
              <Text style={[styles.retryText, { color: colors.danger }]}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
});

/** Local disk-cache path for a chat image, keyed by its attachment id so the
 *  changing signed URL (?exp&sig) never busts the cache. */
function chatImageCachePath(attachment: { id: string; mimeType?: string | null }): string {
  const mime = String(attachment.mimeType || '').toLowerCase();
  const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : '.jpg';
  const safe = String(attachment.id).replace(/[^a-zA-Z0-9]/g, '');
  return (FileSystem.cacheDirectory || '') + 'cc-chat-img-' + safe + ext;
}

/** Chat image that renders from a local disk cache (keyed by attachment id) so
 *  it is instant on every re-open regardless of signed-URL rotation. Falls back
 *  to the remote URL on the very first view while it caches in the background. */
function CachedChatImage({ attachment, style, resizeMode }: { attachment: ChatAttachment; style: any; resizeMode?: 'cover' | 'contain' }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const remote = attachment.downloadUrl || null;
    if (!remote) { setUri(null); return; }
    const target = chatImageCachePath(attachment);
    (async () => {
      try {
        const info = await FileSystem.getInfoAsync(target).catch(() => null);
        if (info && info.exists) { if (!cancelled) setUri(target); return; }
        if (!cancelled) setUri(remote); // show remote immediately on first view
        const dl = await FileSystem.downloadAsync(remote, target);
        if (!cancelled && dl?.uri) setUri(dl.uri);
      } catch {
        if (!cancelled) setUri(remote);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment.id, attachment.downloadUrl, attachment.mimeType]);
  if (!uri) return <View style={style} />;
  return <Image source={{ uri }} style={style} resizeMode={resizeMode} />;
}

function ImageGrid({
  attachments,
  mine,
  failed,
  sending,
  onOpen,
  onLongPress,
  onRetry,
}: {
  attachments: ChatAttachment[];
  mine: boolean;
  failed: boolean;
  sending: boolean;
  onOpen: (attachment: ChatAttachment) => void;
  onLongPress?: () => void;
  onRetry: () => void;
}) {
  const shown = attachments.slice(0, 4);
  if (!shown.length) return null;
  return (
    <View style={[styles.imageGrid, shown.length === 1 ? styles.imageGridSingle : null]}>
      {shown.map((attachment, index) => {
        const aspect = attachment.width && attachment.height ? Math.max(0.56, Math.min(1.8, attachment.width / attachment.height)) : 4 / 3;
        const isLargeThree = shown.length === 3 && index === 0;
        return (
          <TouchableOpacity
            key={attachment.id}
            activeOpacity={0.88}
            onPress={() => onOpen(attachment)}
            onLongPress={onLongPress}
            delayLongPress={280}
            style={[
              styles.imageCell,
              shown.length === 1 ? { width: CHAT_MEDIA_MAX_WIDTH, aspectRatio: aspect } : null,
              shown.length === 2 ? styles.imageCellHalf : null,
              shown.length === 3 ? (isLargeThree ? styles.imageCellThreeLarge : styles.imageCellThreeSmall) : null,
              shown.length >= 4 ? styles.imageCellHalf : null,
            ]}
          >
            <CachedChatImage attachment={attachment} style={styles.imageBubble} resizeMode="cover" />
            {attachments.length > 4 && index === 3 ? (
              <View style={styles.imageOverflow}>
                <Text style={styles.imageOverflowText}>+{attachments.length - 4}</Text>
              </View>
            ) : null}
            {sending || failed ? (
              <TouchableOpacity activeOpacity={failed ? 0.8 : 1} onPress={failed ? onRetry : undefined} style={styles.imageStateOverlay}>
                {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="alert-circle" size={22} color="#fff" />}
                <Text style={styles.imageStateText}>{sending ? 'Sending' : 'Retry'}</Text>
              </TouchableOpacity>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// Video attachments render like a photo: the first frame as a still poster
// (expo-av Video paused) with a centered play button, opening the full player
// on tap. Long-press bubbles up to the message reaction menu.
function VideoThumb({
  attachment,
  failed,
  sending,
  onOpen,
  onLongPress,
  onRetry,
}: {
  attachment: ChatAttachment;
  failed: boolean;
  sending: boolean;
  onOpen: () => void;
  onLongPress?: () => void;
  onRetry: () => void;
}) {
  const aspect =
    attachment.width && attachment.height
      ? Math.max(0.56, Math.min(1.8, attachment.width / attachment.height))
      : 4 / 3;
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onOpen}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={[styles.imageCell, { width: CHAT_MEDIA_MAX_WIDTH, aspectRatio: aspect }]}
    >
      {attachment.downloadUrl ? (
        <Video
          source={{ uri: attachment.downloadUrl }}
          style={styles.imageBubble}
          resizeMode={ResizeMode.COVER}
          shouldPlay={false}
          isMuted
          positionMillis={1}
          useNativeControls={false}
        />
      ) : (
        <View style={[styles.imageBubble, { backgroundColor: 'rgba(15,23,42,0.35)' }]} />
      )}
      {!sending && !failed ? (
        <View pointerEvents="none" style={styles.videoPlayOverlay}>
          <View style={styles.videoPlayButton}>
            <Ionicons name="play" size={26} color="#fff" style={{ marginLeft: 3 }} />
          </View>
        </View>
      ) : null}
      {sending || failed ? (
        <TouchableOpacity activeOpacity={failed ? 0.8 : 1} onPress={failed ? onRetry : undefined} style={styles.imageStateOverlay}>
          {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="alert-circle" size={22} color="#fff" />}
          <Text style={styles.imageStateText}>{sending ? 'Sending' : 'Retry'}</Text>
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );
}

// Incoming voice notes (e.g. MMS) often arrive without a stored duration, so
// the bubble would show "0:00". Read the real duration from the audio file
// once and cache it across renders/bubbles.
const voiceDurationCache = new Map<string, number>();

function useResolvedVoiceDuration(attachment: ChatAttachment, stored: number | null): number | null {
  const [resolved, setResolved] = useState<number | null>(
    () => (stored && stored > 0 ? stored : voiceDurationCache.get(attachment.id) ?? null),
  );
  useEffect(() => {
    if (stored && stored > 0) {
      setResolved(stored);
      return;
    }
    const cached = voiceDurationCache.get(attachment.id);
    if (cached) {
      setResolved(cached);
      return;
    }
    const url = attachment.downloadUrl;
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const { sound, status } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: false });
        const ms = Number((status as any)?.durationMillis);
        await sound.unloadAsync().catch(() => undefined);
        if (Number.isFinite(ms) && ms > 0) {
          const rounded = Math.round(ms);
          voiceDurationCache.set(attachment.id, rounded);
          if (!cancelled) setResolved(rounded);
        }
      } catch {
        /* ignore — leave duration unknown */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.downloadUrl, stored]);
  return resolved;
}

function VoiceNoteBubble({ attachment, mine, failed, onRetry }: { attachment: ChatAttachment; mine: boolean; failed: boolean; onRetry: () => void }) {
  const { colors } = useTheme();
  const player = useContext(VoiceNotePlayerContext);
  const isActive = player?.activeId === attachment.id;
  const playing = Boolean(isActive && player?.playing);
  const progress = isActive ? (player?.progress ?? 0) : 0;
  const resolvedDuration = useResolvedVoiceDuration(attachment, attachment.durationMs ?? null);
  const durationMs = isActive && player?.durationMs ? player.durationMs : (attachment.durationMs ?? resolvedDuration ?? null);

  const toggle = useCallback(() => {
    if (!attachment.downloadUrl) return;
    player?.toggle(attachment.id, attachment.downloadUrl);
  }, [attachment.downloadUrl, attachment.id, player]);

  // Tap anywhere on the progress track to scrub. If the note isn't the active
  // one yet, a tap just starts it playing.
  const trackWidthRef = useRef(0);
  const onScrub = useCallback((locationX: number) => {
    const w = trackWidthRef.current || 1;
    const f = Math.max(0, Math.min(1, locationX / w));
    if (isActive && player) player.seek(attachment.id, f);
    else if (attachment.downloadUrl) player?.toggle(attachment.id, attachment.downloadUrl);
  }, [attachment.downloadUrl, attachment.id, isActive, player]);

  return (
    <View style={[styles.voiceBubble, { backgroundColor: mine ? colors.primary : colors.surfaceElevated, borderColor: mine ? 'transparent' : colors.borderSubtle }]}>
      <TouchableOpacity onPress={toggle} style={[styles.voicePlay, { backgroundColor: mine ? 'rgba(255,255,255,0.22)' : colors.primaryMuted }]}>
        <Ionicons name={playing ? 'pause' : 'play'} size={18} color={mine ? '#fff' : colors.primary} />
      </TouchableOpacity>
      <View style={styles.voiceTrackWrap}>
        <TouchableOpacity
          activeOpacity={1}
          hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
          onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width; }}
          onPress={(e) => onScrub(e.nativeEvent.locationX)}
          style={[styles.voiceTrack, { backgroundColor: mine ? 'rgba(255,255,255,0.26)' : colors.border }]}
        >
          <View style={[styles.voiceTrackFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: mine ? '#fff' : colors.primary }]} />
        </TouchableOpacity>
        <Text style={[styles.voiceDuration, { color: mine ? 'rgba(255,255,255,0.78)' : colors.textTertiary }]}>{formatVoiceDuration(durationMs)}</Text>
      </View>
      {failed ? (
        <TouchableOpacity onPress={onRetry} style={styles.voiceRetry}>
          <Ionicons name="alert-circle" size={17} color={colors.danger} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function AttachmentChip({
  attachment,
  messageType,
  mine,
  onPress,
}: {
  attachment: ChatAttachment;
  messageType?: ChatMessageType;
  mine: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const showThumb = attachmentShowsImageThumb(attachment, messageType);
  return (
    <TouchableOpacity style={[styles.attachmentChip, { backgroundColor: mine ? 'rgba(255,255,255,0.16)' : colors.bgSecondary }]} onPress={onPress} activeOpacity={0.84}>
      {showThumb ? <Image source={{ uri: attachment.downloadUrl! }} style={styles.attachmentThumb} /> : <Ionicons name="document-attach-outline" size={18} color={mine ? '#fff' : colors.primary} />}
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
  onInputFocus,
  onSend,
  onRecordStart,
  onRecordEnd,
  onRecordCancel,
  recording,
  compact,
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
  onInputFocus: () => void;
  onSend: () => void;
  onRecordStart: () => void;
  onRecordEnd: () => void;
  onRecordCancel: () => void;
  recording: boolean;
  compact: boolean;
  bottomInset: number;
}) {
  const { colors } = useTheme();
  const canSend = Boolean(draft.trim() || pending.length);

  // Slide-to-cancel state for the WhatsApp-style mic button. Drag the
  // mic upward (or leftward >= CANCEL_THRESHOLD_PX) to discard the
  // recording instead of sending it. We track the gesture with a
  // PanResponder bound to the mic button's wrapper so the parent's
  // existing scroll/pan handlers don't fight us.
  const CANCEL_THRESHOLD_PX = 80;
  const cancelOffset = useRef(new Animated.Value(0)).current;
  const cancelTriggeredRef = useRef(false);
  const recordingStartRef = useRef<number | null>(null);
  const [recordSecs, setRecordSecs] = useState(0);
  const recordTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (recording) {
      recordingStartRef.current = Date.now();
      setRecordSecs(0);
      recordTickRef.current = setInterval(() => {
        if (recordingStartRef.current) {
          setRecordSecs(Math.floor((Date.now() - recordingStartRef.current) / 1000));
        }
      }, 250);
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ]),
      ).start();
    } else {
      if (recordTickRef.current) {
        clearInterval(recordTickRef.current);
        recordTickRef.current = null;
      }
      recordingStartRef.current = null;
      setRecordSecs(0);
      pulse.stopAnimation();
      pulse.setValue(0);
      cancelTriggeredRef.current = false;
      cancelOffset.setValue(0);
    }
    return () => {
      if (recordTickRef.current) {
        clearInterval(recordTickRef.current);
        recordTickRef.current = null;
      }
    };
  }, [cancelOffset, pulse, recording]);

  const micPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          cancelTriggeredRef.current = false;
          cancelOffset.setValue(0);
          onRecordStart();
        },
        onPanResponderMove: (_, gesture) => {
          // Either upward (-dy) or leftward (-dx). We track the larger
          // axis so the user can flick in whichever direction feels
          // natural with their thumb.
          const offset = Math.max(0, Math.max(-gesture.dy, -gesture.dx));
          cancelOffset.setValue(offset);
          if (offset >= CANCEL_THRESHOLD_PX && !cancelTriggeredRef.current) {
            cancelTriggeredRef.current = true;
          }
        },
        onPanResponderRelease: () => {
          if (cancelTriggeredRef.current) {
            onRecordCancel();
          } else {
            onRecordEnd();
          }
        },
        onPanResponderTerminate: () => {
          if (cancelTriggeredRef.current) onRecordCancel();
          else onRecordEnd();
        },
      }),
    [cancelOffset, onRecordCancel, onRecordEnd, onRecordStart],
  );

  const recordingTimeText = `${Math.floor(recordSecs / 60)}:${(recordSecs % 60).toString().padStart(2, '0')}`;

  return (
    <View style={[styles.composerShell, { paddingBottom: bottomInset }]}>
      {replyingTo ? (() => {
        const meta = describeReplyTarget(replyingTo);
        return (
          <View style={[styles.replyPreview, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
            <Ionicons name="return-up-back-outline" size={15} color={colors.primary} />
            {meta.thumbUri ? (
              <View style={styles.replyThumbWrap}>
                {meta.thumbIsVideo ? (
                  <Video source={{ uri: meta.thumbUri }} style={styles.replyThumb} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted positionMillis={1} useNativeControls={false} />
                ) : (
                  <Image source={{ uri: meta.thumbUri }} style={styles.replyThumb} />
                )}
                {meta.thumbIsVideo ? (
                  <View style={styles.replyThumbPlay}><Ionicons name="play" size={9} color="#fff" style={{ marginLeft: 1 }} /></View>
                ) : null}
              </View>
            ) : null}
            <Text style={[styles.replyPreviewText, { color: colors.textSecondary }]} numberOfLines={1}>
              Replying to {prettyContactLabel(replyingTo.senderName)}: {meta.label}{meta.duration ? ` · ${meta.duration}` : ''}
            </Text>
            <TouchableOpacity onPress={onCancelReply}><Ionicons name="close" size={17} color={colors.textTertiary} /></TouchableOpacity>
          </View>
        );
      })() : null}
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
        <Animated.View
          style={[
            styles.recordingBar,
            { backgroundColor: colors.dangerMuted, borderColor: colors.danger, opacity: cancelOffset.interpolate({ inputRange: [0, CANCEL_THRESHOLD_PX], outputRange: [1, 0.55], extrapolate: 'clamp' }) },
          ]}
        >
          <Animated.View
            style={[
              styles.recordDot,
              { backgroundColor: colors.danger, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
            ]}
          />
          <Text style={[styles.recordingText, { color: colors.dangerText }]}>{recordingTimeText}</Text>
          <Animated.Text
            style={[
              styles.recordSlideHint,
              {
                color: colors.dangerText,
                transform: [{ translateX: cancelOffset.interpolate({ inputRange: [0, CANCEL_THRESHOLD_PX], outputRange: [0, -CANCEL_THRESHOLD_PX], extrapolate: 'clamp' }) }],
              },
            ]}
            numberOfLines={1}
          >
            ◀ Slide to cancel
          </Animated.Text>
          <TouchableOpacity style={[styles.recordCancelChip, { backgroundColor: colors.danger }]} onPress={onRecordCancel}>
            <Text style={[styles.recordCancelText, { color: '#fff' }]}>Cancel</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : null}
      <View style={styles.composeRow}>
        <View style={[styles.composerField, { borderColor: colors.border }]}>
          <TouchableOpacity style={styles.composerIcon} onPress={onEmoji}>
            <Ionicons name="happy-outline" size={25} color={colors.textSecondary} />
          </TouchableOpacity>
          <TextInput
            value={draft}
            onChangeText={onDraft}
            onFocus={onInputFocus}
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
          <Animated.View
            style={[
              styles.sendBtn,
              {
                backgroundColor: colors.primary,
                transform: [
                  { translateY: cancelOffset.interpolate({ inputRange: [0, CANCEL_THRESHOLD_PX], outputRange: [0, -CANCEL_THRESHOLD_PX], extrapolate: 'clamp' }) },
                  { scale: recording ? 1.18 : 1 },
                ],
              },
            ]}
            {...micPanResponder.panHandlers}
          >
            <Ionicons name="mic" size={19} color="#fff" />
          </Animated.View>
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

function ContactPicker({ visible, users, loading, onClose, onPick }: {
  visible: boolean;
  users: ChatDirectoryUser[];
  loading: boolean;
  onClose: () => void;
  onPick: (user: ChatDirectoryUser) => void;
}) {
  const { colors } = useTheme();
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || String(u.extensionNumber || '').includes(q));
  }, [search, users]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheetCard, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => undefined}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Share contact</Text>
              <Text style={[styles.modalSub, { color: colors.textSecondary }]}>Insert a teammate's contact card.</Text>
            </View>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={colors.textSecondary} /></TouchableOpacity>
          </View>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search teammates"
            placeholderTextColor={colors.textTertiary}
            style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
          />
          {loading ? <ActivityIndicator color={colors.primary} /> : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.id}
              style={styles.userList}
              bounces={false}
              overScrollMode="never"
              renderItem={({ item }) => (
                <TouchableOpacity style={[styles.userRow, { borderBottomColor: colors.borderSubtle }]} onPress={() => onPick(item)}>
                  <Avatar name={item.name || item.email} size="sm" />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.userName, { color: colors.text }]}>{item.name || item.email}</Text>
                    <Text style={[styles.userMeta, { color: colors.textSecondary }]}>{item.extensionNumber ? `Ext ${item.extensionNumber}` : item.email}</Text>
                  </View>
                  <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                </TouchableOpacity>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const EMOJI_COLUMNS = 8;
const EMOJI_CELL_HEIGHT = 38;

const EmojiCell = memo(function EmojiCell({ emoji, onPick }: { emoji: string; onPick: (emoji: string) => void }) {
  return (
    <TouchableOpacity style={styles.emojiCell} onPress={() => onPick(emoji)}>
      <Text style={styles.emojiLarge}>{emoji}</Text>
    </TouchableOpacity>
  );
});

const getEmojiItemLayout = (_data: ArrayLike<EmojiEntry> | null | undefined, index: number) => ({
  length: EMOJI_CELL_HEIGHT,
  offset: EMOJI_CELL_HEIGHT * Math.floor(index / EMOJI_COLUMNS),
  index,
});

const EmojiPanel = memo(function EmojiPanel({ visible, onPick, onClose }: { visible: boolean; onPick: (emoji: string) => void; onClose: () => void }) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);

  // Preload recents once on mount so the panel is fully warm before it's ever
  // opened — opening then only flips a style, never mounts/measures the list.
  useEffect(() => {
    let alive = true;
    loadRecentEmojis().then((list) => {
      if (alive) setRecents(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Reset the search query each time the panel is reopened.
  useEffect(() => {
    if (visible) setQuery('');
  }, [visible]);

  const handlePick = useCallback(
    (emoji: string) => {
      onPick(emoji);
      // Defer the storage write + recents refresh so the emoji lands in the
      // draft instantly instead of waiting on AsyncStorage / a re-render.
      setTimeout(() => {
        recordRecentEmoji(emoji).then(setRecents).catch(() => undefined);
      }, 0);
    },
    [onPick],
  );

  const data: EmojiEntry[] = useMemo(() => (query.trim() ? searchEmojis(query) : EMOJI_CATALOG), [query]);
  const recentEntries = useMemo(() => recentToEntries(recents), [recents]);
  const renderItem = useCallback(({ item }: { item: EmojiEntry }) => <EmojiCell emoji={item.emoji} onPick={handlePick} />, [handlePick]);
  const keyExtractor = useCallback((item: EmojiEntry, index: number) => `${item.emoji}:${index}`, []);

  const header = useMemo(
    () =>
      !query.trim() && recentEntries.length ? (
        <View style={styles.emojiRecentWrap}>
          <Text style={[styles.emojiSectionLabel, { color: colors.textSecondary }]}>Recently used</Text>
          <View style={styles.emojiGrid}>
            {recentEntries.map((item, index) => (
              <EmojiCell key={`recent:${item.emoji}:${index}`} emoji={item.emoji} onPick={handlePick} />
            ))}
          </View>
          <Text style={[styles.emojiSectionLabel, { color: colors.textSecondary }]}>All emoji</Text>
        </View>
      ) : null,
    [query, recentEntries, handlePick, colors.textSecondary],
  );

  return (
    <View
      style={[styles.emojiPanel, { backgroundColor: colors.surface, borderColor: colors.border }, !visible && styles.emojiPanelHidden]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <View style={styles.emojiHeader}>
        <Text style={[styles.emojiTitle, { color: colors.text }]}>Emoji</Text>
        <TouchableOpacity onPress={onClose}><Ionicons name="close" size={18} color={colors.textSecondary} /></TouchableOpacity>
      </View>
      <View style={[styles.emojiSearch, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
        <Ionicons name="search" size={15} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search emoji"
          placeholderTextColor={colors.textTertiary}
          style={[styles.emojiSearchInput, { color: colors.text }]}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')}>
            <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>
      <FlatList
        data={data}
        keyExtractor={keyExtractor}
        numColumns={EMOJI_COLUMNS}
        style={styles.emojiScroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        initialNumToRender={64}
        maxToRenderPerBatch={64}
        windowSize={9}
        getItemLayout={getEmojiItemLayout}
        removeClippedSubviews
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={[styles.emojiEmpty, { color: colors.textTertiary }]}>No emoji found</Text>}
        renderItem={renderItem}
      />
    </View>
  );
});

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
          <ActionRow icon="trash-outline" label="Delete for me" destructive onPress={() => onDelete(message, 'me')} />
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

// Pinch-to-zoom + pan + double-tap for the fullscreen photo viewer. Uses the
// gesture-handler legacy component API driven by RN's Animated (no reanimated
// dependency). Must live under a GestureHandlerRootView (Android modals render
// in their own view tree, so MediaViewer wraps its content in one).
function ZoomableImage({ uri }: { uri: string }) {
  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const doubleTapRef = useRef(null);

  const baseScale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const scale = useRef(Animated.multiply(baseScale, pinchScale)).current;
  const lastScale = useRef(1);

  const baseTransX = useRef(new Animated.Value(0)).current;
  const baseTransY = useRef(new Animated.Value(0)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const translateX = useRef(Animated.add(baseTransX, panX)).current;
  const translateY = useRef(Animated.add(baseTransY, panY)).current;
  const lastTrans = useRef({ x: 0, y: 0 });

  const onPinchEvent = useRef(
    Animated.event([{ nativeEvent: { scale: pinchScale } }], { useNativeDriver: true }),
  ).current;
  const onPanEvent = useRef(
    Animated.event([{ nativeEvent: { translationX: panX, translationY: panY } }], { useNativeDriver: true }),
  ).current;

  const reset = useCallback(() => {
    lastScale.current = 1;
    lastTrans.current = { x: 0, y: 0 };
    pinchScale.setValue(1);
    panX.setValue(0);
    panY.setValue(0);
    Animated.parallel([
      Animated.spring(baseScale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(baseTransX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(baseTransY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  }, [baseScale, baseTransX, baseTransY, panX, panY, pinchScale]);

  const onPinchStateChange = useCallback((e: any) => {
    if (e.nativeEvent.oldState === GestureState.ACTIVE) {
      lastScale.current *= e.nativeEvent.scale;
      pinchScale.setValue(1);
      if (lastScale.current <= 1.01) {
        reset();
      } else {
        if (lastScale.current > 4) lastScale.current = 4;
        baseScale.setValue(lastScale.current);
      }
    }
  }, [baseScale, pinchScale, reset]);

  const onPanStateChange = useCallback((e: any) => {
    if (e.nativeEvent.oldState === GestureState.ACTIVE) {
      lastTrans.current = {
        x: lastTrans.current.x + e.nativeEvent.translationX,
        y: lastTrans.current.y + e.nativeEvent.translationY,
      };
      baseTransX.setValue(lastTrans.current.x);
      baseTransY.setValue(lastTrans.current.y);
      panX.setValue(0);
      panY.setValue(0);
    }
  }, [baseTransX, baseTransY, panX, panY]);

  const onDoubleTap = useCallback((e: any) => {
    if (e.nativeEvent.state === GestureState.ACTIVE) {
      if (lastScale.current > 1.01) {
        reset();
      } else {
        lastScale.current = 2.5;
        baseScale.setValue(2.5);
      }
    }
  }, [baseScale, reset]);

  return (
    <TapGestureHandler ref={doubleTapRef} numberOfTaps={2} onHandlerStateChange={onDoubleTap}>
      <Animated.View style={styles.viewerZoomArea}>
        <PanGestureHandler
          ref={panRef}
          simultaneousHandlers={pinchRef}
          minPointers={1}
          maxPointers={2}
          avgTouches
          onGestureEvent={onPanEvent}
          onHandlerStateChange={onPanStateChange}
        >
          <Animated.View style={styles.viewerZoomArea}>
            <PinchGestureHandler
              ref={pinchRef}
              simultaneousHandlers={panRef}
              onGestureEvent={onPinchEvent}
              onHandlerStateChange={onPinchStateChange}
            >
              <Animated.Image
                source={{ uri }}
                resizeMode="contain"
                style={[styles.viewerImage, { transform: [{ translateX }, { translateY }, { scale }] }]}
              />
            </PinchGestureHandler>
          </Animated.View>
        </PanGestureHandler>
      </Animated.View>
    </TapGestureHandler>
  );
}

function MediaViewer({ preview, onClose }: { preview: MediaPreview | null; onClose: () => void }) {
  const { colors } = useTheme();
  if (!preview) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={[styles.viewer, { backgroundColor: 'rgba(0,0,0,0.92)' }]}>
          <TouchableOpacity style={styles.viewerClose} onPress={onClose}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          {preview.type === 'image' && preview.url ? (
            <ZoomableImage uri={preview.url} />
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
      </GestureHandlerRootView>
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
  bubbleMediaOnly: { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0, backgroundColor: 'transparent' },
  bubbleMine: { alignSelf: 'flex-end', borderBottomRightRadius: 7 },
  bubbleTheirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 7 },
  senderName: { fontSize: 11, fontWeight: '900', marginBottom: 3 },
  messageText: { fontSize: 14, lineHeight: 20 },
  replyInline: { borderRadius: 12, padding: 8, marginBottom: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  replyInlineText: { flexShrink: 1, fontSize: 11.5, fontWeight: '700' },
  replyInlineThumbWrap: { width: 26, height: 26, borderRadius: 6, overflow: 'hidden', backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  replyInlineThumb: { width: 26, height: 26, borderRadius: 6 },
  replyInlineThumbPlay: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center' },
  locationCard: { marginTop: 7, borderRadius: 14, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  locationText: { fontSize: 13, fontWeight: '800' },
  imageGrid: { marginTop: 0, width: CHAT_MEDIA_MAX_WIDTH, flexDirection: 'row', flexWrap: 'wrap', gap: 4, overflow: 'hidden', borderRadius: 20 },
  imageGridSingle: { width: CHAT_MEDIA_MAX_WIDTH },
  imageCell: { overflow: 'hidden', borderRadius: 18, backgroundColor: 'rgba(15,23,42,0.18)' },
  imageCellHalf: { width: (CHAT_MEDIA_MAX_WIDTH - 4) / 2, aspectRatio: 1 },
  imageCellThreeLarge: { width: CHAT_MEDIA_MAX_WIDTH, aspectRatio: 1.9 },
  imageCellThreeSmall: { width: (CHAT_MEDIA_MAX_WIDTH - 4) / 2, aspectRatio: 1 },
  imageBubble: { width: '100%', height: '100%' },
  imageOverflow: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(2,6,23,0.52)' },
  imageOverflowText: { color: '#fff', fontSize: 24, fontWeight: '900' },
  imageStateOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: 'rgba(2,6,23,0.45)' },
  imageStateText: { color: '#fff', fontSize: 11, fontWeight: '900' },
  videoPlayOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  videoPlayButton: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(2,6,23,0.55)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center' },
  voiceBubble: { marginTop: 7, width: Math.min(CHAT_MEDIA_MAX_WIDTH, 260), borderRadius: 18, borderWidth: 1, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 10 },
  voicePlay: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  voiceTrackWrap: { flex: 1, minWidth: 0, gap: 5 },
  voiceTrack: { height: 6, borderRadius: 999, overflow: 'hidden' },
  voiceTrackFill: { height: '100%', borderRadius: 999 },
  voiceDuration: { fontSize: 11, fontWeight: '800' },
  voiceRetry: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  attachmentChip: { marginTop: 7, borderRadius: 14, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  attachmentThumb: { width: 96, height: 96, borderRadius: 14 },
  attachmentName: { fontSize: 12.5, fontWeight: '900' },
  attachmentMeta: { fontSize: 10.5, fontWeight: '700', marginTop: 2 },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 5 },
  bubbleMetaMediaOnly: { marginTop: 4, paddingHorizontal: 4 },
  timeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  retryText: { fontSize: 10, fontWeight: '900', marginLeft: 4 },
  statusTiny: { fontSize: 9, fontWeight: '800' },
  // Timestamp/status sit outside the bubble on the chat background.
  metaOutside: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2, paddingHorizontal: 3 },
  metaOutsideMine: { alignSelf: 'flex-end' },
  metaOutsideTheirs: { alignSelf: 'flex-start' },
  // The pill lifts up to overlap the bubble's bottom edge (half in / half out),
  // sitting on the opposite side from the timestamp.
  reactionSummary: { marginTop: -14, borderRadius: 12, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2, flexDirection: 'row', gap: 5, zIndex: 5, elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  reactionMine: { alignSelf: 'flex-start', marginLeft: 12 },
  reactionTheirs: { alignSelf: 'flex-end', marginRight: 12 },
  reactionSummaryText: { fontSize: 12 },
  composerShell: { paddingHorizontal: spacing['2'], paddingTop: 8, gap: 7, backgroundColor: 'transparent' },
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  composerIcon: { width: 38, height: 46, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  composerField: { flex: 1, minHeight: 46, maxHeight: 116, borderRadius: 23, borderWidth: 1, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: 'transparent' },
  composerInput: { flex: 1, minHeight: 42, maxHeight: 112, paddingHorizontal: 4, paddingVertical: 10, fontSize: 17 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  replyPreview: { borderRadius: 16, borderWidth: 1, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 8 },
  replyPreviewText: { flex: 1, fontSize: 12, fontWeight: '800' },
  replyThumbWrap: { width: 34, height: 34, borderRadius: 7, overflow: 'hidden', backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  replyThumb: { width: 34, height: 34, borderRadius: 7 },
  replyThumbPlay: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center' },
  pendingRow: { flexGrow: 0 },
  pendingChip: { height: 32, borderRadius: 16, borderWidth: 1, paddingHorizontal: 10, marginRight: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pendingText: { maxWidth: 180, fontSize: 12, fontWeight: '800' },
  recordingBar: { borderRadius: 16, borderWidth: 1, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordDot: { width: 9, height: 9, borderRadius: 5 },
  recordingText: { fontSize: 12, fontWeight: '900' },
  recordSlideHint: { flex: 1, fontSize: 12, fontWeight: '800', textAlign: 'center', opacity: 0.85 },
  recordCancelChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  recordCancelText: { fontSize: 12, fontWeight: '900' },
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
  emojiPanelHidden: { opacity: 0, transform: [{ translateY: 1000 }] },
  emojiScroll: { maxHeight: 256 },
  emojiSearch: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, marginBottom: 8 },
  emojiSearchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  emojiRecentWrap: { paddingBottom: 2 },
  emojiSectionLabel: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4, marginBottom: 4, marginLeft: 2 },
  emojiEmpty: { textAlign: 'center', paddingVertical: 24, fontSize: 13, fontWeight: '700' },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingBottom: 4 },
  emojiCell: { width: '12.5%', height: 38, alignItems: 'center', justifyContent: 'center' },
  emojiLarge: { fontSize: 24 },
  actionCard: { marginTop: 'auto', borderRadius: 24, borderWidth: 1, padding: spacing['4'] },
  reactionBar: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing['3'] },
  reactionButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  reactionEmoji: { fontSize: 25 },
  actionRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  actionText: { fontSize: 14, fontWeight: '900' },
  viewer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerZoomArea: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  viewerClose: { position: 'absolute', top: 50, right: 22, zIndex: 3 },
  viewerImage: { width: '100%', height: '82%' },
  viewerVideo: { width: '100%', height: '72%' },
  viewerFile: { margin: spacing['5'], borderRadius: 24, padding: spacing['6'], alignItems: 'center', gap: 10 },
  viewerTitle: { fontSize: 16, fontWeight: '900', textAlign: 'center' },
  viewerSub: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  toast: { position: 'absolute', left: spacing['5'], right: spacing['5'], borderRadius: 16, borderWidth: 1, padding: 12, alignItems: 'center' },
  toastText: { fontSize: 13, fontWeight: '800' },
});
