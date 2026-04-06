// Patch into the CallStateStore by running code in the same process context
// We do this by loading the running module and calling its exports
// This won't work for tsx watch - instead let's check via AMI channel variables

// Simpler: just check what callerIDName the AMI is showing for all active channels
const net = require("net");
const HOST = "209.145.60.79", PORT = 5038;
const USER = "connectcommsgefenu";
const PASS = process.env.AMI_PASS || "";
const sock = net.connect(PORT, HOST);
let buf = "", authed = false, done = false;

sock.on("data", (d) => {
  buf += d.toString();
  const events = buf.split("\r\n\r\n");
  buf = events.pop();
  for (const raw of events) {
    if (!raw.trim()) continue;
    const obj = {};
    for (const line of raw.split("\r\n")) {
      const c = line.indexOf(": ");
      if (c > 0) obj[line.slice(0, c)] = line.slice(c + 2);
    }
    if (!authed) {
      if (obj.Response === "Success" && obj.Message === "Authentication accepted") {
        authed = true;
        sock.write("Action: CoreShowChannels\r\n\r\n");
      }
      continue;
    }
    if (obj.Event === "CoreShowChannel") {
      // Print EVERYTHING about the channel so we can see callerIDName
      const name = obj.CallerIDName || "";
      const skip = ["<unknown>", ""].includes(name.toLowerCase()) || name.toLowerCase() === "unknown";
      console.log(JSON.stringify({
        channel: obj.Channel, linkedid: obj.Linkedid,
        callerIDNum: obj.CallerIDNum, callerIDName: name,
        connectedLineNum: obj.ConnectedLineNum, connectedLineName: obj.ConnectedLineName,
        exten: obj.Exten, context: obj.Context, channelState: obj.ChannelStateDesc,
        hasCnam: !skip,
      }));
    }
    if (obj.Event === "CoreShowChannelsComplete" && !done) {
      done = true;
      console.log("\n--- Done ---");
      sock.destroy();
      process.exit(0);
    }
  }
});
sock.write(`Action: Login\r\nUsername: ${USER}\r\nSecret: ${PASS}\r\n\r\n`);
setTimeout(() => process.exit(0), 8000);
