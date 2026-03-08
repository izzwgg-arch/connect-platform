import type { Tenant, User } from "../types/app";

export const mockTenants: Tenant[] = [
  { id: "t-acme", name: "Acme Voice", plan: "Enterprise", status: "ACTIVE" },
  { id: "t-harbor", name: "Harbor Dental", plan: "Business", status: "ACTIVE" },
  { id: "t-redwood", name: "Redwood Realty", plan: "Starter", status: "SUSPENDED" }
];

export const mockUsers: User[] = [
  {
    id: "u-1",
    name: "Alicia Stone",
    email: "alicia@connectcomms.io",
    extension: "101",
    role: "SUPER_ADMIN",
    tenantId: "t-acme",
    presence: "AVAILABLE"
  },
  {
    id: "u-2",
    name: "Jon Patel",
    email: "jon@acmevoice.com",
    extension: "204",
    role: "TENANT_ADMIN",
    tenantId: "t-acme",
    presence: "ON_CALL"
  },
  {
    id: "u-3",
    name: "Mia Harper",
    email: "mia@acmevoice.com",
    extension: "207",
    role: "END_USER",
    tenantId: "t-acme",
    presence: "DND"
  }
];

export const dashboardMetrics = [
  { label: "Active Calls", value: "12", delta: "+3 vs 1h" },
  { label: "Missed Today", value: "18", delta: "-4 vs yesterday" },
  { label: "Unread Voicemails", value: "9", delta: "Needs follow-up" },
  { label: "SMS Unread", value: "22", delta: "+8 in last hour" },
  { label: "Registered Extensions", value: "94%", delta: "Healthy" },
  { label: "Trunk Health", value: "2/3", delta: "1 degraded" }
];
