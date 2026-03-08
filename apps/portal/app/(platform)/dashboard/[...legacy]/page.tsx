import { redirect } from "next/navigation";

const topMap: Record<string, string> = {
  voice: "/dashboard/voice/phone",
  sms: "/sms",
  whatsapp: "/sms",
  customers: "/contacts",
  billing: "/reports",
  settings: "/settings",
  admin: "/dashboard/admin/pbx/instances",
  search: "/dashboard",
  automation: "/admin",
  numbers: "/contacts",
  extensions: "/team"
};

export default function LegacyDashboardRedirect({ params }: { params: { legacy?: string[] } }) {
  const first = params.legacy?.[0] || "";
  const target = topMap[first] || "/dashboard";
  redirect(target);
}
