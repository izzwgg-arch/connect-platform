// Verify the full resolution chain:
// T2 → UUID → DID (what a bridged inbound call to A plus center should see)
const http = require("http");
const r = http.request({ host: "api", port: 3001, path: "/internal/telephony/pbx-tenant-map" }, (res) => {
  let d = "";
  res.on("data", (c) => { d += c; });
  res.on("end", () => {
    const j = JSON.parse(d);

    // Simulate resolveConnectTenant with the DID fallback
    function resolveConnectTenant(code, vid) {
      // Primary: entries (all connectTenantId = null in current data)
      for (const e of (j.entries || [])) {
        if (code && e.tenantCode.toUpperCase() === code && e.connectTenantId) return e.connectTenantId;
        if (vid && e.vitalTenantId === vid && e.connectTenantId) return e.connectTenantId;
      }
      // Fallback: DID entries
      for (const d of (j.didEntries || [])) {
        if (!d.connectTenantId) continue;
        if (code && d.tenantCode && d.tenantCode.trim().toUpperCase() === code) return d.connectTenantId;
        if (vid && d.vitalTenantId === vid) return d.connectTenantId;
      }
      return null;
    }

    // Build reverse DID map
    const didsByConnectId = new Map();
    const didByE164 = new Map();
    for (const d of (j.didEntries || [])) {
      if (d.e164) didByE164.set(d.e164, d);
      if (d.connectTenantId) {
        const list = didsByConnectId.get(d.connectTenantId) || [];
        list.push(d.e164);
        didsByConnectId.set(d.connectTenantId, list);
      }
    }

    const testCases = [
      { label: "T2 (A plus center)", code: "T2", vid: "2" },
      { label: "T8 (Gesheft)", code: "T8", vid: "8" },
    ];

    for (const tc of testCases) {
      const uuid = resolveConnectTenant(tc.code, tc.vid);
      const dids = uuid ? (didsByConnectId.get(uuid) || []) : [];
      const tenantName = dids[0] ? didByE164.get(dids[0])?.tenantName : null;
      console.log(tc.label, "→ UUID:", uuid, "→ first DID:", dids[0] || "NONE", "→ name:", tenantName);
    }
  });
});
r.on("error", (e) => console.error("err:", e.message));
r.end();
