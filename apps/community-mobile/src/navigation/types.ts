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
