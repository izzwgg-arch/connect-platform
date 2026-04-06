const http = require("http");
http.get("http://localhost:3001/internal/telephony/pbx-tenant-map", (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const d = JSON.parse(data);
    console.log("=== RAW FIRST ENTRY ===");
    console.log(JSON.stringify(d.entries && d.entries[0], null, 2));
    console.log("=== RAW FIRST DID ENTRY ===");
    console.log(JSON.stringify(d.didEntries && d.didEntries[0], null, 2));
  });
});
