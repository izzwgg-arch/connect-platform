import { redirect } from "next/navigation";

/* Replaced by the rebuilt billing screens. The old page lives in git history at
   the commit before this one if any of it is ever needed again. */
export default function RedirectedBillingPage() {
  redirect("/admin/billing/needs-you");
}
