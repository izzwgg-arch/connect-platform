import type { Db } from "../db.js";

export type ProfileSignals = {
  objectives: string[];
  skills: string[];
  industry: string | null;
  followedOrgIndustries: string[];
  searchedTerms: string[];
  requestedServices: string[];
};

/**
 * The embeddings seam. If a future ranking model ever needs a vector, it is
 * built ONLY from the DECLARED signal bag returned here — things the person
 * explicitly told us (objectives, skills, industry) or explicitly did
 * (followed a company, typed a search, asked for a quote). It never touches
 * demographic inference (age, gender, ethnicity, income, or anything guessed
 * from behaviour rather than stated). This file makes no model call and
 * ranks nothing itself — it only assembles the bag a model would read.
 */
export async function buildProfileSignals(db: Db, personId: string): Promise<ProfileSignals> {
  const [profile, follows, searches, rfqs] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { objectives: true, skills: true, industry: true } }),
    db.follow.findMany({ where: { followerId: personId, organizationId: { not: null } }, select: { organization: { select: { industry: true } } } }),
    db.recentSearch.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: 25, select: { query: true } }),
    db.rfq.findMany({ where: { buyerPersonId: personId }, orderBy: { createdAt: "desc" }, take: 25, select: { title: true, requirements: true } }),
  ]);

  return {
    objectives: profile?.objectives ?? [],
    skills: profile?.skills ?? [],
    industry: profile?.industry ?? null,
    followedOrgIndustries: [...new Set(follows.map((f) => f.organization?.industry).filter((x): x is string => !!x))],
    searchedTerms: [...new Set(searches.map((s) => s.query))],
    requestedServices: [...new Set(rfqs.flatMap((r) => [r.title, ...r.requirements]))],
  };
}
