/**
 * Run inside the API container (from /app) to see which MySQL URL reaches VitalPBX Ombutel:
 *   docker cp scripts/ombu-mysql-probe.mjs app-api-1:/tmp/ombu-mysql-probe.mjs
 *   docker exec app-api-1 sh -c 'cd /app/apps/api && node /tmp/ombu-mysql-probe.mjs'
 */
import mysql from "mysql2/promise";

async function tryUrl(u) {
  try {
    const c = await mysql.createConnection({ uri: u, connectTimeout: 5000 });
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch (e) {
    console.error(String(e?.message || e));
    return false;
  }
}

const urls = [
  "mysql://root@127.0.0.1:3306/ombutel",
  "mysql://root@host.docker.internal:3306/ombutel",
  "mysql://root@172.17.0.1:3306/ombutel",
];

for (const u of urls) {
  console.log("try", u);
  if (await tryUrl(u)) {
    console.log("WIN", u);
    process.exit(0);
  }
}
console.log("ALL_FAIL");
process.exit(1);
