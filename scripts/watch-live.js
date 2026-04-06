// Poll ARI every 500ms for 30 seconds to catch a live call
const http = require("http");
let found = false;
function ari(path, cb) {
  http.get({ host: "209.145.60.79", port: 8088, path: "/ari" + path, auth: "connectcomms:8457823075Tty@" }, (r) => {
    let d = "";
    r.on("data", (c) => { d += c; });
    r.on("end", () => { try { cb(JSON.parse(d)); } catch { cb([]); } });
  }).on("error", () => cb([]));
}
function check() {
  ari("/channels", (channels) => {
    const live = (Array.isArray(channels) ? channels : []).filter((c) =>
      !["Message/", "Local/"].some((p) => (c.name || "").startsWith(p)) &&
      (c.state || "").toLowerCase() !== "down"
    );
    if (live.length > 0) {
      found = true;
      live.forEach((c) => {
        console.log("FOUND CHANNEL:", c.name, "state:", c.state);
        console.log("  caller:", JSON.stringify(c.caller));
        console.log("  connected:", JSON.stringify(c.connected));
        console.log("  dialplan:", JSON.stringify(c.dialplan));
      });
      ari("/bridges", (bridges) => {
        const real = (Array.isArray(bridges) ? bridges : []).filter((b) => b.bridge_type !== "holding");
        console.log("Bridges:", real.length);
        real.forEach((b) => console.log("  bridge:", b.id, "channels:", b.channels));
        process.exit(0);
      });
    }
  });
}
console.log("Watching for live channels... make a call now");
const t = setInterval(check, 500);
setTimeout(() => { clearInterval(t); if (!found) console.log("No channels detected in 30s"); process.exit(0); }, 30000);
