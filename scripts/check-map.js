const http = require("http");
const r = http.request({ host: "api", port: 3001, path: "/internal/telephony/pbx-tenant-map" }, (res) => {
  let d = "";
  res.on("data", (c) => { d += c; });
  res.on("end", () => {
    const j = JSON.parse(d);
    console.log("status:", res.statusCode);
    console.log("entries:", j.entries ? j.entries.length : "none");
    console.log("didEntries:", j.didEntries ? j.didEntries.length : "none");
    if (j.didEntries) {
      j.didEntries.forEach((d) => {
        console.log("  DID:", d.e164, "| connectId:", d.connectTenantId, "| name:", d.tenantName);
      });
    }
  });
});
r.on("error", (e) => console.error("err:", e.message));
r.end();
