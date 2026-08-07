import { redirect } from "next/navigation";

/* The billing home is now "This month". */
export default function AdminBillingHome() {
  redirect("/admin/billing/month");
}
