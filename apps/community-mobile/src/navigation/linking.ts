import * as Linking from "expo-linking";
import type { LinkingOptions } from "@react-navigation/native";
import type { RootStackParamList } from "./types";
import { resolveDeepLinkPath } from "./deepLink";

export { resolveDeepLinkPath };

/**
 * One table drives both a real https://community.loopcom.net/... link and a
 * loopcomcommunity://... deep link, and a push notification's `href` field
 * (see src/notifications/push.ts — the tap handler in RootNavigator.tsx
 * calls resolveDeepLinkPath on the href, which is either a full https URL or
 * one of these bare paths; both resolve identically).
 *
 * Screens not yet built natively (jobs/events/groups/rfq/opportunities) route
 * to ExternalLink, which offers "Open on web" instead of a dead screen.
 */
export function buildLinking(): LinkingOptions<RootStackParamList> {
  return {
    prefixes: [Linking.createURL("/"), "https://community.loopcom.net", "loopcomcommunity://"],
    config: {
      screens: {
        App: {
          screens: {
            HomeTab: {
              screens: {
                Feed: "",
                PostDetail: "posts/:id",
                PersonProfile: "people/:username",
                Company: "companies/:slug",
                JobsList: "jobs",
                JobDetail: "jobs/:id",
                RfqHome: "rfq",
                RfqDetail: "rfq/:id",
                EventsList: "events",
                EventDetail: "events/:slug",
                GroupsList: "groups",
                GroupDetail: "groups/:slug",
                OpportunitiesList: "opportunities",
                OpportunityDetail: "opportunities/:id",
                MarketplaceList: "marketplace",
                ListingDetail: "marketplace/:id",
                Crm: "crm",
                Concierge: "concierge",
                ExternalLink: {
                  path: ":kind/:id",
                  parse: {
                    kind: (kind: string) => kind,
                    id: (id: string) => id,
                  },
                },
              },
            },
            MessagesTab: {
              screens: {
                Threads: "messages",
                Conversation: "messages/:threadId",
              },
            },
            MeTab: {
              screens: {
                Me: "me",
                Notifications: "notifications",
                Search: "search",
              },
            },
          },
        },
      },
    },
  };
}
