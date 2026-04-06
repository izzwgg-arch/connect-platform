const http = require("http");
function get(path) {
  return new Promise((resolve) => {
    http.get({ host: "209.145.60.79", port: 8088, path, auth: "connectcomms:8457823075Tty@", headers: { accept: "application/json" } }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    }).on("error", () => resolve([]));
  });
}
async function main() {
  const [bridges, channels] = await Promise.all([get("/ari/bridges"), get("/ari/channels")]);
  const b = Array.isArray(bridges) ? bridges : [];
  const c = Array.isArray(channels) ? channels : [];
  console.log("BRIDGES:", b.length);
  b.forEach(br => console.log(" br:", br.id, br.bridge_type, "members:", (br.channels||[]).join(",")));
  console.log("\nALL CHANNELS:", c.length);
  c.forEach(ch => console.log(" CH:", ch.name, "| state:", ch.state, "| caller:", ch.caller&&ch.caller.number, "| connected:", ch.connected&&ch.connected.number, "| exten:", ch.dialplan&&ch.dialplan.exten));
}
main().catch(console.error);
