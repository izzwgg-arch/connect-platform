// Fix: WSS URL was set to bare IP (wss://209.145.60.79:8089/ws).
// Browsers reject this because the TLS cert is issued for the domain, not the IP.
// Correct URL: wss://m.connectcomunications.com:8089/ws
import { db } from "@connect/db";

const OLD_WS_URL = "wss://209.145.60.79:8089/ws";
const NEW_WS_URL = "wss://m.connectcomunications.com:8089/ws";

async function main() {
  const result = await db.tenant.updateMany({
    where: { sipWsUrl: OLD_WS_URL },
    data: { sipWsUrl: NEW_WS_URL }
  });
  console.log(`Updated ${result.count} tenants: sipWsUrl → ${NEW_WS_URL}`);

  // Verify A plus center
  const t = await db.tenant.findFirst({ where: { name: { contains: "plus" } } });
  console.log("\nA plus center:");
  console.log("  sipWsUrl:", t?.sipWsUrl);
  console.log("  sipDomain:", t?.sipDomain);
  console.log("  webrtcEnabled:", t?.webrtcEnabled);
}
main().catch(console.error).finally(() => db.$disconnect());
