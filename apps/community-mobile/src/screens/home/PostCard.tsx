import { useState } from "react";
import { Image, Modal, Pressable, Share, Text, View } from "react-native";
import { api, ApiError, newIdempotencyKey } from "../../api/client";
import type { PostDTO } from "../../api/types";
import { Avatar, Icon, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import { CommentSheet } from "./CommentSheet";

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

export function PostCard({
  item,
  onOpenProfile,
  onOpenOrg,
  onChange,
}: {
  item: PostDTO;
  onOpenProfile: (username: string) => void;
  onOpenOrg: (slug: string) => void;
  onChange: (next: PostDTO) => void;
}) {
  const { theme } = useTheme();
  const toast = useToast();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function react() {
    if (busy) return;
    setBusy(true);
    const wasLiked = item.myReaction === "LIKE";
    try {
      const res = await api<{ myReaction: string | null }>(`/posts/${item.id}/react`, { method: "POST", body: { kind: "LIKE" } });
      onChange({
        ...item,
        myReaction: res.myReaction as any,
        counts: { ...item.counts, reactions: item.counts.reactions + (wasLiked ? -1 : 1) },
      });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleSave() {
    try {
      if (item.saved) await api(`/posts/${item.id}/save`, { method: "DELETE" });
      else await api(`/posts/${item.id}/save`, { method: "POST" });
      onChange({ ...item, saved: !item.saved });
      toast(item.saved ? "Removed from saved." : "Saved.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function repost() {
    try {
      await api(`/posts/${item.id}/repost`, { method: "POST", idempotencyKey: newIdempotencyKey() });
      onChange({ ...item, counts: { ...item.counts, reposts: item.counts.reposts + 1 } });
      toast("Reposted to your network.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function hide() {
    try {
      await api(`/posts/${item.id}/hide`, { method: "POST" });
      toast("You won't see this post again.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function report() {
    try {
      await api("/reports", { method: "POST", body: { targetType: "Post", targetId: item.id, reason: "other" }, idempotencyKey: newIdempotencyKey() });
      toast("Reported. Our team will review it.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function vote(optionId: string) {
    if (!item.poll) return;
    try {
      const res = await api<{ poll: PostDTO["poll"] }>(`/posts/${item.id}/poll/vote`, { method: "POST", body: { optionId } });
      onChange({ ...item, poll: res.poll });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function share() {
    try {
      await Share.share({ message: `https://community.loopcom.net/posts/${item.id}` });
    } catch {
      /* user cancelled */
    }
  }

  const name = item.organization?.displayName ?? item.author?.name ?? "Someone";
  const avatarId = item.organization?.logoAssetId ?? item.author?.avatarAssetId;

  return (
    <View style={{ backgroundColor: theme.panel, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 10 }}>
      <Pressable
        onPress={() => (item.organization ? onOpenOrg(item.organization.slug) : item.author ? onOpenProfile(item.author.username) : undefined)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}'s profile`}
        style={{ flexDirection: "row", gap: 10, alignItems: "center" }}
      >
        <Avatar assetId={avatarId} name={name} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontWeight: "700" }}>{name}</Text>
          <Text style={{ color: theme.dim, fontSize: 12 }}>
            {item.organization && item.author ? `${item.author.name} · ` : ""}
            {timeAgo(item.createdAt)}
          </Text>
        </View>
      </Pressable>

      {item.body ? <Text style={{ color: theme.text, fontSize: 15, lineHeight: 21 }}>{item.body}</Text> : null}

      {item.media.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {item.media.map((m) => (
            <Pressable key={m.id} onPress={() => setLightbox(m.urls.original)} accessibilityRole="imagebutton" accessibilityLabel={m.altText ?? "Open photo"}>
              <Image source={{ uri: m.urls.medium }} style={{ width: 110, height: 110, borderRadius: 10, backgroundColor: theme.panel2 }} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {item.poll ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.text, fontWeight: "700" }}>{item.poll.question}</Text>
          {item.poll.options.map((o) => {
            const pct = item.poll!.totalVotes ? Math.round((o.voteCount / item.poll!.totalVotes) * 100) : 0;
            const mine = item.poll!.myVote === o.id;
            return (
              <Pressable
                key={o.id}
                onPress={() => vote(o.id)}
                accessibilityRole="radio"
                accessibilityLabel={o.text}
                accessibilityState={{ checked: mine }}
                style={{ borderRadius: 8, overflow: "hidden", backgroundColor: theme.panel2 }}
              >
                <View style={{ height: 34, width: `${Math.max(pct, 4)}%`, backgroundColor: mine ? theme.accent : theme.border, position: "absolute", left: 0, top: 0, bottom: 0 }} />
                <Text style={{ color: theme.text, padding: 8, fontSize: 13 }}>
                  {o.text} — {pct}%
                </Text>
              </Pressable>
            );
          })}
          <Text style={{ color: theme.dim, fontSize: 12 }}>{item.poll.totalVotes} votes</Text>
        </View>
      ) : null}

      {item.linkPreview ? (
        <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 10, overflow: "hidden" }}>
          {item.linkPreview.image ? <Image source={{ uri: item.linkPreview.image }} style={{ width: "100%", height: 140 }} /> : null}
          <View style={{ padding: 8 }}>
            <Text numberOfLines={1} style={{ color: theme.text, fontWeight: "700" }}>
              {item.linkPreview.title ?? item.linkPreview.url}
            </Text>
            {item.linkPreview.description ? (
              <Text numberOfLines={2} style={{ color: theme.dim, fontSize: 12 }}>
                {item.linkPreview.description}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Like" onPress={react} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Icon name="heart" size={18} color={item.myReaction === "LIKE" ? theme.danger : theme.dim} />
          <Text style={{ color: theme.dim, fontSize: 13 }}>{item.counts.reactions}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Comment" onPress={() => setCommentsOpen(true)} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Icon name="msg" size={18} color={theme.dim} />
          <Text style={{ color: theme.dim, fontSize: 13 }}>{item.counts.comments}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Repost" onPress={repost} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Icon name="repost" size={18} color={theme.dim} />
          <Text style={{ color: theme.dim, fontSize: 13 }}>{item.counts.reposts}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Save" onPress={toggleSave}>
          <Icon name="save" size={18} color={item.saved ? theme.accent : theme.dim} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Share" onPress={share}>
          <Icon name="share" size={18} color={theme.dim} />
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", gap: 16 }}>
        <Pressable accessibilityRole="button" onPress={hide}>
          <Text style={{ color: theme.dim, fontSize: 12 }}>Hide</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={report}>
          <Text style={{ color: theme.dim, fontSize: 12 }}>Report</Text>
        </Pressable>
      </View>

      <CommentSheet postId={item.id} visible={commentsOpen} onClose={() => setCommentsOpen(false)} onCountChange={(n) => onChange({ ...item, counts: { ...item.counts, comments: n } })} />

      <Modal visible={!!lightbox} transparent animationType="fade" onRequestClose={() => setLightbox(null)}>
        <Pressable onPress={() => setLightbox(null)} accessibilityRole="button" accessibilityLabel="Close photo" style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
          {lightbox ? <Image source={{ uri: lightbox }} resizeMode="contain" style={{ width: "100%", height: "80%" }} /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}
