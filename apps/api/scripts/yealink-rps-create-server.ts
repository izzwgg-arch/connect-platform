/**
 * One-off: create (or find) the Loopcom provisioning server record in Yealink RPS
 * and print its id — the value for YEALINK_RPS_SERVER_ID.
 * See docs/ai-context/AGENT_HANDOFF_YEALINK_MANAGED_PROVISIONING_2026-09-14.md §7.
 *
 * Usage (from apps/api):
 *   YEALINK_RPS_BASE_URL=https://<enterprise API domain from YMCS System > Integration > API>/ \
 *   YEALINK_RPS_ACCESS_KEY_ID=... YEALINK_RPS_ACCESS_KEY_SECRET=... \
 *   pnpm exec tsx scripts/yealink-rps-create-server.ts
 *
 * Optional: MANAGED_PHONE_PROVISIONING_BASE_URL (default https://app.loopcom.net/api/phone-provisioning/),
 *           YEALINK_RPS_SERVER_NAME (default "Loopcom").
 *
 * Idempotent: an existing server with the same name is looked up and reported,
 * never created twice; a name that exists with a DIFFERENT url is refused so a
 * mistyped url cannot silently repoint the fleet.
 */
import { YealinkRpsClient } from "../src/deskPhoneSetup/yealinkRps";

const NAME = process.env.YEALINK_RPS_SERVER_NAME || "Loopcom";
const URL_ = process.env.MANAGED_PHONE_PROVISIONING_BASE_URL || "https://app.loopcom.net/api/phone-provisioning/";

type ServerRow = { id: string; serverName: string; url?: string };
function rows(listed: unknown): ServerRow[] {
  if (Array.isArray(listed)) return listed as ServerRow[];
  const inner = (listed as { data?: unknown })?.data;
  return Array.isArray(inner) ? (inner as ServerRow[]) : [];
}

async function findByName(client: YealinkRpsClient, name: string): Promise<ServerRow | null> {
  for (let skip = 0; skip < 10_000; skip += 100) {
    const page = rows(await client.listServers({ key: name, skip, limit: 100 }));
    const found = page.find(s => s.serverName === name);
    if (found) return found;
    if (page.length < 100) return null;
  }
  return null;
}

async function main(): Promise<void> {
  const base = process.env.YEALINK_RPS_BASE_URL;
  const key = process.env.YEALINK_RPS_ACCESS_KEY_ID;
  const secret = process.env.YEALINK_RPS_ACCESS_KEY_SECRET;
  if (!base || !key || !secret) {
    console.error("Set YEALINK_RPS_BASE_URL, YEALINK_RPS_ACCESS_KEY_ID and YEALINK_RPS_ACCESS_KEY_SECRET.");
    process.exit(2);
  }
  const client = new YealinkRpsClient(base, key, secret);

  const existing = await findByName(client, NAME);
  if (existing) {
    if (existing.url && existing.url !== URL_) {
      console.error(`Server "${NAME}" already exists (id ${existing.id}) but points at ${existing.url}, not ${URL_}.`);
      console.error("Refusing to touch it. Fix it in YMCS, or pass a different YEALINK_RPS_SERVER_NAME.");
      process.exit(1);
    }
    console.log(`Server "${NAME}" already exists.`);
    console.log(`YEALINK_RPS_SERVER_ID=${existing.id}`);
    return;
  }

  await client.addServer({ serverName: NAME, url: URL_ });
  // An accepted write is not proof — read it back (same pattern as assign()).
  const created = await findByName(client, NAME);
  if (!created) {
    console.error("addServer was accepted but the server cannot be read back; check YMCS before retrying.");
    process.exit(1);
  }
  console.log(`Created server "${NAME}" -> ${URL_}`);
  console.log(`YEALINK_RPS_SERVER_ID=${created.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
