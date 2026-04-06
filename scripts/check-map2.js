const http = require("http");
const r = http.request({ host: "api", port: 3001, path: "/internal/telephony/pbx-tenant-map" }, (res) => {
  let d = "";
  res.on("data", (c) => { d += c; });
  res.on("end", () => {
    const j = JSON.parse(d);
    console.log("=== ENTRIES (pbxTenantDirectory) ===");
    if (j.entries) {
      j.entries.slice(0, 10).forEach((e) => {
        console.log("  vitalId:", e.vitalTenantId, "| code:", e.tenantCode, "| slug:", e.tenantSlug, "| connectId:", e.connectTenantId);
      });
    }
    console.log("\n=== DID REVERSE MAP TEST ===");
    // Simulate building the reverse map
    const rev = new Map();
    if (j.didEntries) {
      for (const d of j.didEntries) {
        if (!d.connectTenantId) continue;
        const list = rev.get(d.connectTenantId) || [];
        list.push(d.e164);
        rev.set(d.connectTenantId, list);
      }
    }
    // Check A plus center
    const aplusId = "cmnlgnumi0000p9g6l7t1t0z7";
    const gesheftId = "cmnlgnumu0001p9g6xyl1pbdd";
    console.log("A plus center DIDs:", rev.get(aplusId));
    console.log("Gesheft DIDs:", rev.get(gesheftId));

    console.log("\n=== RESOLVE T2 TEST ===");
    const match = (j.entries || []).find((e) => e.tenantCode === "T2" || e.vitalTenantId === "2");
    console.log("T2 entry:", match);
  });
});
r.on("error", (e) => console.error("err:", e.message));
r.end();
