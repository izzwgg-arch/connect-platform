// Check ALL entries and what slugToConnectId would contain
const http = require("http");
http.get("http://localhost:3001/internal/telephony/pbx-tenant-map", (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const d = JSON.parse(data);
    console.log("=== ALL DIRECTORY ENTRIES ===");
    (d.entries || []).forEach((e) => {
      const hasDid = (d.didEntries || []).some(
        (did) => did.tenantCode === e.tenantCode || did.vitalTenantId === e.vitalTenantId
      );
      console.log(
        `code=${e.tenantCode} vitalId=${e.vitalTenantId} slug="${e.tenantSlug}" connectId=${e.connectTenantId} hasDid=${hasDid}`
      );
    });
    // Simulate the slug map build
    const nextDid = new Map();
    (d.didEntries || []).forEach((did) => nextDid.set(did.e164, did));
    const slugMap = {};
    for (const e of (d.entries || [])) {
      if (!e.tenantSlug) continue;
      let uuid = e.connectTenantId || null;
      if (!uuid) {
        const code = e.tenantCode?.trim().toUpperCase();
        const vid = e.vitalTenantId;
        for (const [, did] of nextDid) {
          if (!did.connectTenantId) continue;
          if (code && did.tenantCode?.trim().toUpperCase() === code) { uuid = did.connectTenantId; break; }
          if (vid && did.vitalTenantId === vid) { uuid = did.connectTenantId; break; }
        }
      }
      if (uuid) slugMap[e.tenantSlug.toLowerCase()] = uuid;
    }
    console.log("\n=== SLUG MAP (simulated) ===");
    Object.entries(slugMap).forEach(([slug, id]) => {
      const name = (d.didEntries || []).find((did) => did.connectTenantId === id)?.tenantName;
      console.log(`"${slug}" -> ${id} (${name})`);
    });
    console.log("\nSlugs with NO UUID mapping:");
    for (const e of (d.entries || [])) {
      if (!e.tenantSlug) continue;
      const slug = e.tenantSlug.toLowerCase();
      if (!slugMap[slug]) console.log(`  "${slug}" (code=${e.tenantCode}) -> UNRESOLVED`);
    }
  });
});
