// Query ARI for live bridge + channel data to diagnose why dialplanExten is empty
const http = require("http");

function ari(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "209.145.60.79",
      port: 8088,
      path: "/ari" + path,
      auth: "connectcomms:ConnectComms2025!",
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve(JSON.parse(d)));
    });
    r.on("error", reject);
    r.end();
  });
}

async function run() {
  const [bridges, channels] = await Promise.all([ari("/bridges"), ari("/channels")]);
  const byId = new Map(channels.map(c => [c.id, c]));

  console.log("=== Bridges ===");
  for (const br of bridges) {
    console.log("bridge:", br.id, "channels:", br.channels);
    for (const cid of (br.channels || [])) {
      const ch = byId.get(cid);
      if (!ch) { console.log("  channel", cid, ": NOT FOUND"); continue; }
      console.log("  channel:", ch.name, "state:", ch.state,
        "caller:", JSON.stringify(ch.caller),
        "connected:", JSON.stringify(ch.connected),
        "dialplan:", JSON.stringify(ch.dialplan));
    }
  }
}
run().catch(console.error);
