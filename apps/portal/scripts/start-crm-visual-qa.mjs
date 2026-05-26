import { spawn } from "node:child_process";

const port = process.env.PORT || process.env.CRM_VISUAL_QA_PORT || "3006";

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "next", "dev", "-p", port],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      NEXT_PUBLIC_CRM_VISUAL_QA: "1",
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

