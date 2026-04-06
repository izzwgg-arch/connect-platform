const http = require("http");
function ari(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "209.145.60.79", port: 8088, path: "/ari" + path, auth: "connectcomms:8457823075Tty@" },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      }
    );
    r.on("error", reject);
    r.end();
  });
}
async function run() {
  const [bridges, channels] = await Promise.all([ari("/bridges"), ari("/channels")]);
  console.log("=== RAW BRIDGES ===");
  console.log(JSON.stringify(bridges, null, 2));
  console.log("=== RAW CHANNELS ===");
  console.log(JSON.stringify(channels, null, 2));
}
run().catch(console.error);
