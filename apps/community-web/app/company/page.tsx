"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";
import { Button, Chip, Empty, Skeleton } from "@/components/ui";
import { CompanyCard, type OrgCard } from "@/components/company/CompanyCard";

type MyOrg = OrgCard & { role: string; permissions: string[]; affiliation: string; isPrimary: boolean };

function CompanyList() {
  const { me } = useAuth();
  const [orgs, setOrgs] = useState<MyOrg[] | null>(null);

  useEffect(() => {
    api<{ organizations: MyOrg[] }>("/me/organizations").then((r) => setOrgs(r.organizations));
  }, []);

  return (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ fontSize: 18 }}>Your companies</h2>
          <div className="row">
            {me?.person.loopcomLinked ? (
              <Button kind="g" icon="link" href="/company/new?claim=1" data-testid="company-claim-loopcom">
                Claim from Loopcom
              </Button>
            ) : null}
            <Button kind="p" icon="plus" href="/company/new" data-testid="company-create">
              Create a company page
            </Button>
          </div>
        </div>
        {orgs === null ? (
          <Skeleton h={64} />
        ) : orgs.length === 0 ? (
          <Empty title="No company pages yet" text="Create one to post as your business, list your catalog, and accept RFQs." action={<Button kind="p" href="/company/new">Create a company page</Button>} />
        ) : (
          <div className="list">
            {orgs.map((o) => (
              <CompanyCard
                key={o.id}
                org={o}
                testId={`company-row-${o.slug}`}
                action={
                  <div className="row">
                    <Chip kind={o.role === "OWNER" ? "ac" : ""}>{o.role}</Chip>
                    {o.isPrimary ? <Chip kind="sel">Primary</Chip> : null}
                    <Link className="btn s" href="/company/admin" data-testid={`company-manage-${o.slug}`}>
                      Manage
                    </Link>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyCompaniesPage() {
  return (
    <RequireAuth>
      <AppShell title="Company pages">
        <CompanyList />
      </AppShell>
    </RequireAuth>
  );
}
