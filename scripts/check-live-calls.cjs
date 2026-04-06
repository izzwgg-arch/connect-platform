const ws = require("ws");
const w = new ws.WebSocket("ws://localhost:3003/ws/telephony");
const token = process.argv[2] || "";
w.on("open", () => {
  if (token) w.send(JSON.stringify({ type: "auth", token }));
});
w.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "telephony.snapshot") {
    const calls = msg.data?.calls || [];
    console.log("LIVE CALLS:", JSON.stringify(calls.map(c => ({
      id: c.id, from: c.from, fromName: c.fromName, to: c.to, tenantName: c.tenantName, state: c.state
    })), null, 2));
    w.close();
  }
});
w.on("error", e => { console.error(e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); w.close(); }, 5000);
