/**
 * Read-only contacts tool. ⛔ No write variant lives here on purpose: adding
 * or editing contacts stays with the portal and the human team. A read-shaped
 * capability must never quietly grow a write path — that is the exact class of
 * bug that had "DND status?" switching DND on.
 *
 * Security follows the registry's standing rules: the tool schema declares NO
 * tenant — the tenant always comes from the authenticated ToolContext, and
 * executeTool strips any tenant-ish key the model invents.
 */
import type { ToolContext, ToolSpec } from "./toolRegistry";

export type AgentContactsInfo = {
  total: number;
  contacts: Array<{
    name: string;
    company: string | null;
    phones: string[];
    favorite: boolean;
  }>;
};

export interface ContactsToolDeps {
  loadContactsInfo(tenantId: string, search?: string): Promise<AgentContactsInfo>;
}

export function buildContactsTools(deps: ContactsToolDeps): ToolSpec[] {
  return [
    {
      name: "list_contacts",
      description:
        "The company's saved phone-book contacts: names, companies and phone numbers (primary number first). " +
        "Pass `search` to find one person or company by name or number fragment; omit it to list the first 25 (favorites first — `total` says how many exist overall). " +
        "Use this whenever the customer asks who is in their contacts or for somebody's number. Read-only: to add or change a contact, point them at the Contacts page.",
      // A customer reading their own tenant's phone book is the intended use —
      // the tenant lock in ToolContext is the fence, not the role.
      minRole: "customer",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Name, company or number fragment to look for (optional)." },
        },
        additionalProperties: false,
      },
      run: (args: any, ctx: ToolContext) =>
        deps.loadContactsInfo(ctx.tenantId, typeof args?.search === "string" ? args.search : undefined),
    },
  ];
}
