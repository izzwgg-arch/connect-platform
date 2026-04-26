import fs from "node:fs";
import path from "node:path";

/** Best-effort cross-process lock so two workers do not run deploy scripts concurrently. */
export class WorkerLock {
  private readonly lockPath: string;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(stateDir: string) {
    this.lockPath = path.join(stateDir, "worker.lock");
  }

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const payload = `${process.pid}\n${Date.now()}\n`;
    try {
      fs.writeFileSync(this.lockPath, payload, { flag: "wx" });
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      if (this.tryReclaimStale()) {
        fs.writeFileSync(this.lockPath, payload, { flag: "wx" });
      } else {
        throw new Error(`Another deploy worker holds ${this.lockPath} (PID file present and fresh)`);
      }
    }
    this.interval = setInterval(() => {
      try {
        fs.utimesSync(this.lockPath, new Date(), new Date());
      } catch {
        /* ignore */
      }
    }, 15_000);
  }

  /** If lock file references a dead PID or is older than staleMs, remove it. */
  private tryReclaimStale(staleMs = 120_000): boolean {
    try {
      const raw = fs.readFileSync(this.lockPath, "utf8").trim().split("\n");
      const pid = Number(raw[0]);
      const ts = Number(raw[1]);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          /* process dead */
        }
      }
      if (Number.isFinite(ts) && Date.now() - ts < staleMs) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      try {
        fs.unlinkSync(this.lockPath);
        return true;
      } catch {
        return false;
      }
    }
  }

  release(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* noop */
    }
  }
}
