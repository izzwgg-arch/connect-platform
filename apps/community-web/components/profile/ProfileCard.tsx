"use client";

import Link from "next/link";
import { Avatar, Chip } from "@/components/ui";

/** Matches `PersonCard` from apps/community-api/src/profiles/cards.ts. */
export type PersonCardData = {
  id: string;
  username: string;
  name: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  avatarAssetId: string | null;
  location: string | null;
  industry: string | null;
  verified: string[];
  primaryOrg: { id: string; slug: string; displayName: string } | null;
};

const VERIFICATION_LABELS: Record<string, string> = {
  PHONE: "Phone verified",
  EMAIL: "Email verified",
  IDENTITY: "Identity verified",
  BUSINESS: "Business verified",
  DOMAIN: "Domain verified",
  EMPLOYEE: "Employee verified",
  LICENSE: "License verified",
  INSURANCE: "Insurance on file",
  LOOPCOM_CUSTOMER: "Loopcom customer",
  TRANSACTION: "Verified transaction",
};

/** The one card every list of people renders (CONVENTIONS §"API shape"). */
export function ProfileCard({ person, action, dense }: { person: PersonCardData; action?: React.ReactNode; dense?: boolean }) {
  const sub = person.primaryOrg?.displayName ?? person.headline ?? person.location ?? "";
  return (
    <div className="li" data-testid={`profile-card-${person.username}`}>
      <Link href={`/people/${person.username}`}>
        <Avatar name={person.name} assetId={person.avatarAssetId} size={dense ? 34 : 44} />
      </Link>
      <div className="t">
        <Link href={`/people/${person.username}`} style={{ color: "inherit" }}>
          <b>{person.name}</b>
        </Link>
        {sub ? <small>{sub}</small> : null}
        {!dense && person.verified.length ? (
          <div className="pill-row" style={{ marginTop: 4 }}>
            {person.verified.slice(0, 2).map((k) => (
              <Chip key={k} kind="ok" icon="check">
                {VERIFICATION_LABELS[k] ?? k}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
