import type { OrgCard, PersonCard } from "@/components/graph/types";

/** Mirrors apps/community-api/src/posts/service.ts PostDTO / CommentDTO. */
export type LinkPreview = { title: string | null; description: string | null; image: string | null; url: string };
export type PostMedia = { id: string; kind: string; altText: string | null; urls: { thumb: string; medium: string; original: string } };
export type PostPoll = { question: string; closesAt: string | null; options: Array<{ id: string; text: string; voteCount: number }>; totalVotes: number; myVote: string | null };
export type PostRefEmbed = { type: string; id: string; title: string; href: string } | null;
export type PostMention = { personId: string | null; orgId: string | null; name: string; href: string };

export type Post = {
  id: string;
  kind: string;
  body: string | null;
  visibility: string;
  commentsPolicy: string;
  linkUrl: string | null;
  linkPreview: LinkPreview | null;
  altText: string | null;
  industry: string | null;
  location: string | null;
  organizationId: string | null;
  publishedAt: string | null;
  scheduledFor: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: PersonCard | null;
  organization: OrgCard | null;
  media: PostMedia[];
  poll: PostPoll | null;
  ref: PostRefEmbed;
  repostComment: string | null;
  counts: { reactions: number; comments: number; reposts: number; saves: number; impressions: number };
  myReaction: string | null;
  saved: boolean;
  mentions: PostMention[];
};

export type Comment = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  editedAt: string | null;
  createdAt: string;
  author: PersonCard | null;
  reactionCount: number;
  myReaction: string | null;
  replyCount: number;
  replies: Comment[];
};

export type FeedItem = { post: Post; recommendationId: string; why: string | null };
export type FeedMode = "for_you" | "following" | "latest" | "industry" | "local" | "opportunities" | "jobs";

export const FEED_MODE_LABELS: Record<FeedMode, string> = {
  for_you: "For you",
  following: "Following",
  latest: "Latest",
  industry: "My industry",
  local: "Local",
  opportunities: "Opportunities",
  jobs: "Jobs",
};
export const FEED_MODES: FeedMode[] = ["for_you", "following", "latest", "industry", "local", "opportunities", "jobs"];

export const REACTION_KINDS = ["LIKE", "INSIGHTFUL", "CELEBRATE", "SUPPORT"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export const REACTION_LABELS: Record<ReactionKind, string> = { LIKE: "Like", INSIGHTFUL: "Insightful", CELEBRATE: "Celebrate", SUPPORT: "Support" };
export const REACTION_ICONS: Record<ReactionKind, string> = { LIKE: "like", INSIGHTFUL: "spark", CELEBRATE: "star", SUPPORT: "heart" };
