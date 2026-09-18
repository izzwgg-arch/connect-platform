import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, uploadMedia } from "../../api/client";
import type { MessageDTO } from "../../api/types";
import { Avatar, Button, Field, Icon, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MessagesStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversation">;

export function ConversationScreen({ route, navigation }: Props) {
  const { threadId, title } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [thread, setThread] = useState<{ myState: string; kind: string } | null>(null);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: title ?? "Conversation" });
  }, [navigation, title]);

  const load = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([
        api<{ myState: string; kind: string }>(`/threads/${threadId}`),
        api<{ items: MessageDTO[]; nextCursor: string | null }>(`/threads/${threadId}/messages`),
      ]);
      setThread(t);
      setMessages(m.items);
      setCursor(m.nextCursor);
      await api(`/threads/${threadId}/read`, { method: "POST" });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadOlder() {
    if (!cursor) return;
    try {
      const res = await api<{ items: MessageDTO[]; nextCursor: string | null }>(`/threads/${threadId}/messages?cursor=${cursor}`);
      setMessages((prev) => [...res.items, ...prev]);
      setCursor(res.nextCursor);
    } catch {
      /* ignore — user can retry by scrolling again */
    }
  }

  async function send(extra?: { assetId?: string; kind?: string }) {
    if (!body.trim() && !extra) return;
    const text = body.trim();
    setBody("");
    try {
      const res = await api<{ message: MessageDTO }>(`/threads/${threadId}/messages`, {
        method: "POST",
        body: { body: text || undefined, replyToId: replyTo?.id, ...extra },
      });
      setMessages((prev) => [...prev, res.message]);
      setReplyTo(null);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  function onTyping(v: string) {
    setBody(v);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    api(`/threads/${threadId}/typing`, { method: "POST" }).catch(() => {});
    typingTimer.current = setTimeout(() => {}, 2000);
  }

  async function react(m: MessageDTO, emoji: string) {
    try {
      await api(`/threads/${threadId}/messages/${m.id}/react`, { method: "POST", body: { emoji } });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function remove(m: MessageDTO) {
    try {
      await api(`/threads/${threadId}/messages/${m.id}`, { method: "DELETE" });
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, deletedAt: new Date().toISOString(), body: null } : x)));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function forward(m: MessageDTO) {
    navigation.navigate("NewMessage", { forwardMessageId: m.id, forwardFromThreadId: threadId });
  }

  async function pickImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      toast("Photo library access is off.", { kind: "err" });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 });
    if (result.canceled) return;
    const asset = result.assets[0];
    try {
      const uploaded = await uploadMedia(asset.uri, asset.fileName ?? "photo.jpg", asset.mimeType ?? "image/jpeg");
      await send({ assetId: uploaded.asset.id, kind: "IMAGE" });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false });
    if (result.canceled) return;
    const file = result.assets[0];
    try {
      const uploaded = await uploadMedia(file.uri, file.name, file.mimeType ?? "application/octet-stream");
      await send({ assetId: uploaded.asset.id, kind: "FILE" });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function startRecording() {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      toast("Microphone access is off.", { kind: "err" });
      return;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const { recording: rec } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    setRecording(rec);
  }

  async function stopRecording() {
    if (!recording) return;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    setRecording(null);
    if (!uri) return;
    try {
      const uploaded = await uploadMedia(uri, `voice-${Date.now()}.m4a`, "audio/m4a");
      await send({ assetId: uploaded.asset.id, kind: "AUDIO" });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function accept() {
    await api(`/threads/${threadId}/accept`, { method: "POST" });
    load();
  }
  async function decline() {
    await api(`/threads/${threadId}/decline`, { method: "POST" });
    navigation.goBack();
  }

  const isPendingForMe = thread?.myState === "REQUESTED";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
        <FlatList
          data={messages}
          keyExtractor={(m) => m.id}
          inverted={false}
          onStartReached={loadOlder}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          renderItem={({ item }) => <MessageBubble m={item} onReact={(e) => react(item, e)} onDelete={() => remove(item)} onReply={() => setReplyTo(item)} onForward={() => forward(item)} />}
        />
        {isPendingForMe ? (
          <View style={{ flexDirection: "row", gap: 10, padding: 12 }}>
            <Button title="Accept" kind="primary" onPress={accept} testID="thread-accept" />
            <Button title="Decline" kind="danger" onPress={decline} testID="thread-decline" />
          </View>
        ) : (
          <View style={{ padding: 10, gap: 6, borderTopWidth: 1, borderColor: theme.border }}>
            {replyTo ? (
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text numberOfLines={1} style={{ color: theme.dim, fontSize: 12 }}>
                  Replying to: {replyTo.body ?? "attachment"}
                </Text>
                <Pressable onPress={() => setReplyTo(null)} accessibilityRole="button" accessibilityLabel="Cancel reply">
                  <Icon name="x" size={14} />
                </Pressable>
              </View>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Attach image" onPress={pickImage}>
                <Icon name="cam" />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Attach file" onPress={pickFile}>
                <Icon name="doc" />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={recording ? "Stop recording" : "Record voice note"} onPress={recording ? stopRecording : startRecording}>
                <Icon name="mic" color={recording ? theme.danger : theme.text} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Field placeholder="Message" value={body} onChangeText={onTyping} testID="conversation-input" />
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={() => send()} testID="conversation-send">
                <Icon name="send" color={theme.accent} />
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({ m, onReact, onDelete, onReply, onForward }: { m: MessageDTO; onReact: (e: string) => void; onDelete: () => void; onReply: () => void; onForward: () => void }) {
  const { theme } = useTheme();
  const [showActions, setShowActions] = useState(false);
  return (
    <Pressable onLongPress={() => setShowActions((v) => !v)} accessibilityRole="button" accessibilityLabel="Message actions" style={{ maxWidth: "80%", gap: 4 }}>
      <View style={{ backgroundColor: theme.panel2, borderRadius: 12, padding: 10 }}>
        {m.replyTo ? (
          <Text style={{ color: theme.dim, fontSize: 11, marginBottom: 4 }}>
            ↳ {m.replyTo.senderName}: {m.replyTo.body ?? "attachment"}
          </Text>
        ) : null}
        {m.deletedAt ? (
          <Text style={{ color: theme.dim, fontStyle: "italic" }}>Message deleted</Text>
        ) : m.asset?.kind === "IMAGE" || m.asset?.kind === "image" ? (
          <Image source={{ uri: m.asset.url }} style={{ width: 180, height: 180, borderRadius: 8 }} />
        ) : m.asset ? (
          <Text style={{ color: theme.accent }}>{m.asset.name ?? "Attachment"}</Text>
        ) : (
          <Text style={{ color: theme.text }}>{m.body}</Text>
        )}
        {m.editedAt ? <Text style={{ color: theme.dim, fontSize: 10 }}>edited</Text> : null}
      </View>
      {showActions ? (
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Pressable onPress={() => onReact("❤️")}>
            <Text>{"❤️"}</Text>
          </Pressable>
          <Pressable onPress={onReply}>
            <Text style={{ color: theme.dim, fontSize: 12 }}>Reply</Text>
          </Pressable>
          <Pressable onPress={onForward}>
            <Text style={{ color: theme.dim, fontSize: 12 }}>Forward</Text>
          </Pressable>
          <Pressable onPress={onDelete}>
            <Text style={{ color: theme.danger, fontSize: 12 }}>Delete</Text>
          </Pressable>
        </View>
      ) : null}
    </Pressable>
  );
}
