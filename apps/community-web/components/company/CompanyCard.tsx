"use client";

import Link from "next/link";
import { Avatar, Chip, VChip } from "@/components/ui";

export type OrgCard = {
  id: string;
  slug: string;
  displayName: string;
  logoAssetId: string | null;
  industry: string | null;
  size: string | null;
  location: string | null;
  followerCount: number;
  verified: string[];
  loopcomLinked: boolean;
};

const KIND_LABEL: Record<string, string> = { BUSINESS: "Business verified", DOMAIN: "Domain verified", INSURANCE: "Insured", LICENSE: "Licensed", LOOPCOM_CUSTOMER: "Loopcom customer" };

/** Compact organization card — the one shape every list of companies renders. */
export function CompanyCard({ org, action, testId }: { org: OrgCard; action?: React.ReactNode; testId?: string }) {
  return (
    <div className="li" data-testid={testId}>
      <Avatar name={org.displayName} assetId={org.logoAssetId} size={40} square />
      <div className="t">
        <Link href={`/companies/${org.slug}`}>
          <b>{org.displayName}</b>
        </Link>
        <small>{[org.industry, org.size ? `${org.size} employees` : null, org.location].filter(Boolean).join(" · ")}</small>
        {org.verified.length ? (
          <div className="pill-row" style={{ marginTop: 4 }}>
            {org.verified.slice(0, 2).map((k) => (
              <VChip key={k}>{KIND_LABEL[k] ?? k}</VChip>
            ))}
            {org.loopcomLinked ? <Chip kind="ac">Loopcom customer</Chip> : null}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
