import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type Database from "better-sqlite3";
import { isDeployService, openQueueDb, resetStaleRunning, type JobRow } from "./db.js";
import { startWorkerLoop } from "./worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function timingSafeEqualString(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function readTail(filePath: string, maxBytes: number): string | null {
  try {
    const st = fs.statSync(filePath);
    const start = st.size > maxBytes ? st.size - maxBytes : 0;
    const len = st.size - start;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function createApp(db: Database.Database, token: string) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  /** No token — for local process managers only; not a security boundary. */
  app.get("/health", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const want = (token || "").trim();
    if (!want) {
      res.status(503).json({ error: "deploy_queue_token_not_configured" });
      return;
    }
    const hdr =
      String(req.headers["x-deploy-queue-token"] || "").trim() ||
      (String(req.headers.authorization || "").startsWith("Bearer ")
        ? String(req.headers.authorization).slice(7).trim()
        : "");
    if (!hdr || !timingSafeEqualString(hdr, want)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.use(auth);

  app.get("/ops/deploy/jobs", (req, res) => {
    const status = String(req.query.status || "").trim();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    let sql = `SELECT id, service, branch, commit_hash, requested_by, status,
                      created_at, started_at, finished_at, log_path, error_message
               FROM jobs`;
    const args: string[] = [];
    if (status && /^[a-z]+$/.test(status)) {
      sql += ` WHERE status = ?`;
      args.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    args.push(String(limit));
    const rows = db.prepare(sql).all(...args) as JobRow[];
    res.json({ jobs: rows });
  });

  app.get("/ops/deploy/jobs/:id", (req, res) => {
    const row = db
      .prepare(
        `SELECT id, service, branch, commit_hash, requested_by, status,
                created_at, started_at, finished_at, log_path, error_message
         FROM jobs WHERE id = ?`,
      )
      .get(req.params.id) as JobRow | undefined;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let logTail: string | null = null;
    if (row.log_path && fs.existsSync(row.log_path)) {
      logTail = readTail(row.log_path, 64_000);
    }
    res.json({ job: row, logTail });
  });

  app.post("/ops/deploy/enqueue", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const service = String(body.service || "").trim();
    const branch = String(body.branch || "").trim();
    const commitHash = body.commitHash != null ? String(body.commitHash).trim() : "";
    const requestedBy = String(body.requestedBy || "unknown").trim().slice(0, 200);

    if (!isDeployService(service)) {
      res.status(400).json({ error: "invalid_service", allowed: ["api", "portal", "telephony", "realtime"] });
      return;
    }
    if (!branch || branch.length > 200) {
      res.status(400).json({ error: "branch_required" });
      return;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO jobs (id, service, branch, commit_hash, requested_by, status, created_at, started_at, finished_at, log_path, error_message)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL)`,
      ).run(
        id,
        service,
        branch,
        commitHash || null,
        requestedBy || "unknown",
        now,
      );
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        res.status(409).json({
          error: "duplicate_active_job_for_service",
          detail: "A queued or running job already exists for this service.",
        });
        return;
      }
      throw e;
    }
    const job = db
      .prepare(
        `SELECT id, service, branch, commit_hash, requested_by, status,
                created_at, started_at, finished_at, log_path, error_message
         FROM jobs WHERE id = ?`,
      )
      .get(id) as JobRow;
    res.status(201).json({ job });
  });

  app.post("/ops/deploy/jobs/:id/cancel", (req, res) => {
    const info = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(req.params.id) as
      | { status: string }
      | undefined;
    if (!info) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (info.status !== "queued") {
      res.status(409).json({ error: "not_cancellable", status: info.status });
      return;
    }
    db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ?, error_message = 'cancelled' WHERE id = ?`).run(
      Date.now(),
      req.params.id,
    );
    res.json({ ok: true, id: req.params.id });
  });

  return app;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

async function main() {
  const token = envStr("DEPLOY_QUEUE_TOKEN", "");
  if (!token) {
    console.error("DEPLOY_QUEUE_TOKEN is required");
    process.exit(2);
  }

  const repoRoot = envStr("DEPLOY_REPO_ROOT", "/opt/connectcomms/app");
  const stateDir = envStr("DEPLOY_QUEUE_STATE_DIR", path.join(repoRoot, "ops", "deploy-queue", "var"));
  const sqlitePath = envStr("DEPLOY_QUEUE_SQLITE_PATH", path.join(stateDir, "queue.db"));
  const logDir = envStr("DEPLOY_QUEUE_LOG_DIR", "/var/log/connect-deploys");
  const host = envStr("DEPLOY_QUEUE_BIND", "127.0.0.1");
  const port = Number(envStr("DEPLOY_QUEUE_PORT", "3910")) || 3910;
  const pollMs = Number(envStr("DEPLOY_QUEUE_POLL_MS", "3000")) || 3000;

  const db = openQueueDb(sqlitePath);
  resetStaleRunning(db, "worker restarted while job was running (marked failed)");

  const stopWorker = startWorkerLoop({ db, repoRoot, logDir, stateDir, pollMs });
  const app = createApp(db, token);
  const server = app.listen(port, host, () => {
    console.log(`[deploy-queue] listening http://${host}:${port} (repo=${repoRoot})`);
  });

  const shutdown = () => {
    stopWorker();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
