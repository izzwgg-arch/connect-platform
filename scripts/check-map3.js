const http = require("http");
http.get("http://localhost:3001/internal/telephony/pbx-tenant-map", (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const d = JSON.parse(data);
    console.log("entries:", d.entries ? d.entries.length : 0);
    console.log("didEntries:", d.didEntries ? d.didEntries.length : 0);
    console.log("--- DID ENTRIES ---");
    (d.didEntries || []).forEach((e) =>
      console.log("DID:", e.e164, "| connectTenantId:", e.connectTenantId, "| tenantName:", e.tenantName)
    );
    console.log("--- ENTRIES (directory) ---");
    (d.entries || []).slice(0, 15).forEach((e) =>
      console.log("code:", e.tenantCode, "| connectId:", e.connectTenantId, "| name:", e.tenantName, "| slug:", e.slug)
    );
  });
});
