const http = require("http");

function ari(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "209.145.60.79",
      port: 8088,
      path: "/ari" + path,
      auth: "connectcomms:8457823075Tty@",
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    r.on("error", reject);
    r.end();
  });
}

async function run() {
  const bridgesRaw = await ari("/bridges");
  const channelsRaw = await ari("/channels");

  const bridges = Array.isArray(bridgesRaw) ? bridgesRaw : [];
  const channels = Array.isArray(channelsRaw) ? channelsRaw : [];

  console.log("bridges:", bridges.length, "channels:", channels.length);

  const byId = new Map(channels.map((c) => [c.id, c]));

  for (const br of bridges) {
    console.log("\n--- bridge", br.id);
    for (const cid of (br.channels || [])) {
      const ch = byId.get(cid);
      if (!ch) { console.log("  channel", cid, ": NOT IN SNAPSHOT"); continue; }
      console.log("  name:", ch.name, "| state:", ch.state);
      console.log("  caller:", JSON.stringify(ch.caller));
      console.log("  connected:", JSON.stringify(ch.connected));
      console.log("  dialplan:", JSON.stringify(ch.dialplan));
    }
  }

  // Also show unbridged non-local channels
  const bridgedIds = new Set(bridges.flatMap((b) => b.channels || []));
  console.log("\n--- Unbridged non-local channels:");
  for (const ch of channels) {
    if (bridgedIds.has(ch.id)) continue;
    if ((ch.name || "").startsWith("Local/") || (ch.name || "").startsWith("Message/")) continue;
    if ((ch.state || "").toLowerCase() === "down") continue;
    console.log("  name:", ch.name, "| state:", ch.state);
    console.log("  caller:", JSON.stringify(ch.caller));
    console.log("  dialplan:", JSON.stringify(ch.dialplan));
  }
}
run().catch(console.error);
