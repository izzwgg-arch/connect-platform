import { webkit } from "@playwright/test";
const b = await webkit.launch();
const p = await b.newPage();
p.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
p.on("requestfailed", (r) => console.log("[reqfail]", r.url(), r.failure()?.errorText));
p.on("response", (r) => { if (r.url().includes("3101")) console.log("[resp]", r.status(), r.url(), JSON.stringify(r.headers()["access-control-allow-origin"])); });
await p.goto("http://localhost:3100/login", { waitUntil: "networkidle" });
const out = await p.evaluate(async () => {
  const tries = [];
  for (const url of ["http://localhost:3101/public/stats", "http://127.0.0.1:3101/public/stats", "http://[::1]:3101/public/stats"]) {
    try { const r = await fetch(url); tries.push([url, r.status]); } catch (e) { tries.push([url, "ERR " + e.message]); }
  }
  return tries;
});
console.log(JSON.stringify(out));
await b.close();
