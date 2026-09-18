export type AuthStackParamList = {
  Welcome: undefined;
  SignIn: undefined;
  Join: undefined;
  Verify: { purpose: "email" | "phone"; target: string };
  ForgotPassword: undefined;
};

export type HomeStackParamList = {
  Feed: undefined;
  PostDetail: { id: string };
  PersonProfile: { username: string };
  Company: { slug: string };
  ExternalLink: { title: string; path: string };

  // "Find & sell" — jobs, RFQ, events, groups, opportunities, marketplace,
  // CRM, concierge, recommendations. Live in the Home stack (not a new tab)
  // so push notifications and deep links, which already navigate into
  // HomeTab (see RootNavigator.tsx's notification-tap listener), reach them
  // with no change to that routing; MeScreen's "Find & sell" section pushes
  // into these via navigation.getParent()?.navigate("HomeTab", {...}), the
  // same cross-stack pattern ConnectionsScreen already uses for Messages.
  JobsList: undefined;
  JobDetail: { id: string };
  MyApplications: undefined;
  RfqHome: undefined;
  RfqNew: { toOrganizationId?: string; toOrganizationName?: string } | undefined;
  RfqDetail: { id: string };
  EventsList: undefined;
  // At least one of the two is always given — the events list passes both;
  // a deep link (/events/:slug) only has the slug, so the detail screen
  // fetches by slug via GET /public/events/:slug either way.
  EventDetail: { id?: string; slug?: string };
  GroupsList: undefined;
  GroupDetail: { slug: string };
  OpportunitiesList: undefined;
  OpportunityDetail: { id: string };
  PostOpportunity: { typeSlug?: string } | undefined;
  MarketplaceList: undefined;
  ListingDetail: { id: string };
  PostListing: undefined;
  Crm: undefined;
  Concierge: undefined;
  ForYou: undefined;
};

export type NetworkStackParamList = {
  Network: undefined;
  Connections: { filter?: string } | undefined;
  PersonProfile: { username: string };
  Company: { slug: string };
};

export type MessagesStackParamList = {
  Threads: undefined;
  Conversation: { threadId: string; title?: string };
  NewMessage: { forwardMessageId?: string; forwardFromThreadId?: string } | undefined;
  PersonProfile: { username: string };
};

export type MeStackParamList = {
  Me: undefined;
  EditProfile: undefined;
  Qr: undefined;
  Scan: undefined;
  Settings: undefined;
  Sessions: undefined;
  Security: undefined;
  Notifications: undefined;
  Search: undefined;
  Onboarding: undefined;
  Blocked: undefined;
  PersonProfile: { username: string };
  Company: { slug: string };
};

export type RootTabParamList = {
  HomeTab: undefined;
  NetworkTab: undefined;
  PostTab: undefined;
  MessagesTab: undefined;
  MeTab: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  App: undefined;
  Composer: { replyToOrgId?: string } | undefined;
  Lock: undefined;
};
