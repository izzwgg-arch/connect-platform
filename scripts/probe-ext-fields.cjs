process.chdir("/app/apps/api");
const { db } = require("@connect/db");
const { decryptJson } = require("@connect/security");

db.pbxInstance.findFirst({ where: { isEnabled: true } }).then(function(inst) {
  if (!inst) { console.log("NO_INSTANCE"); process.exit(0); }
  var auth = decryptJson(inst.apiAuthEncrypted);
  var token = auth.token || auth.apiKey || auth.key || auth.access_token || "";
  return db.pbxTenantDirectory.findFirst({ where: { pbxInstanceId: inst.id } }).then(function(td) {
    if (!td) { console.log("NO_TENANT_DIR"); process.exit(0); }
    var url = inst.baseUrl + "/api/v2/extensions";
    console.log("URL:", url, "vitalTenantId:", td.vitalTenantId);
    return fetch(url, {
      headers: {
        "Authorization": "Bearer " + token,
        "X-Tenant": String(td.vitalTenantId),
        "Accept": "application/json",
      },
    }).then(function(r) {
      return r.json();
    }).then(function(json) {
      var rows = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
      console.log("Total rows:", rows.length);
      rows.slice(0, 2).forEach(function(row) {
        console.log("FIELDS:", Object.keys(row).join(", "));
        console.log("SAMPLE:", JSON.stringify(row));
        console.log("---");
      });
      process.exit(0);
    });
  });
}).catch(function(e) { console.error("ERR:", e.message); process.exit(1); });
