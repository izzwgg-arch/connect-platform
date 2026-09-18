const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  const b = await p.brandingSettings.findFirst();
  console.log(JSON.stringify({ emailLogoUrl: b?.emailLogoUrl, webLogoUrl: b?.webLogoUrl }, null, 2));
  await p.$disconnect();
}
main().catch(e => { console.error(e.message); p.$disconnect(); });
