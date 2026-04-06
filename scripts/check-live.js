const http = require("http");
function ari(path, cb) {
  http.get({ host: "209.145.60.79", port: 8088, path: "/ari" + path, auth: "connectcomms:8457823075Tty@" }, (r) => {
    let d = "";
    r.on("data", (c) => { d += c; });
    r.on("end", () => { try { cb(JSON.parse(d)); } catch { cb([]); } });
  }).on("error", () => cb([]));
}
ari("/channels", (channels) => {
  const live = (Array.isArray(channels) ? channels : []).filter((c) =>
    !["Message/", "Local/"].some((p) => (c.name || "").startsWith(p)) &&
    (c.state || "").toLowerCase() !== "down"
  );
  console.log("Live non-helper channels:", live.length);
  live.forEach((c) => console.log(" ", c.name, c.state, "caller:", c.caller?.number, "connected:", c.connected?.number));
  ari("/bridges", (bridges) => {
    const real = (Array.isArray(bridges) ? bridges : []).filter((b) => b.bridge_type !== "holding");
    console.log("Real (non-holding) bridges:", real.length);
    real.forEach((b) => console.log(" ", b.id, "type:", b.bridge_type, "channels:", b.channels?.length));
  });
});
