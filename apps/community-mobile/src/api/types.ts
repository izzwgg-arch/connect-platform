// Shared response shapes, mirrored from apps/community-api's card builders and
// apps/community-web/lib/auth.tsx's Me type. Kept loose (many `any`/optional
// fields) on purpose — the api is the source of truth; over-typing here just
// invites drift the app can't detect.

export type PersonCard = {
  id: string;
  username: string;
  name: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  avatarAssetId: string | null;
  location: string | null;
  industry: string | null;
  verified: string[];
  primaryOrg: { id: string; slug: string; displayName: string } | null;
};

export type OrgCard = {
  id: string;
  slug: string;
  displayName: string;
  logoAssetId: string | null;
  industry: string | null;
  size: string | null;
  location: string | null;
  followerCount: number;
  verified: string[];
  loopcomLinked: boolean;
};

export type Me = {
  person: {
    id: string;
    username: string;
    email: string | null;
    phone: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    verified: boolean;
    status: string;
    loopcomLinked: boolean;
    mfaEnabled: boolean;
    onboardingDone: boolean;
    createdAt: string;
  };
  profile: {
    firstName: string;
    lastName: string;
    headline: string | null;
    about: string | null;
    avatarAssetId: string | null;
    coverAssetId: string | null;
    location: string | null;
    serviceArea: string[];
    languages: string[];
    industry: string | null;
    objectives: string[];
    skills: string[];
  } | null;
  memberships: Array<{
    id: string;
    role: string;
    permissions: string[];
    affiliation: string;
    isPrimary: boolean;
    organization: { id: string; slug: string; displayName: string; logoAssetId: string | null; loopcomTenantId: string | null };
  }>;
  staffRole: string | null;
  counts: { notifications: number; messages: number; invitations: number };
};

export type ReactionKind = "LIKE" | "INSIGHTFUL" | "CELEBRATE" | "SUPPORT";

export type PostDTO = {
  id: string;
  kind: string;
  body: string | null;
  visibility: string;
  commentsPolicy: string;
  linkUrl: string | null;
  linkPreview: { title: string | null; description: string | null; image: string | null; url: string } | null;
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
  media: Array<{ id: string; kind: string; altText: string | null; urls: { thumb: string; medium: string; original: string } }>;
  poll: {
    question: string;
    closesAt: string | null;
    options: Array<{ id: string; text: string; voteCount: number }>;
    totalVotes: number;
    myVote: string | null;
  } | null;
  ref: { type: string; id: string; title?: string | null; href?: string | null } | null;
  repostComment: string | null;
  counts: { reactions: number; comments: number; reposts: number; saves: number; impressions: number };
  myReaction: ReactionKind | null;
  saved: boolean;
  mentions: Array<{ personId: string | null; orgId: string | null; name: string; href: string }>;
};

export type FeedItem = { post: PostDTO; recommendationId: string; why: string | null };

export type ThreadParticipant = { personId: string; card: PersonCard; role: string; typing?: boolean };

export type ThreadListItem = {
  id: string;
  kind: string;
  title: string | null;
  participants: ThreadParticipant[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  pinnedAt: string | null;
  mutedUntil: string | null;
  ref: { type: string; id: string } | null;
  requestFromMe: boolean;
};

export type MessageDTO = {
  id: string;
  threadId: string;
  sender: PersonCard | null;
  kind: string;
  body: string | null;
  asset: { id: string; kind: string; mime: string; url: string; name: string | null } | null;
  replyTo: { id: string; senderName: string; body: string | null } | null;
  forwardedFrom: string | null;
  refType: string | null;
  refId: string | null;
  reactions: Record<string, number> & { mine?: string[] };
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

export type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  count: number;
  readAt: string | null;
  createdAt: string;
  objectType: string | null;
  objectId: string | null;
  actor: PersonCard | null;
  group: "today" | "week" | "earlier";
};

/** `item`'s shape depends on `type` (PersonCard for people, OrgCard for organizations, etc.) — kept as `any` on purpose, see search/engine.ts SearchHit. */
export type SearchResult = {
  type: "people" | "organizations" | "posts" | "jobs" | "listings" | "groups" | "events" | "rfqs" | "opportunities" | string;
  id: string;
  rank: number;
  why: string;
  item: any;
};
