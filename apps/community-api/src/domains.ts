import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";

/**
 * Domain registry. Each domain lives in src/<domain>/routes.ts and exports
 * `register<Domain>Routes(app, db)`. Add a line here when a domain lands;
 * `domains.test.ts` fails if a routes.ts exists that is not registered.
 */
export const registered: string[] = [];

export async function registerDomains(app: FastifyInstance, db: Db) {
  registered.length = 0;
  const mods: Array<[string, string]> = [
    ["profiles", "registerProfileRoutes"],
    ["organizations", "registerOrganizationRoutes"],
    ["graph", "registerGraphRoutes"],
    ["posts", "registerPostRoutes"],
    ["feed", "registerFeedRoutes"],
    ["messaging", "registerMessagingRoutes"],
    ["notifications", "registerNotificationRoutes"],
    ["search", "registerSearchRoutes"],
    ["media", "registerMediaRoutes"],
    ["groups", "registerGroupRoutes"],
    ["events", "registerEventRoutes"],
    ["jobs", "registerJobRoutes"],
    ["marketplace", "registerMarketplaceRoutes"],
    ["rfq", "registerRfqRoutes"],
    ["opportunities", "registerOpportunityRoutes"],
    ["intros", "registerIntroRoutes"],
    ["crm", "registerCrmRoutes"],
    ["recommendations", "registerRecommendationRoutes"],
    ["moderation", "registerModerationRoutes"],
    ["admin", "registerAdminRoutes"],
    ["verification", "registerVerificationRoutes"],
    ["concierge", "registerConciergeRoutes"],
  ];
  for (const [dir, fn] of mods) {
    let mod: Record<string, (app: FastifyInstance, db: Db) => void | Promise<void>> | null = null;
    try {
      mod = (await import(`./${dir}/routes.js`)) as any;
    } catch (err: any) {
      // A domain that does not exist yet is skipped so the api still boots mid-build;
      // domains.test.ts turns any missing domain into a failing test.
      if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/.test(String(err?.message))) continue;
      throw err;
    }
    const register = mod?.[fn];
    if (typeof register !== "function") throw new Error(`domain ${dir} does not export ${fn}`);
    await register(app, db);
    registered.push(dir);
  }
}
