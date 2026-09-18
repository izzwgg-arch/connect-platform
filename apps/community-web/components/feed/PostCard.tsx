"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { api, trackEvent } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar, Button, Dialog, Icon, Menu, timeAgo, useToast } from "@/components/ui";
import { MediaGallery } from "@/components/media/MediaGallery";
import { ReportDialog } from "@/components/graph/ReportDialog";
import { REACTION_ICONS, REACTION_KINDS, REACTION_LABELS, type Comment, type Post, type ReactionKind } from "./types";

const VIS_LABEL: Record<string, string> = { PUBLIC: "Public", CONNECTIONS: "Connections", ORGANIZATION: "My company", PRIVATE: "Only me" };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turns raw body text into React nodes: URLs auto-linked, @mentions linked to the person/company they name. */
function renderBody(body: string | null, mentions: Post["mentions"]): ReactNode {
  if (!body) return null;
  const named = mentions.filter((m) => m.name && m.name !== "someone" && m.name !== "a company");
  const alts = named.map((m) => `@${escapeRegExp(m.name)}`);
  const pattern = alts.length ? `(${alts.join("|")})|(https?:\\/\\/[^\\s]+)` : `(https?:\\/\\/[^\\s]+)`;
  const re = new RegExp(pattern, "g");
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body))) {
    if (m.index > last) out.push(body.slice(last, m.index));
    const text = m[0];
    if (text.startsWith("@")) {
      const mention = named.find((mm) => `@${mm.name}` === text);
      out.push(
        <Link key={key++} href={mention?.href ?? "#"} className="mention-link">
          {text}
        </Link>,
      );
    } else {
      out.push(
        <a key={key++} href={text} target="_blank" rel="noreferrer noopener" className="mention-link">
          {text}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

export function PostCard({
  post: initial,
  onChanged,
  onRemoved,
  recommendationId,
  surface = "post_detail",
  position,
  why,
  testId = "post",
}: {
  post: Post;
  onChanged?: (post: Post) => void;
  onRemoved?: (id: string) => void;
  recommendationId?: string | null;
  surface?: string;
  position?: number;
  why?: string | null;
  testId?: string;
}) {
  const { me } = useAuth();
  const toast = useToast();
  const [post, setPost] = useState(initial);
  useEffect(() => setPost(initial), [initial]);

  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteText, setQuoteText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(post.body ?? "");
  const rootRef = useRef<HTMLDivElement>(null);
  const impressed = useRef(false);

  const isCompany = !!post.organization;
  const isAuthor = !!me && me.person.id === post.author?.id;
  const isMine = isAuthor || (isCompany && !!me && me.memberships.some((m) => m.organization.id === post.organizationId));
  const headerName = isCompany ? post.organization!.displayName : post.author?.name ?? "Someone";
  const headerHref = isCompany ? `/companies/${post.organization!.slug}` : post.author ? `/people/${post.author.username}` : "#";
  const headerAsset = isCompany ? post.organization!.logoAssetId : post.author?.avatarAssetId;
  const subBits = [
    isCompany ? post.author?.name : post.author?.headline,
    timeAgo(post.publishedAt ?? post.createdAt),
    post.visibility !== "PUBLIC" ? VIS_LABEL[post.visibility] : null,
    post.editedAt ? "edited" : null,
  ].filter(Boolean);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || impressed.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !impressed.current) {
            impressed.current = true;
            void api(`/posts/${post.id}/impression`, { method: "POST", body: { recommendationId: recommendationId ?? undefined, surface, position } }).catch(() => undefined);
            io.disconnect();
          }
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);

  function patch(next: Partial<Post>) {
    const merged = { ...post, ...next };
    setPost(merged);
    onChanged?.(merged);
  }

  async function react(kind: ReactionKind) {
    setShowPicker(false);
    const wasMine = post.myReaction === kind;
    const prevCount = post.counts.reactions;
    patch({ myReaction: wasMine ? null : kind, counts: { ...post.counts, reactions: post.myReaction ? (wasMine ? prevCount - 1 : prevCount) : prevCount + 1 } });
    try {
      const r = await api<{ myReaction: string | null }>(`/posts/${post.id}/react`, { method: "POST", body: { kind } });
      trackEvent("reaction", { objectType: "post", objectId: post.id });
      if (r.myReaction !== (wasMine ? null : kind)) {
        // server disagreed (e.g. replaced) — resync counts by re-reading is overkill; trust server's myReaction, count already close enough.
        patch({ myReaction: r.myReaction });
      }
    } catch (e: any) {
      patch({ myReaction: post.myReaction, counts: post.counts });
      toast(e?.message ?? "Couldn't react to that.", { kind: "err" });
    }
  }

  async function toggleSave() {
    const next = !post.saved;
    patch({ saved: next, counts: { ...post.counts, saves: post.counts.saves + (next ? 1 : -1) } });
    try {
      await api(`/posts/${post.id}/save`, { method: next ? "POST" : "DELETE" });
    } catch (e: any) {
      patch({ saved: !next, counts: post.counts });
      toast(e?.message ?? "Couldn't save that.", { kind: "err" });
    }
  }

  async function loadComments() {
    if (comments) return;
    try {
      const r = await api<{ items: Comment[] }>(`/posts/${post.id}/comments`);
      setComments(r.items);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load comments.", { kind: "err" });
    }
  }

  async function submitComment() {
    const body = commentBody.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await api<{ comment: Comment }>(`/posts/${post.id}/comments`, { method: "POST", body: { body, parentId: replyTo ?? undefined } });
      setCommentBody("");
      setReplyTo(null);
      patch({ counts: { ...post.counts, comments: post.counts.comments + 1 } });
      setComments((cur) => {
        if (!cur) return [r.comment];
        if (r.comment.parentId) {
          return cur.map((c) => (c.id === r.comment.parentId ? { ...c, replyCount: c.replyCount + 1, replies: [...c.replies, r.comment].slice(-3) } : c));
        }
        return [r.comment, ...cur];
      });
      trackEvent("comment", { objectType: "post", objectId: post.id });
    } catch (e: any) {
      toast(e?.message ?? "Couldn't post that comment.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function reactToComment(c: Comment) {
    const wasMine = !!c.myReaction;
    const applyLocal = (list: Comment[]): Comment[] =>
      list.map((x) => {
        if (x.id === c.id) return { ...x, myReaction: wasMine ? null : "LIKE", reactionCount: x.reactionCount + (wasMine ? -1 : 1) };
        if (x.replies?.length) return { ...x, replies: applyLocal(x.replies) };
        return x;
      });
    setComments((cur) => (cur ? applyLocal(cur) : cur));
    try {
      await api(`/comments/${c.id}/react`, { method: "POST", body: { kind: "LIKE" } });
    } catch {
      /* best-effort UI, refetch would correct on next load */
    }
  }

  async function saveEdit() {
    setBusy(true);
    try {
      const r = await api<{ post: Post }>(`/posts/${post.id}`, { method: "PATCH", body: { body: editBody } });
      patch(r.post);
      setEditing(false);
      toast("Post updated.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save your edit.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      await api(`/posts/${post.id}`, { method: "DELETE" });
      setConfirmDelete(false);
      onRemoved?.(post.id);
      toast("Post deleted.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't delete that post.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function doHide() {
    try {
      await api(`/posts/${post.id}/hide`, { method: "POST" });
      onRemoved?.(post.id);
      toast("Hidden. You won't see this post again.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't hide that.", { kind: "err" });
    }
  }

  async function doMute() {
    if (!post.author) return;
    try {
      await api(`/people/${post.author.id}/mute`, { method: "POST" });
      onRemoved?.(post.id);
      toast(`Muted ${post.author.name}.`);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't mute that person.", { kind: "err" });
    }
  }

  async function copyLink() {
    const url = `${window.location.origin}/posts/${post.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ url, title: headerName });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Link copied.");
      }
      await api(`/posts/${post.id}/impression`, { method: "POST", body: { surface: "share" } }).catch(() => undefined);
      trackEvent("share", { objectType: "post", objectId: post.id });
    } catch {
      /* share sheet dismissed */
    }
  }

  async function repost(withComment: boolean) {
    setBusy(true);
    try {
      await api(`/posts/${post.id}/repost`, { method: "POST", body: withComment ? { comment: quoteText.trim() || undefined } : {} });
      patch({ counts: { ...post.counts, reposts: post.counts.reposts + 1 } });
      setQuoteOpen(false);
      setQuoteText("");
      toast(withComment ? "Reposted with your thoughts." : "Reposted.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't repost that.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function vote(optionId: string) {
    if (!post.poll) return;
    try {
      const r = await api<{ post: Post }>(`/posts/${post.id}/poll/vote`, { method: "POST", body: { optionId } });
      patch(r.post);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't record your vote.", { kind: "err" });
    }
  }

  const pollClosed = !!post.poll?.closesAt && new Date(post.poll.closesAt).getTime() < Date.now();

  return (
    <div className="card post" ref={rootRef} data-testid={`${testId}-${post.id}`}>
      <div className="hd">
        <Link href={headerHref}>
          <Avatar name={headerName} assetId={headerAsset} size={40} square={isCompany} />
        </Link>
        <div>
          <Link href={headerHref}>
            <b>{headerName}</b>
          </Link>
          {subBits.length ? <small>{subBits.join(" · ")}</small> : null}
        </div>
        <span className="x">
          <Menu label="Post options">
            {me ? (
              <button type="button" data-testid={`${testId}-copy-link`} onClick={() => void copyLink()}>
                <Icon name="link" /> Copy link
              </button>
            ) : null}
            {isMine ? (
              <button type="button" data-testid={`${testId}-edit`} onClick={() => setEditing(true)}>
                <Icon name="edit" /> Edit
              </button>
            ) : null}
            {isMine ? (
              <button type="button" data-testid={`${testId}-delete`} onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" /> Delete
              </button>
            ) : null}
            {me && !isAuthor ? (
              <button type="button" data-testid={`${testId}-hide`} onClick={() => void doHide()}>
                <Icon name="x" /> Hide this post
              </button>
            ) : null}
            {me && !isAuthor && post.author ? (
              <button type="button" data-testid={`${testId}-mute`} onClick={() => void doMute()}>
                <Icon name="bell" /> Mute {post.author.name}
              </button>
            ) : null}
            {me && !isAuthor ? (
              <button type="button" data-testid={`${testId}-report`} onClick={() => setReportOpen(true)}>
                <Icon name="flag" /> Report
              </button>
            ) : null}
          </Menu>
        </span>
      </div>

      {why ? (
        <div className="why" data-testid={`${testId}-why`}>
          <Icon name="spark" />
          {why}
        </div>
      ) : null}

      {editing ? (
        <div className="composer-preview">
          <textarea className="in composer-body" value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={3} data-testid={`${testId}-edit-body`} />
          <div className="row">
            <Button kind="p" small loading={busy} onClick={() => void saveEdit()} data-testid={`${testId}-edit-save`}>
              Save
            </Button>
            <Button kind="g" small onClick={() => { setEditing(false); setEditBody(post.body ?? ""); }} data-testid={`${testId}-edit-cancel`}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {post.body ? <p className="body">{renderBody(post.body, post.mentions)}</p> : null}

          {post.media.length ? <MediaGallery assets={post.media.map((m) => ({ id: m.id, kind: m.kind, mime: "", alt: m.altText }))} testId={`${testId}-gallery`} /> : null}

          {post.linkPreview ? (
            <a className="link-preview" href={post.linkUrl ?? post.linkPreview.url} target="_blank" rel="noreferrer noopener" data-testid={`${testId}-link-preview`}>
              {post.linkPreview.image ? <img src={post.linkPreview.image} alt="" /> : null}
              <div className="lp-body">
                <span className="lp-url">{safeHost(post.linkPreview.url)}</span>
                <b>{post.linkPreview.title ?? post.linkUrl}</b>
                {post.linkPreview.description ? <small className="dim">{post.linkPreview.description}</small> : null}
              </div>
            </a>
          ) : null}

          {post.poll ? (
            <div className="embed poll-block" data-testid={`${testId}-poll`}>
              <b>{post.poll.question}</b>
              {post.poll.options.map((o) => {
                const pct = post.poll!.totalVotes ? Math.round((o.voteCount / post.poll!.totalVotes) * 100) : 0;
                const mine = post.poll!.myVote === o.id;
                return (
                  <button key={o.id} type="button" className={`poll-opt ${mine ? "mine" : ""}`} onClick={() => void vote(o.id)} disabled={pollClosed} data-testid={`${testId}-poll-option`}>
                    <div className="row sm" style={{ justifyContent: "space-between" }}>
                      <span>
                        {mine ? <Icon name="check" /> : null} {o.text}
                      </span>
                      <b className="mono">{pct}%</b>
                    </div>
                    <div className="prog">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                  </button>
                );
              })}
              <span className="xs dim">
                {post.poll.totalVotes} votes {pollClosed ? "· closed" : post.poll.closesAt ? `· closes ${timeAgo(post.poll.closesAt)}` : ""}
              </span>
            </div>
          ) : null}

          {post.ref ? (
            <Link className="embed" href={post.ref.href} data-testid={`${testId}-ref`}>
              <span className="k">{post.ref.type}</span>
              <b>{post.ref.title || "View"}</b>
            </Link>
          ) : null}
        </>
      )}

      <div className="cnt">
        <span>{post.counts.reactions} reactions</span>
        <span>{post.counts.comments} comments</span>
        {post.counts.reposts ? <span>{post.counts.reposts} reposts</span> : null}
      </div>

      {!me ? (
        <div className="acts">
          <Link className="btn s" href={`/login?next=${encodeURIComponent(`/posts/${post.id}`)}`} data-testid={`${testId}-signin-cta`}>
            Sign in to react, comment or save
          </Link>
        </div>
      ) : (
      <div className="acts">
        <div className="react-picker" onMouseEnter={() => setShowPicker(true)} onMouseLeave={() => setShowPicker(false)}>
          {showPicker ? (
            <div className="react-picker-pop" role="menu">
              {REACTION_KINDS.map((k) => (
                <button key={k} type="button" title={REACTION_LABELS[k]} onClick={() => void react(k)} data-testid={`${testId}-react-${k.toLowerCase()}`}>
                  <Icon name={REACTION_ICONS[k]} />
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className={post.myReaction ? "on" : ""} onClick={() => void react((post.myReaction as ReactionKind) ?? "LIKE")} data-testid={`${testId}-react`}>
            <Icon name={post.myReaction ? REACTION_ICONS[post.myReaction as ReactionKind] : "like"} />
            {post.myReaction ? REACTION_LABELS[post.myReaction as ReactionKind] : "React"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowComments((s) => !s);
            void loadComments();
          }}
          data-testid={`${testId}-comment`}
        >
          <Icon name="msg" />
          Comment
        </button>
        <Menu trigger={<span className="row" style={{ gap: 6 }}><Icon name="repost" />Repost</span>} label="Repost options">
          <button type="button" onClick={() => void repost(false)} data-testid={`${testId}-repost`}>
            <Icon name="repost" /> Repost
          </button>
          <button type="button" onClick={() => setQuoteOpen(true)} data-testid={`${testId}-repost-quote`}>
            <Icon name="edit" /> Repost with your thoughts
          </button>
        </Menu>
        <button type="button" onClick={() => void copyLink()} data-testid={`${testId}-share`}>
          <Icon name="share" />
          Share
        </button>
        <button type="button" className={`r ${post.saved ? "on" : ""}`} onClick={() => void toggleSave()} data-testid={`${testId}-save`}>
          <Icon name="save" />
          {post.saved ? "Saved" : "Save"}
        </button>
      </div>
      )}

      {showComments ? (
        <div className="comment-thread" data-testid={`${testId}-comments`}>
          {me ? (
            <div className="comment-composer">
              <Avatar name={me.profile ? `${me.profile.firstName} ${me.profile.lastName}` : me.person.username} assetId={me.profile?.avatarAssetId} size={30} />
              <input
                className="in"
                placeholder={replyTo ? "Write a reply…" : "Write a comment…"}
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submitComment()}
                data-testid={`${testId}-comment-input`}
              />
              <Button small kind="p" loading={busy} onClick={() => void submitComment()} data-testid={`${testId}-comment-submit`}>
                Post
              </Button>
              {replyTo ? (
                <Button small kind="g" onClick={() => setReplyTo(null)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}
          {comments === null ? (
            <div className="dim sm">Loading comments…</div>
          ) : comments.length === 0 ? (
            <div className="dim sm">No comments yet.</div>
          ) : (
            comments.map((c) => <CommentRow key={c.id} comment={c} onReact={reactToComment} onReply={setReplyTo} testId={testId} />)
          )}
        </div>
      ) : null}

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this post?" footer={
        <>
          <Button kind="g" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button kind="d" loading={busy} onClick={() => void doDelete()} data-testid={`${testId}-delete-confirm`}>Delete</Button>
        </>
      }>
        <p className="sm dim">This can't be undone.</p>
      </Dialog>

      <Dialog open={quoteOpen} onClose={() => setQuoteOpen(false)} title="Repost with your thoughts" footer={
        <>
          <Button kind="g" onClick={() => setQuoteOpen(false)}>Cancel</Button>
          <Button kind="p" loading={busy} onClick={() => void repost(true)} data-testid={`${testId}-repost-quote-submit`}>Repost</Button>
        </>
      }>
        <textarea className="in" rows={3} placeholder="Add your thoughts…" value={quoteText} onChange={(e) => setQuoteText(e.target.value)} data-testid={`${testId}-repost-quote-body`} />
      </Dialog>

      {post.author ? <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} targetType="post" targetId={post.id} testId={`${testId}-report`} /> : null}
    </div>
  );
}

function CommentRow({ comment, onReact, onReply, testId }: { comment: Comment; onReact: (c: Comment) => void; onReply: (id: string) => void; testId: string }) {
  return (
    <div>
      <div className="comment-row">
        <Avatar name={comment.author?.name ?? "?"} assetId={comment.author?.avatarAssetId} size={30} />
        <div className="comment-bubble">
          <Link href={comment.author ? `/people/${comment.author.username}` : "#"}>
            <b>{comment.author?.name ?? "Someone"}</b>
          </Link>
          <p>{comment.body}</p>
          <div className="comment-meta">
            <span>{timeAgo(comment.createdAt)}</span>
            <button type="button" className={comment.myReaction ? "on" : ""} onClick={() => onReact(comment)} data-testid={`${testId}-comment-like`}>
              Like{comment.reactionCount ? ` · ${comment.reactionCount}` : ""}
            </button>
            <button type="button" onClick={() => onReply(comment.id)} data-testid={`${testId}-comment-reply`}>
              Reply
            </button>
          </div>
        </div>
      </div>
      {comment.replies.length ? (
        <div className="comment-replies">
          {comment.replies.map((r) => (
            <CommentRow key={r.id} comment={r} onReact={onReact} onReply={onReply} testId={testId} />
          ))}
          {comment.replyCount > comment.replies.length ? <span className="xs dim">+{comment.replyCount - comment.replies.length} more replies</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
