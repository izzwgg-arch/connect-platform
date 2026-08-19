import http from "http";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";

// ⛔ Fail CLOSED, never fall back to a literal. A `|| "change-me"` default (the
// value that shipped here) verifies WS tokens against a string that is public in
// this repo, so anyone could forge a token if JWT_SECRET were ever unset. Same
// class the api closed in eeec0002. This must be the SAME secret apps/api signs
// with (env_file), or every real token is rejected.
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error("FATAL: JWT_SECRET must be set and at least 32 chars. Refusing to start.");
  process.exit(1);
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const auth = req.headers.authorization || "";
  const queryToken = new URL(req.url || "/ws", "http://localhost").searchParams.get("token");
  const token = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || queryToken || "";
  try {
    jwt.verify(token, secret);
  } catch {
    socket.close(1008, "unauthorized");
    return;
  }

  socket.send(JSON.stringify({ type: "connected" }));
  socket.on("message", (msg) => socket.send(msg.toString()));
});

const port = Number(process.env.PORT || 3002);
server.listen(port, "0.0.0.0", () => console.log(`realtime listening on ${port}`));
