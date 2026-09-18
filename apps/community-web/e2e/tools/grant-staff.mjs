// Grants (or revokes) platform staff to a test person, directly via Prisma, the
// way the API's own test harness does it (src/testing/harness.ts grantStaff()).
// Used by e2e/helpers.ts's `staff()` helper — there is no UI/API path to grant
// staff, it is a fixture concern, so tests go straight to the database exactly
// as the task brief describes ("insert a StaffGrant row").
//
// Usage: node e2e/tools/grant-staff.mjs <email> [role]   role defaults to ADMIN
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, "../../../community-api");

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.join(apiDir, ".env"));

const clientUrl = pathToFileURL(path.join(apiDir, "node_modules/.prisma/community-client/index.js")).href;
const { PrismaClient } = await import(clientUrl);
const db = new PrismaClient();

const [email, role = "ADMIN"] = process.argv.slice(2);
if (!email) {
  console.error("usage: grant-staff.mjs <email> [role]");
  process.exit(1);
}

const person = await db.person.findUnique({ where: { email } });
if (!person) {
  console.error(`no person with email ${email}`);
  await db.$disconnect();
  process.exit(1);
}

await db.staffGrant.upsert({
  where: { personId: person.id },
  create: { personId: person.id, role },
  update: { role },
});

console.log(JSON.stringify({ personId: person.id, role }));
await db.$disconnect();
