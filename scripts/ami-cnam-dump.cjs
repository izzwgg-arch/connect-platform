// Listen to AMI Newchannel events and show what CallerIDName arrives
const net = require("net");
const HOST = "209.145.60.79";
const PORT = 5038;
const USER = "connectcommsgefenu";

// Read password from env
const PASS = process.env.AMI_PASS || "";

const sock = net.connect(PORT, HOST);
let buf = "";
let authed = false;

sock.on("data", (d) => {
  buf += d.toString();
  const events = buf.split("\r\n\r\n");
  buf = events.pop();
  for (const raw of events) {
    if (!raw.trim()) continue;
    const obj = {};
    for (const line of raw.split("\r\n")) {
      const colon = line.indexOf(": ");
      if (colon > 0) obj[line.slice(0, colon)] = line.slice(colon + 2);
    }
    if (!authed) {
      if (obj.Response === "Success" && obj.Message === "Authentication accepted") {
        authed = true;
        console.log("AUTH OK — watching Newchannel events (30s)...");
      } else if (obj.Response) {
        console.log("AUTH:", JSON.stringify(obj));
      }
      continue;
    }
    if (obj.Event === "Newchannel") {
      console.log(JSON.stringify({
        channel: obj.Channel,
        callerIDNum: obj.CallerIDNum,
        callerIDName: obj.CallerIDName,
        connectedLineName: obj.ConnectedLineName,
        exten: obj.Exten,
        context: obj.Context,
      }));
    }
  }
});

sock.on("connect", () => {
  console.log("Connected to AMI");
});

const login = `Action: Login\r\nUsername: ${USER}\r\nSecret: ${PASS}\r\n\r\n`;
sock.write(login);

setTimeout(() => {
  console.log("Done");
  sock.destroy();
  process.exit(0);
}, 30000);
