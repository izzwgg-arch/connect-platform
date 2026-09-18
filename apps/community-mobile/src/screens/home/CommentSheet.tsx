import { useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { api, ApiError } from "../../api/client";
import { Avatar, Button, Field, Sheet, useToast } from "../../ui";

type CommentDTO = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  author: { id: string; name: string; avatarAssetId: string | null } | null;
  reactionCount: number;
  myReaction: string | null;
  replyCount: number;
  replies: CommentDTO[];
};

export function CommentSheet({
  postId,
  visible,
  onClose,
  onCountChange,
}: {
  postId: string;
  visible: boolean;
  onClose: () => void;
  onCountChange: (count: number) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<CommentDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    api<{ items: CommentDTO[] }>(`/posts/${postId}/comments`)
      .then((r) => {
        setItems(r.items);
        const total = r.items.reduce((a, c) => a + 1 + c.replyCount, 0);
        setCount(total);
      })
      .catch((err) => toast((err as ApiError).message, { kind: "err" }))
      .finally(() => setLoading(false));
  }, [visible, postId]);

  async function send() {
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await api<{ comment: CommentDTO }>(`/posts/${postId}/comments`, {
        method: "POST",
        body: { body: body.trim(), parentId: replyTo?.id },
      });
      if (replyTo) {
        setItems((prev) => prev.map((c) => (c.id === replyTo.id ? { ...c, replies: [...c.replies, res.comment], replyCount: c.replyCount + 1 } : c)));
      } else {
        setItems((prev) => [res.comment, ...prev]);
      }
      setBody("");
      setReplyTo(null);
      const next = count + 1;
      setCount(next);
      onCountChange(next);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Comments">
      <View style={{ maxHeight: 380 }}>
        <FlatList
          data={items}
          keyExtractor={(c) => c.id}
          ListEmptyComponent={!loading ? <Text style={{ color: "#8ea0b2", textAlign: "center", padding: 16 }}>No comments yet.</Text> : null}
          renderItem={({ item }) => (
            <View style={{ gap: 8, paddingVertical: 8 }}>
              <CommentRow c={item} onReply={() => setReplyTo({ id: item.id, name: item.author?.name ?? "them" })} />
              {item.replies.map((r) => (
                <View key={r.id} style={{ marginLeft: 32 }}>
                  <CommentRow c={r} onReply={() => setReplyTo({ id: item.id, name: r.author?.name ?? "them" })} />
                </View>
              ))}
            </View>
          )}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end", marginTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Field
            placeholder={replyTo ? `Reply to ${replyTo.name}...` : "Write a comment..."}
            value={body}
            onChangeText={setBody}
            testID="comment-input"
          />
        </View>
        <Button title="Post" kind="primary" onPress={send} loading={sending} disabled={!body.trim()} testID="comment-send" />
      </View>
    </Sheet>
  );
}

function CommentRow({ c, onReply }: { c: CommentDTO; onReply: () => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Avatar assetId={c.author?.avatarAssetId} name={c.author?.name} size={30} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "700", color: "#e1e9f1" }}>{c.author?.name ?? "Someone"}</Text>
        <Text style={{ color: "#e1e9f1" }}>{c.body}</Text>
        <Text accessibilityRole="button" onPress={onReply} style={{ color: "#8ea0b2", fontSize: 12, marginTop: 2 }}>
          Reply
        </Text>
      </View>
    </View>
  );
}
