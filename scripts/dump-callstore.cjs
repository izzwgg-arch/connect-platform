// Dump CallStateStore active calls by patching into the running process
// We do this by temporarily adding a debug endpoint to the telephony service
// Instead: just subscribe to the WS and get the snapshot directly
const http = require("http");
const net = require("net");

// Parse WebSocket handshake manually (no ws library needed)
const key = Buffer.from(Date.now().toString()).toString("base64");
const req = [
  "GET /ws/telephony HTTP/1.1",
  "Host: localhost:3003",
  "Upgrade: websocket",
  "Connection: Upgrade",
  `Sec-WebSocket-Key: ${key}`,
  "Sec-WebSocket-Version: 13",
  "",
  "",
].join("\r\n");

const sock = net.connect(3003, "localhost");
let buf = Buffer.alloc(0);
let handshakeDone = false;

sock.on("connect", () => sock.write(req));
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (!handshakeDone) {
    const hdr = buf.toString();
    if (hdr.includes("\r\n\r\n")) {
      handshakeDone = true;
      const hdrEnd = buf.indexOf("\r\n\r\n") + 4;
      buf = buf.slice(hdrEnd);
      if (buf.length > 0) processFrames();
    }
    return;
  }
  processFrames();
});

function processFrames() {
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const opcode = b0 & 0x0f;
    let payloadLen = b1 & 0x7f;
    let offset = 2;
    if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
    else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (buf.length < offset + payloadLen) break;
    const payload = buf.slice(offset, offset + payloadLen);
    buf = buf.slice(offset + payloadLen);
    if (opcode === 1) { // text frame
      try {
        const msg = JSON.parse(payload.toString());
        if (msg.event === "telephony.snapshot") {
          const calls = msg.data?.calls || [];
          console.log("ACTIVE CALLS IN SNAPSHOT:", calls.length);
          calls.forEach(c => console.log(JSON.stringify({
            id: c.id, state: c.state, from: c.from, fromName: c.fromName,
            to: c.to, tenantName: c.tenantName, channels: c.channels
          })));
          sock.destroy();
          process.exit(0);
        }
      } catch(e) {}
    }
  }
}

setTimeout(() => {
  console.log("timeout - no snapshot received");
  sock.destroy();
  process.exit(0);
}, 8000);
