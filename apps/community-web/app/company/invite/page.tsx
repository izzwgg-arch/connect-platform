"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Empty, Skeleton } from "@/components/ui";

function AcceptInvite() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("");
  const [orgSlug, setOrgSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("This invitation link is missing its token.");
      return;
    }
    api<{ organization: { slug: string; displayName: string }; role: string }>("/organizations/invites/accept", { method: "POST", body: { token } })
      .then((r) => {
        setOrgSlug(r.organization.slug);
        setMessage(`You've joined ${r.organization.displayName} as ${r.role.toLowerCase()}.`);
        setState("done");
      })
      .catch((err) => {
        setMessage((err as ApiError).message ?? "That invitation isn't valid anymore.");
        setState("error");
      });
  }, [token]);

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 480 }}>
      <div className="card" data-testid="company-invite-card">
        {state === "working" ? (
          <>
            <div className="ct">Accepting invitation…</div>
            <Skeleton h={40} />
          </>
        ) : state === "done" ? (
          <Empty title="You're in" text={message} action={<Button kind="p" onClick={() => router.push(orgSlug ? `/companies/${orgSlug}` : "/company")} data-testid="company-invite-continue">View the company page</Button>} />
        ) : (
          <Empty title="Couldn't accept that invitation" text={message} action={<Button kind="g" onClick={() => router.push("/company")}>Go to your companies</Button>} />
        )}
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <RequireAuth>
      <AppShell title="Company invitation">
        <AcceptInvite />
      </AppShell>
    </RequireAuth>
  );
}
