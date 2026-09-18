/** Mirrors apps/community-api/src/organizations/permissions.ts ORG_PERMISSIONS — keep in sync. */
export const ORG_PERMISSIONS = [
  "org.edit_page",
  "org.manage_members",
  "org.manage_roles",
  "org.post",
  "org.schedule_posts",
  "org.quote",
  "org.manage_rfqs",
  "org.hire",
  "org.manage_jobs",
  "org.manage_listings",
  "org.manage_events",
  "org.billing",
  "org.verify",
  "org.moderate",
  "org.view_analytics",
  "org.manage_locations",
  "org.delete",
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const ORG_PERMISSION_LABELS: Record<OrgPermission, string> = {
  "org.edit_page": "Edit page & settings",
  "org.manage_members": "Manage members",
  "org.manage_roles": "Manage roles & permissions",
  "org.post": "Post as the company",
  "org.schedule_posts": "Schedule posts",
  "org.quote": "Send quotes",
  "org.manage_rfqs": "Manage RFQs",
  "org.hire": "Hire (review applicants)",
  "org.manage_jobs": "Manage job listings",
  "org.manage_listings": "Manage marketplace listings",
  "org.manage_events": "Manage events",
  "org.billing": "Billing",
  "org.verify": "Request verifications",
  "org.moderate": "Moderate content",
  "org.view_analytics": "View analytics",
  "org.manage_locations": "Manage locations",
  "org.delete": "Delete the company page",
};

export const ORG_ROLES = ["OWNER", "ADMIN", "MANAGER", "EMPLOYEE", "RECRUITER", "SALES", "MARKETING", "BILLING_ADMIN", "MODERATOR", "CUSTOM"] as const;
