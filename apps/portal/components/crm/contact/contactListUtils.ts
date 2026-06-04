export type ContactWorkspaceDeepLink = {
  workspace?: "email" | "sms";
  action?: "call";
};

export function buildContactWorkspaceHref(
  contactId: string,
  returnTo: string,
  deepLink?: ContactWorkspaceDeepLink,
): string {
  const params = new URLSearchParams({ returnTo });
  if (deepLink?.workspace) params.set("workspace", deepLink.workspace);
  if (deepLink?.action) params.set("action", deepLink.action);
  const q = params.toString();
  return `/crm/contacts/${contactId}${q ? `?${q}` : ""}`;
}
