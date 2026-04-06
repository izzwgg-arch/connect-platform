const http = require("http");

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: "209.145.60.79",
      port: 8088,
      path,
      auth: "connectcomms:8457823075Tty@",
      headers: { accept: "application/json" },
    };
    http.get(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    }).on("error", reject);
  });
}

async function main() {
  const bridgesRaw = await get("/ari/bridges");
  const channelsRaw = await get("/ari/channels");
  const bridges = Array.isArray(bridgesRaw) ? bridgesRaw : [];
  const channels = Array.isArray(channelsRaw) ? channelsRaw : [];

  const byId = {};
  for (const ch of channels) byId[ch.id] = ch;

  console.log("=== ALL BRIDGES (" + bridges.length + ") ===");
  for (const br of bridges) {
    const mids = br.channels || [];
    console.log("\nBRIDGE:", br.id, "type:", br.bridge_type, "members:", mids.length);
    for (const mid of mids) {
      const ch = byId[mid];
      if (!ch) { console.log("  [missing channel]", mid); continue; }
      console.log("  CH:", ch.name, "state:", ch.state);
      console.log("    caller.number:", ch.caller && ch.caller.number);
      console.log("    connected.number:", ch.connected && ch.connected.number);
      console.log("    dialplan.context:", ch.dialplan && ch.dialplan.context);
      console.log("    dialplan.exten:", ch.dialplan && ch.dialplan.exten);
    }
  }

  console.log("\n=== ALL CHANNELS (" + channels.length + ") ===");
  for (const ch of channels) {
    console.log(ch.name, "| state:", ch.state, "| caller:", ch.caller && ch.caller.number, "| connected:", ch.connected && ch.connected.number, "| exten:", ch.dialplan && ch.dialplan.exten, "| context:", ch.dialplan && ch.dialplan.context);
  }
}

main().catch(console.error);
