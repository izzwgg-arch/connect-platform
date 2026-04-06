// Fetch channel variables to find the original DID
const http = require("http");

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: "209.145.60.79", port: 8088,
      path, auth: "connectcomms:8457823075Tty@",
      headers: { accept: "application/json" },
    };
    http.get(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on("error", reject);
  });
}

async function getVar(channelId, varName) {
  try {
    const r = await get(`/ari/channels/${channelId}/variable?variable=${varName}`);
    return r && r.value !== undefined ? r.value : r;
  } catch { return "(error)"; }
}

async function main() {
  const channels = await get("/ari/channels");
  const chs = Array.isArray(channels) ? channels : [];
  const active = chs.filter((c) => c.state === "Up" && c.name && !c.name.startsWith("Message/"));

  console.log("Active channels:", active.length);
  for (const ch of active) {
    console.log("\nChannel:", ch.name, "(", ch.id, ")");
    const vars = ["CALLERID(dnid)", "CALLERID(num)", "ARG1", "EXTEN", "CDR(dst)", "CHANNEL(dnid)", "SIPDOMAIN", "DNID", "SIP_HEADER(To)", "PJSIP_HEADER(recv,To)"];
    for (const v of vars) {
      const val = await getVar(ch.id, v);
      if (val && val !== "" && val !== "(error)" && typeof val !== "object") {
        console.log(`  ${v} = "${val}"`);
      }
    }
  }
}

main().catch(console.error);
