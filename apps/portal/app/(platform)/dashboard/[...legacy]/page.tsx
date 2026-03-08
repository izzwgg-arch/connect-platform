import { redirect } from "next/navigation";

const topMap: Record<string, string> = {
  voice: "/pbx",
  sms: "/apps/sms-campaigns",
  whatsapp: "/apps/whatsapp",
  customers: "/apps/customers",
  billing: "/billing",
  settings: "/settings",
  admin: "/admin/pbx",
  search: "/dashboard",
  automation: "/apps",
  numbers: "/apps/customers",
  extensions: "/pbx/extensions"
};

export default function LegacyDashboardRedirect({ params }: { params: { legacy?: string[] } }) {
  const first = params.legacy?.[0] || "";
  const target = topMap[first] || "/dashboard";
  redirect(target);
}
