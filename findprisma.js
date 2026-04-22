try {
  const p = require.resolve('@prisma/client', { paths: ['/app/packages/db'] });
  console.log("RESOLVED:", p);
} catch(e) {
  console.error("RESOLVE_ERR:", e.message);
}
