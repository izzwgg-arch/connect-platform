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
    case "events":
    case "groups":
    case "rfq":
    case "opportunities":
      return rest ? { screen: "ExternalLink", params: { kind: head, id: rest } } : null;
    default:
      return null;
  }
}
