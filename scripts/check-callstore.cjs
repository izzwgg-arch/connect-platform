// Check what the CallStateStore currently has - look at the telephony health endpoint
const http = require("http");
http.get("http://localhost:3003/health", (res) => {
  let d = "";
  res.on("data", c => d += c);
  res.on("end", () => console.log(d));
}).on("error", e => console.error(e.message));
