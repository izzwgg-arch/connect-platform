/**
 * Pure — no imports — so it's testable under plain Node
 * (src/navigation/linking.test.ts). src/navigation/linking.ts wires this into
 * React Navigation's linking config and re-exports it for app code.
 */
export function resolveDeepLinkPath(path: string): { screen: string; params: Record<string, string> } | null {
  const clean = path.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
  const [head, rest] = clean.split(/\/(.+)/);
  if (!head) return { screen: "Feed", params: {} };
  switch (head) {
    case "people":
      return rest ? { screen: "PersonProfile", params: { username: rest } } : null;
    case "companies":
      return rest ? { screen: "Company", params: { slug: rest } } : null;
    case "posts":
      return rest ? { screen: "PostDetail", params: { id: rest } } : null;
    case "messages":
      return rest ? { screen: "Conversation", params: { threadId: rest } } : { screen: "Threads", params: {} };
    case "notifications":
      return { screen: "Notifications", params: {} };
    case "search":
      return { screen: "Search", params: {} };
    case "jobs":
      return rest ? { screen: "JobDetail", params: { id: rest } } : { screen: "JobsList", params: {} };
    case "rfq":
      return rest ? { screen: "RfqDetail", params: { id: rest } } : { screen: "RfqHome", params: {} };
    case "events":
      return rest ? { screen: "EventDetail", params: { slug: rest } } : { screen: "EventsList", params: {} };
    case "groups":
      return rest ? { screen: "GroupDetail", params: { slug: rest } } : { screen: "GroupsList", params: {} };
    case "opportunities":
      return rest ? { screen: "OpportunityDetail", params: { id: rest } } : { screen: "OpportunitiesList", params: {} };
    case "marketplace":
      return rest ? { screen: "ListingDetail", params: { id: rest } } : { screen: "MarketplaceList", params: {} };
    default:
      return null;
  }
}
