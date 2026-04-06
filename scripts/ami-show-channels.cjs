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
      console.log(JSON.stringify({
        channel: obj.Channel,
        callerIDNum: obj.CallerIDNum,
        callerIDName: obj.CallerIDName,
        connectedLineNum: obj.ConnectedLineNum,
        connectedLineName: obj.ConnectedLineName,
        exten: obj.Exten,
        context: obj.Context,
      }));
    }
    if (obj.Event === "CoreShowChannelsComplete" && !done) {
      done = true;
      sock.destroy();
      process.exit(0);
    }
  }
});
sock.write(`Action: Login\r\nUsername: ${USER}\r\nSecret: ${PASS}\r\n\r\n`);
setTimeout(() => process.exit(0), 8000);
