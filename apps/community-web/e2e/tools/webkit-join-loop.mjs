// Fast-fingers regression: fill the join form WITHOUT waiting for hydration, 6 times.
import { webkit, devices } from "@playwright/test";
const b = await webkit.launch();
let fails = 0;
for (let i = 0; i < 6; i++) {
  const ctx = await b.newContext({ ...devices["iPhone 14"] });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3100/join");
  await p.getByTestId("join-first").fill("Web");
  await p.getByTestId("join-last").fill("Kit" + i);
  await p.getByTestId("join-email").fill(`wk-${Date.now()}-${i}@example.test`);
  await p.getByTestId("join-password").fill("E2e-strong-pass-42");
  await p.getByTestId("join-tos").check();
  await p.getByTestId("join-submit").click();
  await p.waitForURL(/\/welcome/, { timeout: 15000 }).catch(() => {});
  const ok = p.url().includes("/welcome");
  if (!ok) fails++;
  console.log(i, ok ? "ok" : "FAIL", p.url());
  await ctx.close();
}
console.log("fails", fails);
await b.close();
