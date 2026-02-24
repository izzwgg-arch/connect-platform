import http from "http";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";

const secret = process.env.JWT_SECRET || "change-me";
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
