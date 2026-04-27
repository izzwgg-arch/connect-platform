import { redirect } from "next/navigation";

// Extension Presence has been merged into Team Directory at /team.
export default function PresenceRedirectPage() {
  redirect("/team");
}
