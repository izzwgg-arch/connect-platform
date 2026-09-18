/** Mirrors apps/community-api's PersonCard/OrgCard response shapes. */
export type PersonCard = {
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
